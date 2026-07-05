import { createRunID, loadRun, saveRun } from "./persistence.js"
import { renderTemplate, resolveStepSettings } from "./parser.js"
import type { RuntimeContext, ToolRuntimeContext, Workflow, WorkflowRun, WorkflowStep } from "./types.js"
import type { createOpencodeClient } from "@opencode-ai/sdk/v2"

type SDKSession = ReturnType<typeof createOpencodeClient>["session"]
type SessionAbortInput = Parameters<SDKSession["abort"]>[0]
type SessionCreateInput = NonNullable<Parameters<SDKSession["create"]>[0]>
type SessionGetInput = Parameters<SDKSession["get"]>[0]
type SessionMessagesInput = Parameters<SDKSession["messages"]>[0]
type SessionPromptInput = Parameters<SDKSession["prompt"]>[0]

const CHILD_SESSION_TIMEOUT_MS = 15 * 60 * 1000
const PARENT_STAGE_NOTIFICATION_TIMEOUT_MS = 5_000
const STEP_OUTPUT_MAX_ATTEMPTS = 3
const WAKE_OUTPUT_MAX_STEPS = 3

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
      if (run.async && run.status === "completed") await wakeParent(input.runtime, input.workflow, run)
    } catch (error) {
      const details = formatUnknownError(error)
      run.status = token.cancelled ? "cancelled" : "failed"
      run.error = details
      logRun(run, "Workflow run failed", { error: details })
      await saveRun(input.runtime.worktree, run)
      if (run.async) await wakeParent(input.runtime, input.workflow, run)
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
      const abortInput: SessionAbortInput = { sessionID: child.sessionID, directory: runtime.directory }
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
    await executePromptStepWithRetries(runtime, tool, workflow, run, step, state)
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

async function executePromptStepWithRetries(
  runtime: RuntimeContext,
  tool: ToolRuntimeContext,
  workflow: Workflow,
  run: WorkflowRun,
  step: WorkflowStep,
  state: Record<string, { output?: string }>,
) {
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= STEP_OUTPUT_MAX_ATTEMPTS; attempt++) {
    try {
      const output = await executePromptStep(runtime, tool, workflow, run, step, state, attempt)
      if (isUsableOutput(output)) return
      lastError = new Error(`Workflow step ${step.id} returned empty output on attempt ${attempt}`)
      logRun(run, "Step returned empty output", { stepID: step.id, attempt, maxAttempts: STEP_OUTPUT_MAX_ATTEMPTS })
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(formatUnknownError(error))
      logRun(run, "Step attempt failed", { stepID: step.id, attempt, maxAttempts: STEP_OUTPUT_MAX_ATTEMPTS, error: formatUnknownError(error) })
    }
  }
  throw lastError ?? new Error(`Workflow step ${step.id} did not return usable output`)
}

async function executePromptStep(
  runtime: RuntimeContext,
  tool: ToolRuntimeContext,
  workflow: Workflow,
  run: WorkflowRun,
  step: WorkflowStep,
  state: Record<string, { output?: string }>,
  attempt: number,
) {
  const settings = resolveStepSettings(workflow.defaults, step)
  const model = settings.model ? parseModel(settings.model) : undefined
  const parentDirectory = await resolveParentSessionDirectory(runtime, run.parentSessionID)
  const targetDirectory = runtime.directory
  const prompt = buildStepPrompt(step, settings, run.inputs, state, { parentDirectory, targetDirectory })
  const session = await createChildSession(runtime, workflow, run, step, parentDirectory, settings.agent)
  const sessionID = extractSessionID(session)
  if (!sessionID) {
    throw new Error(
      `Failed to create child session for step ${step.id}.\nRaw response:\n${safeJson(session)}\nHint: opencode SDK may have returned an error envelope or a shape without data.id/id.`,
    )
  }
  logRun(run, "Direct child session created", { stepID: step.id, sessionID, attempt })
  run.childSessions[step.id] = { stepID: step.id, sessionID, status: "running" }
  await saveRun(runtime.worktree, run)

  const sessionData = unwrapData(session)
  const sessionDirectory = isRecord(sessionData) && typeof sessionData.directory === "string" ? sessionData.directory : parentDirectory
  const promptInput: SessionPromptInput = { sessionID, directory: sessionDirectory, parts: [{ type: "text", text: prompt }] }
  if (settings.agent) promptInput.agent = settings.agent
  if (model) promptInput.model = model
  if (Object.keys(settings.tools).length > 0) promptInput.tools = settings.tools
  if (settings.system) promptInput.system = settings.system
  logRun(run, "Prompting direct child session", { stepID: step.id, attempt, sessionID })
  const promptResult = await waitForChildPrompt(runtime, run, sessionID, sessionDirectory, step.id, promptInput)
  const output = normalizeOutput((await readSessionOutput(runtime, sessionID, sessionDirectory)) || extractText(promptResult) || "")
  run.childSessions[step.id] = { stepID: step.id, sessionID, status: "completed", output }
  state[step.id] = { output }
  await saveRun(runtime.worktree, run)
  if (run.async && isUsableOutput(output)) await notifyParentStepCompleted(runtime, run, step.id)
  return output
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
  const messagesInput: SessionMessagesInput = { sessionID, directory }
  const messages = await runtime.client.session.messages?.(messagesInput).catch(() => undefined)
  return extractText(messages)
}

