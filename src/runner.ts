import { createRunID, loadRun, saveRun } from "./persistence.js"
import { renderTemplate, resolveStepSettings } from "./parser.js"
import type { RuntimeContext, ToolRuntimeContext, Workflow, WorkflowRun, WorkflowStep } from "./types.js"
import type { createOpencodeClient } from "@opencode-ai/sdk"

type SDKSession = ReturnType<typeof createOpencodeClient>["session"]
type SessionAbortInput = Parameters<SDKSession["abort"]>[0]
type SessionCreateInput = NonNullable<Parameters<SDKSession["create"]>[0]>
type SessionGetInput = Parameters<SDKSession["get"]>[0]
type SessionMessagesInput = Parameters<SDKSession["messages"]>[0]
type SessionPromptInput = Parameters<SDKSession["prompt"]>[0]
type SessionPromptAsyncInput = Parameters<SDKSession["promptAsync"]>[0]
type SessionPromptBody = NonNullable<SessionPromptInput["body"]>

const activeRuns = new Map<string, { cancelled: boolean }>()

export async function runWorkflow(input: {
  runtime: RuntimeContext
  tool: ToolRuntimeContext
  workflow: Workflow
  inputs: Record<string, unknown>
  async?: boolean
}) {
  if (!input.tool.sessionID) throw new Error("workflow action=run requires a current parent sessionID")
  const resolvedInputs = resolveWorkflowInputs(input.workflow, input.inputs)
  const run: WorkflowRun = {
    id: createRunID(),
    workflowID: input.workflow.id,
    parentSessionID: input.tool.sessionID,
    status: "queued",
    async: input.async ?? input.workflow.defaults.async ?? true,
    inputs: resolvedInputs,
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
    if (child.status === "running") {
      const abortInput: SessionAbortInput = { path: { id: child.sessionID }, query: runtime.directory ? { directory: runtime.directory } : undefined }
      await runtime.client.session.abort?.(abortInput).catch(() => undefined)
    }
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
    if (run.async && existing?.sessionID && existing.sessionID !== "unknown") {
      await notifyParentTask(runtime, run, step.id, existing.sessionID, "error", details)
    }
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
  const parentDirectory = await resolveParentSessionDirectory(runtime, run.parentSessionID)
  const targetDirectory = runtime.directory
  const prompt = buildStepPrompt(step, settings, run.inputs, state, { parentDirectory, targetDirectory })
  const session = await createChildSession(runtime, workflow, run, step, parentDirectory)
  const sessionID = extractSessionID(session)
  if (!sessionID) {
    throw new Error(
      `Failed to create child session for step ${step.id}.\nRaw response:\n${safeJson(session)}\nHint: opencode SDK may have returned an error envelope or a shape without data.id/id.`,
    )
  }
  logRun(run, "Direct child session created", { stepID: step.id, sessionID })
  run.childSessions[step.id] = { stepID: step.id, sessionID, status: "running" }
  await saveRun(runtime.worktree, run)

  const promptBody: SessionPromptBody = { parts: [{ type: "text", text: prompt }] }
  if (settings.agent) promptBody.agent = settings.agent
  if (model) promptBody.model = model
  if (Object.keys(settings.tools).length > 0) promptBody.tools = settings.tools
  if (settings.system) promptBody.system = settings.system
  const sessionData = unwrapData(session)
  const sessionDirectory = isRecord(sessionData) && typeof sessionData.directory === "string" ? sessionData.directory : parentDirectory
  const promptInput: SessionPromptInput = { path: { id: sessionID }, body: promptBody, query: sessionDirectory ? { directory: sessionDirectory } : undefined }
  logRun(run, "Prompting direct child session", { stepID: step.id, promptInput })
  const promptResult = run.async && runtime.client.session.promptAsync
    ? await runtime.client.session.promptAsync(promptInput as SessionPromptAsyncInput)
    : await runtime.client.session.prompt?.(promptInput)
  const promptEnvelopeError = formatSDKEnvelopeError(promptResult)
  if (promptEnvelopeError) {
    throw new Error(`Failed to prompt child session for step ${step.id}.\nPrompt input:\n${safeJson(promptInput)}\n${promptEnvelopeError}`)
  }
  if (runtime.client.session.wait) {
    await runtime.client.session.wait({ sessionID }).catch((error) => {
      throw new Error(`Failed to wait for child session for step ${step.id}.\nSession ID: ${sessionID}\nError:\n${formatUnknownError(error)}`)
    })
  }
  const output = (await readSessionOutput(runtime, sessionID, sessionDirectory)) || extractText(promptResult) || ""
  run.childSessions[step.id] = { stepID: step.id, sessionID, status: "completed", output }
  state[step.id] = { output }
  await saveRun(runtime.worktree, run)
  if (run.async) await notifyParentTask(runtime, run, step.id, sessionID, "completed", output)
}

function buildStepPrompt(
  step: WorkflowStep,
  settings: ReturnType<typeof resolveStepSettings>,
  inputs: Record<string, unknown>,
  state: Record<string, { output?: string }>,
  execution?: { parentDirectory?: string; targetDirectory?: string },
) {
  const sections = []
  if (execution?.targetDirectory && execution.parentDirectory && execution.targetDirectory !== execution.parentDirectory) {
    sections.push(`Target repository directory:\n${execution.targetDirectory}\n\nUse this absolute path for file operations and command workdir. Keep this workflow child session attached to the parent session directory: ${execution.parentDirectory}`)
  }
  if (settings.skills.length) sections.push(`Use these workflow skills when helpful: ${settings.skills.join(", ")}`)
  if (settings.context !== undefined) sections.push(`Context:\n${typeof settings.context === "string" ? settings.context : JSON.stringify(settings.context, null, 2)}`)
  sections.push(renderTemplate(step.prompt ?? "", { inputs, steps: state }))
  return sections.filter(Boolean).join("\n\n")
}

async function readSessionOutput(runtime: RuntimeContext, sessionID: string, directory?: string) {
  const messagesInput: SessionMessagesInput = { path: { id: sessionID }, query: directory ? { directory } : undefined }
  const messages = await runtime.client.session.messages?.(messagesInput).catch(() => undefined)
  return extractText(messages)
}

async function createChildSession(
  runtime: RuntimeContext,
  workflow: Workflow,
  run: WorkflowRun,
  step: WorkflowStep,
  parentDirectory: string,
) {
  const title = `workflow:${workflow.id}/${step.id}`
  const createInput: SessionCreateInput = {
    body: { parentID: run.parentSessionID, title },
    query: parentDirectory ? { directory: parentDirectory } : undefined,
  }
  logRun(run, "Creating direct child session in parent directory", { stepID: step.id, parentDirectory, createInput })
  const session = await runtime.client.session.create(createInput).catch((error) => {
    throw new Error(`Failed to create child session for step ${step.id}.\n${formatCreateFailure(createInput, error)}`)
  })
  const envelopeError = formatSDKEnvelopeError(session)
  if (envelopeError) throw new Error(`Failed to create child session for step ${step.id}.\nCreate input:\n${safeJson(createInput)}\n${envelopeError}`)
  return session
}

async function resolveParentSessionDirectory(runtime: RuntimeContext, parentSessionID: string) {
  const getSession = runtime.client.session.get?.bind(runtime.client.session)
  if (!getSession) return runtime.directory

  const candidates = [runtime.directory, undefined]
  for (const directory of candidates) {
    const input: SessionGetInput = { path: { id: parentSessionID }, query: directory ? { directory } : undefined }
    const result = await getSession(input).catch(() => undefined)
    const envelopeError = formatSDKEnvelopeError(result)
    if (envelopeError) continue
    const data = unwrapData(result)
    if (isRecord(data) && typeof data.directory === "string") return data.directory
  }
  return runtime.directory
}

async function wakeParent(runtime: RuntimeContext, run: WorkflowRun) {
  const childSummary = Object.values(run.childSessions)
    .map((child) => `- ${child.stepID}: ${child.status} (${child.sessionID})`)
    .join("\n")
  const summary = run.status === "completed"
    ? `Workflow completed.\n\n${childSummary}`
    : `Workflow ${run.status}: ${run.error ?? "No details."}\n\n${childSummary}`
  const logs = run.status === "failed" && run.logs?.length ? `\n\nWorkflow logs:\n${run.logs.slice(-10).join("\n")}` : ""
  const parentDirectory = await resolveParentSessionDirectory(runtime, run.parentSessionID)
  const wakeInput: SessionPromptInput = {
    path: { id: run.parentSessionID },
    body: { noReply: false, parts: [{ type: "text", synthetic: true, text: `[workflow:${run.workflowID}] run ${run.id} ${run.status}\n\n${summary}${logs}` }] },
    query: parentDirectory ? { directory: parentDirectory } : undefined,
  }
  await runtime.client.session
    .prompt?.(wakeInput)
    .catch(() => undefined)
}

async function notifyParentTask(
  runtime: RuntimeContext,
  run: WorkflowRun,
  stepID: string,
  sessionID: string,
  state: "completed" | "error",
  text: string,
) {
  const body = renderTaskNotification({ stepID, sessionID, state, text })
  const parentDirectory = await resolveParentSessionDirectory(runtime, run.parentSessionID)
  const input: SessionPromptInput = {
    path: { id: run.parentSessionID },
    body: { noReply: true, parts: [{ type: "text", synthetic: true, text: body }] },
    query: parentDirectory ? { directory: parentDirectory } : undefined,
  }
  logRun(run, "Injecting parent task-like notification", { stepID, sessionID, state })
  await runtime.client.session.prompt?.(input).catch((error) => {
    logRun(run, "Failed to inject parent task-like notification", { stepID, sessionID, error: formatUnknownError(error) })
  })
}

function renderTaskNotification(input: {
  stepID: string
  sessionID: string
  state: "completed" | "error"
  text: string
}) {
  const tag = input.state === "completed" ? "task_result" : "task_error"
  const summary = `Workflow step ${input.state === "completed" ? "completed" : "failed"}: ${input.stepID}`
  return [
    `<task id="${input.sessionID}" state="${input.state}">`,
    `<summary>${summary}</summary>`,
    `<${tag}>`,
    input.text,
    `</${tag}>`,
    "</task>",
  ].join("\n")
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

function logRun(run: WorkflowRun, message: string, data?: unknown) {
  const suffix = data === undefined ? "" : ` ${safeJson(data, 2_000)}`
  run.logs ??= []
  run.logs.push(`[${new Date().toISOString()}] ${message}${suffix}`)
  run.updatedAt = new Date().toISOString()
}

function formatUnknownError(error: unknown) {
  if (error instanceof Error) {
    const stack = typeof error.stack === "string" ? error.stack.split("\n").slice(0, 4).join("\n") : undefined
    return [error.message, stack].filter(Boolean).join("\n")
  }
  if (typeof error === "object" && error !== null) {
    const details = objectDetails(error)
    const asString = String(error)
    return details === "{}" ? asString : details
  }
  return safeJson(error)
}

function formatSDKEnvelopeError(input: unknown) {
  if (!isRecord(input) || !("error" in input) || input.error === undefined || input.error === null) return undefined
  return [
    "SDK returned an error envelope.",
    `Error: ${formatUnknownError(input.error)}`,
    `Request: ${safeJson(input.request, 1_000)}`,
    `Response: ${formatResponse(input.response)}`,
  ].join("\n")
}

function formatCreateFailure(input: unknown, error: unknown) {
  return [`Create input:`, safeJson(input, 2_000), `Error:`, formatUnknownError(error)].join("\n")
}

function objectDetails(value: object) {
  const out: Record<string, unknown> = {
    constructor: value.constructor?.name,
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    if (key === "stack") continue
    out[key] = (value as Record<string, unknown>)[key]
  }
  for (const [key, current] of Object.entries(value)) {
    out[key] = current
  }
  return safeJson(out)
}

function safeJson(value: unknown, maxLength = 4_000) {
  const seen = new WeakSet<object>()
  try {
    const result = JSON.stringify(
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
    return truncate(result, maxLength)
  } catch {
    return truncate(String(value), maxLength)
  }
}

function formatResponse(input: unknown) {
  if (!isRecord(input)) return safeJson(input, 1_000)
  const status = typeof input.status === "number" ? input.status : undefined
  const statusText = typeof input.statusText === "string" ? input.statusText : undefined
  const url = typeof input.url === "string" ? input.url : undefined
  const compact = { status, statusText, url }
  return safeJson(Object.values(compact).some((value) => value !== undefined) ? compact : input, 1_000)
}

function truncate(input: string, maxLength: number) {
  return input.length > maxLength ? `${input.slice(0, maxLength)}…[truncated ${input.length - maxLength} chars]` : input
}

function resolveWorkflowInputs(workflow: Workflow, input: Record<string, unknown>) {
  const resolved = { ...input }
  for (const [name, definition] of Object.entries(workflow.inputs)) {
    if (resolved[name] === undefined && definition.default !== undefined) resolved[name] = definition.default
    const value = resolved[name]
    if (definition.required && (value === undefined || value === null || value === "")) {
      const provided = Object.keys(input).length ? Object.keys(input).join(", ") : "none"
      throw new Error(`Missing required workflow input "${name}" for workflow ${workflow.id}. Provided inputs: ${provided}.`)
    }
    if (value !== undefined && value !== null && !matchesInputType(value, definition.type ?? "string")) {
      throw new Error(`Invalid workflow input "${name}" for workflow ${workflow.id}: expected ${definition.type ?? "string"}, got ${Array.isArray(value) ? "array" : typeof value}.`)
    }
  }
  return resolved
}

function matchesInputType(value: unknown, type: string) {
  if (type === "array") return Array.isArray(value)
  if (type === "object") return isRecord(value)
  return typeof value === type
}

function unwrapData(input: unknown): unknown {
  return isRecord(input) && "data" in input ? input.data : input
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null
}
