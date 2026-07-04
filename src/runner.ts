import { createRunID, loadRun, saveRun } from "./persistence.js"
import { renderTemplate, resolveStepSettings } from "./parser.js"
import type { RuntimeContext, ToolRuntimeContext, Workflow, WorkflowRun, WorkflowStep } from "./types.js"

const activeRuns = new Map<string, { cancelled: boolean }>()

export async function runWorkflow(input: {
  runtime: RuntimeContext
  tool: ToolRuntimeContext
  workflow: Workflow
  inputs: Record<string, unknown>
  async?: boolean
}) {
  if (!input.tool.sessionID) throw new Error("workflow_run requires a current parent sessionID")
  const run: WorkflowRun = {
    id: createRunID(),
    workflowID: input.workflow.id,
    parentSessionID: input.tool.sessionID,
    status: "queued",
    async: input.async ?? input.workflow.defaults.async ?? true,
    inputs: input.inputs,
    childSessions: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await saveRun(input.runtime.worktree, run)
  const token = { cancelled: false }
  activeRuns.set(run.id, token)

  const execute = async () => {
    try {
      run.status = "running"
      await saveRun(input.runtime.worktree, run)
      const state: Record<string, { output?: string }> = {}
      for (const step of input.workflow.steps) await executeStep(input.runtime, input.tool, input.workflow, run, step, state, token)
      run.status = token.cancelled ? "cancelled" : "completed"
      run.result = Object.entries(state)
        .map(([id, value]) => `## ${id}\n${value.output ?? ""}`)
        .join("\n\n")
      await saveRun(input.runtime.worktree, run)
      if (run.async && run.status === "completed") await wakeParent(input.runtime, run)
    } catch (error) {
      run.status = token.cancelled ? "cancelled" : "failed"
      run.error = error instanceof Error ? error.message : String(error)
      await saveRun(input.runtime.worktree, run)
      if (run.async) await wakeParent(input.runtime, run)
    } finally {
      activeRuns.delete(run.id)
    }
  }

  if (run.async) setTimeout(() => void execute(), 0)
  else await execute()
  return run
}

export async function statusWorkflow(worktree: string, runID: string) {
  return loadRun(worktree, runID)
}

export async function cancelWorkflow(runtime: RuntimeContext, runID: string) {
  const token = activeRuns.get(runID)
  if (token) token.cancelled = true
  const run = await loadRun(runtime.worktree, runID)
  run.status = "cancelled"
  for (const child of Object.values(run.childSessions)) {
    if (child.status === "running") await runtime.client.session.abort?.({ sessionID: child.sessionID }).catch(() => undefined)
    child.status = child.status === "completed" ? child.status : "cancelled"
  }
  await saveRun(runtime.worktree, run)
  return run
}

async function executeStep(
  runtime: RuntimeContext,
  tool: ToolRuntimeContext,
  workflow: Workflow,
  run: WorkflowRun,
  step: WorkflowStep,
  state: Record<string, { output?: string }>,
  token: { cancelled: boolean },
) {
  if (token.cancelled) throw new Error("Workflow run cancelled")
  if (step.type === "serial") {
    for (const child of step.steps) await executeStep(runtime, tool, workflow, run, child, state, token)
    return
  }
  if (step.type === "parallel") {
    await Promise.all(step.steps.map((child) => executeStep(runtime, tool, workflow, run, child, state, token)))
    return
  }
  if (step.type === "loop") {
    for (let index = 0; index < step.maxIterations; index++) {
      for (const child of step.body) await executeStep(runtime, tool, workflow, run, child, state, token)
    }
    return
  }
  await executePromptStep(runtime, tool, workflow, run, step, state)
}

async function executePromptStep(
  runtime: RuntimeContext,
  tool: ToolRuntimeContext,
  workflow: Workflow,
  run: WorkflowRun,
  step: WorkflowStep,
  state: Record<string, { output?: string }>,
) {
  const settings = resolveStepSettings(workflow.defaults, step)
  const model = settings.model ? parseModel(settings.model) : undefined
  const prompt = buildStepPrompt(step, settings, run.inputs, state)
  if (run.async && runtime.client.session.prompt) {
    await executeSubtaskStep(runtime, tool, workflow, run, step, state, prompt, settings.agent ?? tool.agent ?? "general", model)
    return
  }

  const session = await runtime.client.session.create({
    parentID: run.parentSessionID,
    title: `workflow:${workflow.id}/${step.id}`,
    agent: settings.agent,
    model,
    metadata: { workflowID: workflow.id, runID: run.id, stepID: step.id, parentSessionID: run.parentSessionID, async: run.async },
    directory: tool.directory,
  })
  const sessionID = extractSessionID(session)
  if (!sessionID) throw new Error(`Failed to create child session for step ${step.id}`)
  run.childSessions[step.id] = { stepID: step.id, sessionID, status: "running" }
  await saveRun(runtime.worktree, run)

  const promptInput: Record<string, unknown> = { sessionID, parts: [{ type: "text", text: prompt }] }
  if (settings.agent) promptInput.agent = settings.agent
  if (model) promptInput.model = model
  if (Object.keys(settings.tools).length > 0) promptInput.tools = settings.tools
  if (settings.format !== undefined) promptInput.format = settings.format
  if (settings.system) promptInput.system = settings.system
  const promptResult = run.async && runtime.client.session.prompt_async ? await runtime.client.session.prompt_async(promptInput) : await runtime.client.session.prompt?.(promptInput)
  if (!run.async) await runtime.client.session.wait?.({ sessionID })
  const output = (await readSessionOutput(runtime, sessionID)) || extractText(promptResult) || ""
  run.childSessions[step.id] = { stepID: step.id, sessionID, status: "completed", output }
  state[step.id] = { output }
  await saveRun(runtime.worktree, run)
}

async function executeSubtaskStep(
  runtime: RuntimeContext,
  _tool: ToolRuntimeContext,
  workflow: Workflow,
  run: WorkflowRun,
  step: WorkflowStep,
  state: Record<string, { output?: string }>,
  prompt: string,
  agent: string,
  model?: { providerID: string; modelID: string },
) {
  const description = `workflow:${workflow.id}/${step.id}`
  const subtaskPart: Record<string, unknown> = {
    type: "subtask",
    agent,
    description,
    command: "workflow",
    prompt,
  }
  if (model) subtaskPart.model = model

  run.childSessions[step.id] = { stepID: step.id, sessionID: "pending", status: "running" }
  await saveRun(runtime.worktree, run)

  const result = await runtime.client.session.prompt?.({
    sessionID: run.parentSessionID,
    parts: [subtaskPart],
  })
  const sessionID = extractTaskSessionID(result) ?? "unknown"
  const output = extractTaskOutput(result) || extractText(result) || ""
  run.childSessions[step.id] = { stepID: step.id, sessionID, status: "completed", output }
  state[step.id] = { output }
  await saveRun(runtime.worktree, run)
}

function buildStepPrompt(step: WorkflowStep, settings: ReturnType<typeof resolveStepSettings>, inputs: Record<string, unknown>, state: Record<string, { output?: string }>) {
  const sections = []
  if (settings.skills.length) sections.push(`Use these workflow skills when helpful: ${settings.skills.join(", ")}`)
  if (settings.context !== undefined) sections.push(`Context:\n${typeof settings.context === "string" ? settings.context : JSON.stringify(settings.context, null, 2)}`)
  sections.push(renderTemplate(step.prompt ?? "", { inputs, steps: state }))
  return sections.filter(Boolean).join("\n\n")
}

async function readSessionOutput(runtime: RuntimeContext, sessionID: string) {
  const messages = await runtime.client.session.messages?.({ sessionID }).catch(() => undefined)
  return extractText(messages)
}

async function wakeParent(runtime: RuntimeContext, run: WorkflowRun) {
  const summary = run.status === "completed" ? run.result || "Workflow completed." : `Workflow ${run.status}: ${run.error ?? "No details."}`
  await runtime.client.session.prompt?.({
    sessionID: run.parentSessionID,
    noReply: false,
    parts: [{ type: "text", text: `[workflow:${run.workflowID}] run ${run.id} ${run.status}\n\n${summary}` }],
  }).catch(() => undefined)
}

function parseModel(input: string) {
  const [providerID, ...rest] = input.split("/")
  const modelID = rest.join("/")
  return providerID && modelID ? { providerID, modelID } : undefined
}

function extractSessionID(input: unknown): string | undefined {
  const data = unwrapData(input)
  if (isRecord(data) && typeof data.id === "string") return data.id
  return undefined
}

function extractText(input: unknown): string | undefined {
  const data = unwrapData(input)
  if (typeof data === "string") return data
  if (Array.isArray(data)) return data.map(extractText).filter(Boolean).join("\n")
  if (!isRecord(data)) return undefined
  if (typeof data.content === "string") return data.content
  if (typeof data.text === "string") return data.text
  if (typeof data.output === "string") return data.output
  if (isRecord(data.state) && typeof data.state.output === "string") return data.state.output
  if (Array.isArray(data.parts)) return data.parts.map(extractText).filter(Boolean).join("\n")
  if (Array.isArray(data.messages)) return data.messages.map(extractText).filter(Boolean).join("\n")
  return undefined
}

function extractTaskSessionID(input: unknown): string | undefined {
  const data = unwrapData(input)
  const fromMetadata = findStringKey(data, ["sessionId", "sessionID", "jobId"])
  if (fromMetadata) return fromMetadata
  const text = extractText(input)
  return text?.match(/<task id="([^"]+)"/)?.[1]
}

function extractTaskOutput(input: unknown): string | undefined {
  const text = extractText(input)
  return text?.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/)?.[1]?.trim()
}

function findStringKey(input: unknown, keys: string[]): string | undefined {
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = findStringKey(item, keys)
      if (found) return found
    }
    return undefined
  }
  if (!isRecord(input)) return undefined
  for (const key of keys) {
    const value = input[key]
    if (typeof value === "string") return value
  }
  for (const value of Object.values(input)) {
    const found = findStringKey(value, keys)
    if (found) return found
  }
  return undefined
}

function unwrapData(input: unknown): unknown {
  return isRecord(input) && "data" in input ? input.data : input
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null
}