async function createChildSession(
  runtime: RuntimeContext,
  workflow: Workflow,
  run: WorkflowRun,
  step: WorkflowStep,
  parentDirectory: string,
  agent?: string,
) {
  const title = `workflow:${workflow.id}/${step.id}`
  const createInput: SessionCreateInput = {
    parentID: run.parentSessionID,
    title,
    directory: parentDirectory,
    agent,
    metadata: { workflowID: workflow.id, runID: run.id, stepID: step.id, parentSessionID: run.parentSessionID },
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
    const input: SessionGetInput = { sessionID: parentSessionID, directory }
    const result = await getSession(input).catch(() => undefined)
    const envelopeError = formatSDKEnvelopeError(result)
    if (envelopeError) continue
    const data = unwrapData(result)
    if (isRecord(data) && typeof data.directory === "string") return data.directory
  }
  return runtime.directory
}

async function waitForChildPrompt(
  runtime: RuntimeContext,
  run: WorkflowRun,
  sessionID: string,
  directory: string | undefined,
  stepID: string,
  promptInput: SessionPromptInput,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      runtime.client.session.prompt(promptInput),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Child session timed out after ${CHILD_SESSION_TIMEOUT_MS / 1000}s`)), CHILD_SESSION_TIMEOUT_MS)
      }),
    ])
    const envelopeError = formatSDKEnvelopeError(result)
    if (envelopeError) throw new Error(`Failed to prompt child session for step ${stepID}.\nPrompt input:\n${safeJson(promptInput)}\n${envelopeError}`)
    return result
  } catch (error) {
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
    logRun(run, "Child prompt reached terminal signal", { stepID, sessionID, directory })
  }
}

async function wakeParent(runtime: RuntimeContext, workflow: Workflow, run: WorkflowRun) {
  const output = renderWakeOutput(workflow, run)
  const summary = run.status === "completed" ? output : output || `Workflow ${run.status}.`
  const parentDirectory = await resolveParentSessionDirectory(runtime, run.parentSessionID)
  const wakeInput: SessionPromptInput = {
    sessionID: run.parentSessionID,
    directory: parentDirectory,
    noReply: false,
    parts: [{ type: "text", text: summary }],
  }
  await runtime.client.session
    .prompt?.(wakeInput)
    .catch(() => undefined)
}

async function notifyParentStepCompleted(runtime: RuntimeContext, run: WorkflowRun, stepID: string) {
  const parentDirectory = await resolveParentSessionDirectory(runtime, run.parentSessionID)
  const input: SessionPromptInput = {
    sessionID: run.parentSessionID,
    directory: parentDirectory,
    noReply: false,
    parts: [
      {
        type: "text",
        text: `Workflow stage completed: ${stepID}.\n\nThe workflow is still running. I will send the final output when all stages finish.`,
      },
    ],
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      runtime.client.session.prompt(input),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`parent stage notification timed out after ${PARENT_STAGE_NOTIFICATION_TIMEOUT_MS}ms`)), PARENT_STAGE_NOTIFICATION_TIMEOUT_MS)
      }),
    ])
    const envelopeError = formatSDKEnvelopeError(result)
    if (envelopeError) throw new Error(envelopeError)
  } catch (error) {
    logRun(run, "Parent stage completion notification failed", { stepID, error: formatUnknownError(error) })
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function renderWakeOutput(workflow: Workflow, run: WorkflowRun) {
  if (run.status !== "completed") return renderFailureOutput(run)
  const ordered = collectPromptStepIDs(workflow.steps)
    .map((stepID) => run.childSessions[stepID])
    .filter((child) => child?.status === "completed" && isUsableOutput(child.output))
  const preferred = ordered.filter((child) => isFinalOutputStep(child.stepID))
  const selected = (preferred.length ? preferred : ordered).slice(-WAKE_OUTPUT_MAX_STEPS)
  if (!selected.length) return "No workflow output was produced."
  if (selected.length === 1) return normalizeOutput(selected[0]?.output ?? "")
  return selected.map((child) => `## ${child.stepID}\n${normalizeOutput(child.output ?? "")}`).join("\n\n")
}

