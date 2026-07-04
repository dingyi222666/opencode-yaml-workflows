import { tool } from "@opencode-ai/plugin"
import { discoverWorkflows } from "./discovery.js"
import { parseWorkflowYaml } from "./parser.js"
import { loadRun, saveWorkflow } from "./persistence.js"
import { cancelWorkflow, runWorkflow, statusWorkflow } from "./runner.js"
import { WORKFLOW_SCHEMA_TEXT } from "./schema.js"
import type { RuntimeContext, ToolRuntimeContext, Workflow } from "./types.js"
import type { createOpencodeClient } from "@opencode-ai/sdk"

type SDKSession = ReturnType<typeof createOpencodeClient>["session"]
type SessionCreateInput = NonNullable<Parameters<SDKSession["create"]>[0]>
type SessionMessagesInput = Parameters<SDKSession["messages"]>[0]
type SessionPromptInput = Parameters<SDKSession["prompt"]>[0]
type SessionPromptBody = NonNullable<SessionPromptInput["body"]>

const z = tool.schema

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
                .map(({ workflow, path, scope }) => `- ${workflow.id} (${scope}) ${workflow.name}: ${workflow.description}\n  ${path}`)
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
  if (run.async && run.status === "queued") return `Started async workflow run ${run.id}.`
  if (run.status === "failed") {
    const logs = run.logs?.length ? `\n\nWorkflow logs:\n${run.logs.slice(-30).join("\n")}` : ""
    return `Workflow ${run.id} failed.\n\n${run.error ?? "No error details."}${logs}`
  }
  return run.result || `Workflow ${run.status}.`
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
  const model = args.model ? parseModel(args.model) : undefined
  const createInput: SessionCreateInput = { body: { parentID: context.sessionID, title: "workflow:generate" }, query: context.directory ? { directory: context.directory } : undefined }
  const session = await runtime.client.session.create(createInput)
  const sessionID = extractSessionID(session)
  if (!sessionID) throw new Error("Failed to create workflow generation child session")
  const prompt = `Create a valid YAML workflow for this goal. Return only YAML. Goal: ${args.goal}\nSkills: ${(args.skills ?? []).join(", ")}\n\n${WORKFLOW_SCHEMA_TEXT}`
  const promptBody: SessionPromptBody = { parts: [{ type: "text", text: prompt }] }
  if (args.agent) promptBody.agent = args.agent
  if (model) promptBody.model = model
  if (args.tools) promptBody.tools = args.tools
  const promptInput: SessionPromptInput = { path: { id: sessionID }, body: promptBody, query: context.directory ? { directory: context.directory } : undefined }
  const result = await (runtime.client.session.prompt?.(promptInput) ?? Promise.resolve(undefined))
  await runtime.client.session.wait?.({ sessionID }).catch(() => undefined)
  const messagesInput: SessionMessagesInput = { path: { id: sessionID }, query: context.directory ? { directory: context.directory } : undefined }
  const text = extractText(await runtime.client.session.messages?.(messagesInput).catch(() => undefined)) || extractText(result) || ""
  const yaml = stripFences(text)
  const workflow = parseWorkflowYaml(yaml)
  if (args.saveAs) await saveWorkflow({ worktree: context.worktree, workflow, location: "project", saveAs: args.saveAs })
  return { title: `Generated ${workflow.id}`, output: yaml, metadata: { workflowID: workflow.id, sessionID } }
}

function parseModel(input: string) {
  const [providerID, ...rest] = input.split("/")
  const modelID = rest.join("/")
  return providerID && modelID ? { providerID, modelID } : undefined
}

function extractSessionID(input: unknown): string | undefined {
  const data = unwrapData(input)
  return isRecord(data) && typeof data.id === "string" ? data.id : undefined
}

function extractText(input: unknown): string | undefined {
  const data = unwrapData(input)
  if (typeof data === "string") return data
  if (Array.isArray(data)) return data.map(extractText).filter(Boolean).join("\n")
  if (!isRecord(data)) return undefined
  if (typeof data.text === "string") return data.text
  if (typeof data.content === "string") return data.content
  if (Array.isArray(data.parts)) return data.parts.map(extractText).filter(Boolean).join("\n")
  return undefined
}

function stripFences(input: string) {
  return input.replace(/^```(?:yaml|yml)?\s*/i, "").replace(/```\s*$/i, "").trim()
}

function unwrapData(input: unknown): unknown {
  return isRecord(input) && "data" in input ? input.data : input
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null
}
