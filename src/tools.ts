import { tool } from "@opencode-ai/plugin"
import { discoverWorkflows } from "./discovery.js"
import { parseWorkflowYaml } from "./parser.js"
import { loadRun, saveWorkflow } from "./persistence.js"
import { cancelWorkflow, runWorkflow, statusWorkflow } from "./runner.js"
import { WORKFLOW_SCHEMA_TEXT } from "./schema.js"
import { responseData, responseLastAssistantText, responsePromptText, responseSessionID, responseSessionModel } from "./sdk-response.js"
import type { RuntimeContext, ToolRuntimeContext, Workflow } from "./types.js"
import type { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { PermissionRule } from "@opencode-ai/sdk/v2/client"

type SDKSession = ReturnType<typeof createOpencodeClient>["session"]
type SessionCreateInput = NonNullable<Parameters<SDKSession["create"]>[0]>
type SessionMessagesInput = Parameters<SDKSession["messages"]>[0]
type SessionPromptInput = Parameters<SDKSession["prompt"]>[0]
type SessionGetInput = Parameters<SDKSession["get"]>[0]
type SessionPromptModel = NonNullable<SessionPromptInput["model"]>

const z = tool.schema
const CHILD_TOOL_DENIES: PermissionRule[] = [
  { permission: "workflow", pattern: "*", action: "deny" },
  { permission: "task", pattern: "*", action: "deny" },
]
const CHILD_DISABLED_TOOLS = { workflow: false, task: false } as const

export function createWorkflowTools(runtime: RuntimeContext) {
  return {
    workflow: tool({
      description:
        "Manage YAML workflows. Use action=schema, list, run, generate, save, status, resume, or cancel. Runs default to async child sessions attached to the current session.",
      args: {
        action: z.enum(["schema", "list", "run", "generate", "save", "status", "resume", "cancel"]),
        workflowID: z.string().optional(),
        yaml: z.string().optional(),
        inputs: z.record(z.string(), z.any()).optional(),
        async: z.boolean().optional(),
        goal: z.string().optional(),
        agent: z.string().optional(),
        model: z.string().optional(),
        skills: z.array(z.string()).optional(),
        tools: z.record(z.string(), z.boolean()).optional(),
        saveAs: z.string().optional(),
        location: z.enum(["opencode", "project"]).optional(),
        runID: z.string().optional(),
      },
      execute: async (args, context) => {
        switch (args.action) {
          case "schema":
            return WORKFLOW_SCHEMA_TEXT
          case "list": {
            const registry = await discoverWorkflows(context)
            return (
              registry.workflows
                .map(({ workflow, path, scope }) => `- ${workflow.id} (${scope}) ${workflow.name}: ${workflow.description}\n  ${path}\n${formatWorkflowInputs(workflow)
                  .split("\n")
                  .map((line) => `  ${line}`)
                  .join("\n")}`)
                .join("\n") || "No workflows found."
            )
          }
          case "run": {
            const workflow = await resolveWorkflow(runtime, context, args.workflowID, args.yaml)
            const run = await runWorkflow({ runtime, tool: context, workflow, inputs: args.inputs ?? {}, async: args.async })
            return {
              title: `Workflow ${run.id}`,
              output: formatRunOutput(run),
              metadata: run,
            }
          }
          case "generate": {
            if (!args.goal) throw new Error("workflow action=generate requires goal")
            return generateWorkflow(runtime, context, {
              goal: args.goal,
              agent: args.agent,
              model: args.model,
              skills: args.skills,
              tools: args.tools,
              saveAs: args.saveAs,
            })
          }
          case "save": {
            if (!args.yaml) throw new Error("workflow action=save requires yaml")
            const workflow = parseWorkflowYaml(args.yaml)
            workflow.provenance = { ...(workflow.provenance ?? {}), creatorSessionID: context.sessionID }
            const path = await saveWorkflow({ worktree: context.worktree, workflow, location: args.location ?? "project", saveAs: args.saveAs })
            return `Saved workflow ${args.saveAs ?? workflow.id} to ${path}`
          }
          case "status": {
            if (!args.runID) throw new Error("workflow action=status requires runID")
            return JSON.stringify(await statusWorkflow(context.worktree, args.runID), null, 2)
          }
          case "resume": {
            if (!args.runID) throw new Error("workflow action=resume requires runID")
            const run = await loadRun(context.worktree, args.runID)
            return `Run ${run.id} is ${run.status}. Full durable resume will continue incomplete persisted runs in a later compatibility pass.`
          }
          case "cancel": {
            if (!args.runID) throw new Error("workflow action=cancel requires runID")
            return JSON.stringify(await cancelWorkflow({ ...runtime, worktree: context.worktree, directory: context.directory }, args.runID), null, 2)
          }
        }
      },
    }),
  }
}

function formatRunOutput(run: { id: string; async: boolean; status: string; result?: string; error?: string; logs?: string[] }) {
  if (run.async && run.status === "queued") {
    return [
      `Started async workflow run ${run.id}.`,
      "Do not repeatedly call workflow action=status or poll for completion.",
      "The workflow runs in the background and will automatically wake this parent session with task-like notifications and a final summary.",
    ].join("\n")
  }
  if (run.status === "failed") {
    const logs = run.logs?.length ? `\n\nWorkflow logs:\n${run.logs.slice(-30).join("\n")}` : ""
    return `Workflow ${run.id} failed.\n\n${run.error ?? "No error details."}${logs}`
  }
  return run.result || `Workflow ${run.status}.`
}

function formatWorkflowInputs(workflow: Workflow) {
  const entries = Object.entries(workflow.inputs)
  if (entries.length === 0) return "Inputs: none"
  return [
    "Inputs:",
    ...entries.map(([name, definition]) => {
      const required = definition.required ? "required" : "optional"
      const type = definition.type ?? "string"
      const defaultText = definition.default === undefined ? "" : `; default=${JSON.stringify(definition.default)}`
      const description = definition.description ? `; ${definition.description}` : ""
      return `- ${name}: ${type}, ${required}${defaultText}${description}`
    }),
  ].join("\n")
}

async function resolveWorkflow(runtime: RuntimeContext, context: ToolRuntimeContext, workflowID?: string, yaml?: string): Promise<Workflow> {
  if (yaml) return parseWorkflowYaml(yaml)
  if (!workflowID) throw new Error("workflow action=run requires workflowID or yaml")
  const registry = await discoverWorkflows({ worktree: context.worktree || runtime.worktree, directory: context.directory || runtime.directory })
  const source = registry.byID.get(workflowID)
  if (!source) throw new Error(`Workflow not found: ${workflowID}`)
  return source.workflow
}

async function generateWorkflow(runtime: RuntimeContext, context: ToolRuntimeContext, args: { goal: string; agent?: string; model?: string; skills?: string[]; tools?: Record<string, boolean>; saveAs?: string }) {
  if (!context.sessionID) throw new Error("workflow_generate requires a current parent sessionID")
  const model = await resolvePromptModel(runtime, context.sessionID, context.directory, args.model, args.agent)
  const createInput: SessionCreateInput = { parentID: context.sessionID, title: "workflow:generate", directory: context.directory, permission: CHILD_TOOL_DENIES }
  const session = await runtime.client.session.create(createInput)
  const sessionID = responseSessionID(session)
  if (!sessionID) throw new Error("Failed to create workflow generation child session")
  const prompt = `Create a valid YAML workflow for this goal. Return only YAML. Goal: ${args.goal}\nSkills: ${(args.skills ?? []).join(", ")}\n\n${WORKFLOW_SCHEMA_TEXT}`
  const promptInput: SessionPromptInput = { sessionID, directory: context.directory, parts: [{ type: "text", text: prompt }] }
  if (args.agent) promptInput.agent = args.agent
  if (model) promptInput.model = model
  promptInput.tools = { ...(args.tools ?? {}), ...CHILD_DISABLED_TOOLS }
  const result = await (runtime.client.session.prompt?.(promptInput) ?? Promise.resolve(undefined))
  await runtime.client.v2.session.wait({ sessionID, directory: context.directory }).catch(() => undefined)
  const messagesInput: SessionMessagesInput = { sessionID, directory: context.directory }
  const text = responseLastAssistantText(await runtime.client.session.messages?.(messagesInput).catch(() => undefined)) || responsePromptText(result) || ""
  const yaml = stripFences(text)
  const workflow = parseWorkflowYaml(yaml)
  if (args.saveAs) await saveWorkflow({ worktree: context.worktree, workflow, location: "project", saveAs: args.saveAs })
  return { title: `Generated ${workflow.id}`, output: yaml, metadata: { workflowID: workflow.id, sessionID } }
}

async function resolvePromptModel(runtime: RuntimeContext, parentSessionID: string, directory: string, explicitModel?: string, agent?: string): Promise<SessionPromptModel | undefined> {
  const parsed = explicitModel ? parseModel(explicitModel) : undefined
  if (parsed) return parsed
  const agentModel = agent ? await resolveAgentModel(runtime, directory, agent) : undefined
  if (agentModel) return agentModel
  return resolveParentSessionModel(runtime, parentSessionID, directory)
}

async function resolveAgentModel(runtime: RuntimeContext, directory: string, agent: string): Promise<SessionPromptModel | undefined> {
  const agents = await runtime.client.app.agents({ directory }).catch(() => undefined)
  const list = responseData(agents) ?? []
  return list.find((item) => item.name === agent)?.model
}

async function resolveParentSessionModel(runtime: RuntimeContext, parentSessionID: string, directory: string): Promise<SessionPromptModel | undefined> {
  const getSession = runtime.client.session.get?.bind(runtime.client.session)
  if (!getSession) return undefined
  const input: SessionGetInput = { sessionID: parentSessionID, directory }
  const result = await getSession(input).catch(() => undefined)
  return responseSessionModel(result)
}

function parseModel(input: string): SessionPromptModel | undefined {
  const [providerID, ...rest] = input.split("/")
  const modelID = rest.join("/")
  return providerID && modelID ? { providerID, modelID } : undefined
}

function stripFences(input: string) {
  return input.replace(/^```(?:yaml|yml)?\s*/i, "").replace(/```\s*$/i, "").trim()
}