function renderFailureOutput(run: WorkflowRun) {
  const failed = Object.values(run.childSessions).find((child) => child.status === "failed" && child.error)
  const error = failed?.error ?? run.error
  if (!error) return ""
  return `## ${failed?.stepID ?? "error"}\n${compactError(error)}`
}

function collectPromptStepIDs(steps: WorkflowStep[]): string[] {
  const ids: string[] = []
  for (const step of steps) {
    if (step.type === "serial" || step.type === "parallel") ids.push(...collectPromptStepIDs(step.steps))
    else if (step.type === "loop") ids.push(...collectPromptStepIDs(step.body))
    else ids.push(step.id)
  }
  return ids
}

function isFinalOutputStep(stepID: string) {
  return /(^|[-_])(final|summary|summarize|result|report|answer)([-_]|$)/i.test(stepID)
}

function normalizeOutput(input: string) {
  return input.replace(/\u00a0/g, " ").trim()
}

function isUsableOutput(input: string | undefined) {
  if (!input) return false
  return input.replace(/\s/g, "").length > 0
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
  if (Array.isArray(data.content)) return data.content.map(extractText).filter(Boolean).join("\n")
  if (Array.isArray(data.items)) return data.items.map(extractText).filter(Boolean).join("\n")
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

function compactError(input: string) {
  const code = input.match(/"code"\s*:\s*"([^"]+)"/)?.[1]
  const message = input.match(/"message"\s*:\s*"([^"]+)"/)?.[1]
  if (code || message) return [code, message].filter(Boolean).join(": ")

  const withoutDebugBlocks = input.split(/\n(?:Prompt input:|Create input:|Request:|Response:)/)[0] ?? input
  return input
    .replace(input, withoutDebugBlocks)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^at\s+/.test(line))
    .filter((line) => !line.startsWith("Create input:"))
    .filter((line) => !line.startsWith("Prompt input:"))
    .filter((line) => !line.startsWith("Request:"))
    .filter((line) => !line.startsWith("Response:"))
    .slice(0, 4)
    .join("\n")
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
      throw new Error(`Missing required workflow input "${name}" for workflow ${workflow.id}. Provided inputs: ${provided}.\n\n${formatWorkflowInputContract(workflow)}`)
    }
    if (value !== undefined && value !== null && !matchesInputType(value, definition.type ?? "string")) {
      throw new Error(`Invalid workflow input "${name}" for workflow ${workflow.id}: expected ${definition.type ?? "string"}, got ${Array.isArray(value) ? "array" : typeof value}.\n\n${formatWorkflowInputContract(workflow)}`)
    }
  }
  return resolved
}

function formatWorkflowInputContract(workflow: Workflow) {
  const entries = Object.entries(workflow.inputs)
  if (entries.length === 0) return `Workflow ${workflow.id} defines no inputs.`
  return [
    `Workflow ${workflow.id} input contract:`,
    ...entries.map(([name, definition]) => {
      const required = definition.required ? "required" : "optional"
      const type = definition.type ?? "string"
      const defaultText = definition.default === undefined ? "" : `; default=${JSON.stringify(definition.default)}`
      const description = definition.description ? `; ${definition.description}` : ""
      return `- ${name}: ${type}, ${required}${defaultText}${description}`
    }),
    "Provide workflow action=run inputs as an object matching this contract.",
  ].join("\n")
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
