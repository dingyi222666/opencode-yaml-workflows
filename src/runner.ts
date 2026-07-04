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
  if (!input.tool.sessionID) throw new Error("workflow action=run requires a current parent sessionID")
  const run: WorkflowRun = {
    id: createRunID(),
    workflowID: input.workflow.id,
    parentSessionID: input.tool.sessionID,
    status: "queued",
    async: input.async ?? input.workflow.defaults.async ?? true,
    inputs: input.inputs,
    childSessions: {},
    logs: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  logRun(run, "Workflow run created", {
    workflowID: input.workflow.id,
    parentSessionID: input.tool.sessionID,
    async: run.async,
  })
  await saveRun(input.runtime.worktree, run)
  const token = { cancelled: false }
  activeRuns.set(run.id, token)

  const execute = async () => {
    try {
      run.status = "running"
      logRun(run, "Workflow run started", { workflowID: input.workflow.id, steps: input.workflow.steps.map((step) => step.id) })
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
      const details = formatUnknownError(error)
      run.status = token.cancelled ? "cancelled" : "failed"
      run.error = details
      logRun(run, "Workflow run failed", { error: details })
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
  logRun(run, "Workflow run cancelled", { runID })
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
  try {
    logRun(run, "Step started", { stepID: step.id, type: step.type })
    if (step.type === "serial") {
      for (const child of step.steps) await executeStep(runtime, tool, workflow, run, child, state, token)
      logRun(run, "Step completed", { stepID: step.id, type: step.type })
      return
    }
    if (step.type === "parallel") {
      await Promise.all(step.steps.map((child) => executeStep(runtime, tool, workflow, run, child, state, token)))
      logRun(run, "Step completed", { stepID: step.id, type: step.type })
      return
    }
    if (step.type === "loop") {
      for (let index = 0; index < step.maxIterations; index++) {
        logRun(run, "Loop iteration started", { stepID: step.id, iteration: index + 1, maxIterations: step.maxIterations })
        for (const child of step.body) await executeStep(runtime, tool, workflow, run, child, state, token)
      }
      logRun(run, "Step completed", { stepID: step.id, type: step.type })
      return
    }
    await executePromptStep(runtime, tool, workflow, run, step, state)
    logRun(run, "Step completed", { stepID: step.id, type: step.type })
  } catch (error) {
    const details = formatUnknownError(error)
    const existing = run.childSessions[step.id]
    run.childSessions[step.id] = {
      stepID: step.id,
      sessionID: existing?.sessionID ?? "unknown",
      status: "failed",
      output: existing?.output,
      error: details,
    }
    logRun(run, "Step failed", { stepID: step.id, type: step.type, error: details })
    await saveRun(runtime.worktree, run)
    throw new Error(`Workflow step ${step.id} failed:\n${details}`)
  }
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

  const createInput = {
    parentID: run.parentSessionID,
    title: `workflow:${workflow.id}/${step.id}`,
    agent: settings.agent,
    model,
    metadata: { workflowID: workflow.id, runID: run.id, stepID: step.id, parentSessionID: run.parentSessionID, async: run.async },
    directory: tool.directory,
  }
  logRun(run, "Creating direct child session", { stepID: step.id, createInput })
  const session = await runtime.client.session.create(createInput).catch((error) => {
    throw new Error(`Failed to create child session for step ${step.id}.\nCreate input:\n${safeJson(createInput)}\nError:\n${formatUnknownError(error)}`)
  })
  const sessionID = extractSessionID(session)
  if (!sessionID) {
    throw new Error(
      `Failed to create child session for step ${step.id}.\nCreate input:\n${safeJson(createInput)}\nRaw response:\n${safeJson(session)}\nHint: opencode SDK may have returned an error envelope or a shape without data.id/id.`,
    )
  }
  logRun(run, "Direct child session created", { stepID: step.id, sessionID })
  run.childSessions[step.id] = { stepID: step.id, sessionID, status: "running" }
  await saveRun(runtime.worktree, run)

  const promptInput: Record<string, unknown> = { sessionID, parts: [{ type: "text", text: prompt }] }
  if (settings.agent) promptInput.agent = settings.agent
  if (model) promptInput.model = model
  if (Object.keys(settings.tools).length > 0) promptInput.tools = settings.tools
  if (settings.format !== undefined) promptInput.format = settings.format
  if (settings.system) promptInput.system = settings.system
  logRun(run, "Prompting direct child session", { stepID: step.id, promptInput })
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

  const parentPromptInput = {
    sessionID: run.parentSessionID,
    parts: [subtaskPart],
  }
  logRun(run, "Submitting subtask part to parent session", { stepID: step.id, parentPromptInput })
  const result = await runtime.client.session.prompt?.(parentPromptInput).catch((error) => {
    throw new Error(`Failed to submit subtask part for step ${step.id}.\nPrompt input:\n${safeJson(parentPromptInput)}\nError:\n${formatUnknownError(error)}`)
  })
  const sessionID = extractTaskSessionID(result) ?? "unknown"
  const output = extractTaskOutput(result) || extractText(result) || ""
  if (sessionID === "unknown") {
    logRun(run, "Subtask result did not expose child session id", { stepID: step.id, rawResult: result })
  } else {
    logRun(run, "Subtask child session resolved", { stepID: step.id, sessionID })
  }
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
  const logs = run.logs?.length ? `\n\nWorkflow logs:\n${run.logs.slice(-30).join("\n")}` : ""
  await runtime.client.session.prompt?.({
    sessionID: run.parentSessionID,
    noReply: false,
    parts: [{ type: "text", synthetic: true, text: `[workflow:${run.workflowID}] run ${run.id} ${run.status}\n\n${summary}${logs}` }],
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

function logRun(run: WorkflowRun, message: string, data?: unknown) {
  const suffix = data === undefined ? "" : ` ${safeJson(data)}`
  run.logs ??= []
  run.logs.push(`[${new Date().toISOString()}] ${message}${suffix}`)
  run.updatedAt = new Date().toISOString()
}

function formatUnknownError(error: unknown) {
  if (error instanceof Error) return [error.message, error.stack].filter(Boolean).join("\n")
  return safeJson(error)
}

function safeJson(value: unknown) {
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      value,
      (_key, current) => {
        if (typeof current === "object" && current !== null) {
          if (seen.has(current)) return "[Circular]"
          seen.add(current)
        }
        return current
      },
      2,
    )
  } catch {
    return String(value)
  }
}

function unwrapData(input: unknown): unknown {
  return isRecord(input) && "data" in input ? input.data : input
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null
}
