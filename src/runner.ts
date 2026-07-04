import { createRunID, loadRun, saveRun } from "./persistence.js"
import { renderTemplate, resolveStepSettings } from "./parser.js"
import type { RuntimeContext, ToolRuntimeContext, Workflow, WorkflowRun, WorkflowStep } from "./types.js"
import type { createOpencodeClient } from "@opencode-ai/sdk"

type SDKSession = ReturnType<typeof createOpencodeClient>["session"]
type SessionAbortInput = Parameters<SDKSession["abort"]>[0]
type SessionCreateInput = NonNullable<Parameters<SDKSession["create"]>[0]>
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
  if (run.async) {
    try {
      await executeSubtaskStep(runtime, tool, workflow, run, step, state, prompt, settings.agent ?? tool.agent ?? "general", model)
      return
    } catch (error) {
      const details = formatUnknownError(error)
      logRun(run, "Native subtask execution failed", {
        stepID: step.id,
        error: details,
      })
      throw new Error(`Native subtask execution failed for step ${step.id}. Direct child-session fallback is disabled for async runs because it would not create native opencode task notifications.\n${details}`)
    }
  }

  const createInput: SessionCreateInput = {
    body: { parentID: run.parentSessionID, title: `workflow:${workflow.id}/${step.id}` },
    query: tool.directory ? { directory: tool.directory } : undefined,
  }
  logRun(run, "Creating direct child session", { stepID: step.id, createInput })
  const session = await runtime.client.session.create(createInput).catch((error) => {
    throw new Error(`Failed to create child session for step ${step.id}.\nCreate input:\n${safeJson(createInput)}\nError:\n${formatUnknownError(error)}`)
  })
  const createEnvelopeError = formatSDKEnvelopeError(session)
  if (createEnvelopeError) {
    throw new Error(`Failed to create child session for step ${step.id}.\nCreate input:\n${safeJson(createInput)}\n${createEnvelopeError}`)
  }
  const sessionID = extractSessionID(session)
  if (!sessionID) {
    throw new Error(
      `Failed to create child session for step ${step.id}.\nCreate input:\n${safeJson(createInput)}\nRaw response:\n${safeJson(session)}\nHint: opencode SDK may have returned an error envelope or a shape without data.id/id.`,
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
  const promptInput: SessionPromptInput = { path: { id: sessionID }, body: promptBody, query: tool.directory ? { directory: tool.directory } : undefined }
  logRun(run, "Prompting direct child session", { stepID: step.id, promptInput })
  const promptResult = run.async && runtime.client.session.promptAsync
    ? await runtime.client.session.promptAsync(promptInput as SessionPromptAsyncInput)
    : await runtime.client.session.prompt?.(promptInput)
  const promptEnvelopeError = formatSDKEnvelopeError(promptResult)
  if (promptEnvelopeError) {
    throw new Error(`Failed to prompt child session for step ${step.id}.\nPrompt input:\n${safeJson(promptInput)}\n${promptEnvelopeError}`)
  }
  if (!run.async) await runtime.client.session.wait?.({ sessionID })
  const output = (await readSessionOutput(runtime, sessionID, tool.directory)) || extractText(promptResult) || ""
  run.childSessions[step.id] = { stepID: step.id, sessionID, status: "completed", output }
  state[step.id] = { output }
  await saveRun(runtime.worktree, run)
}

async function executeSubtaskStep(
  runtime: RuntimeContext,
  tool: ToolRuntimeContext,
  workflow: Workflow,
  run: WorkflowRun,
  step: WorkflowStep,
  state: Record<string, { output?: string }>,
  prompt: string,
  agent: string,
  model?: { providerID: string; modelID: string },
) {
  if (!runtime.v2Client) {
    throw new Error("Native subtask execution requires @opencode-ai/sdk/v2 client support.")
  }
  const description = `workflow:${workflow.id}/${step.id}`

  run.childSessions[step.id] = { stepID: step.id, sessionID: "pending", status: "running" }
  await saveRun(runtime.worktree, run)

  const promptText = [
    `Run workflow step ${description} as native subtask handling.`,
    `Use agent: ${agent}.`,
    model ? `Use model: ${model.providerID}/${model.modelID}.` : undefined,
    "Prompt:",
    prompt,
  ]
    .filter(Boolean)
    .join("\n\n")
  const parentPromptInput = {
    sessionID: run.parentSessionID,
    prompt: { text: promptText, agents: [{ name: agent }] },
    delivery: "queue" as const,
  }
  logRun(run, "Submitting v2 native subtask prompt to parent session", { stepID: step.id, parentPromptInput })
  const result = await runtime.v2Client.session.prompt(parentPromptInput).catch((error) => {
    throw new Error(`Failed to submit v2 native subtask prompt for step ${step.id}.\nPrompt input:\n${safeJson(parentPromptInput)}\nError:\n${formatUnknownError(error)}`)
  })
  const envelopeError = formatSDKEnvelopeError(result)
  if (envelopeError) {
    throw new Error(`Failed to submit v2 native subtask prompt for step ${step.id}.\nPrompt input:\n${safeJson(parentPromptInput)}\n${envelopeError}`)
  }
  const sessionID = extractTaskSessionID(result) ?? "pending"
  const output = extractTaskOutput(result) || extractText(result) || `Submitted native subtask prompt ${extractAdmittedID(result) ?? ""}`.trim()
  if (sessionID === "unknown") {
    logRun(run, "V2 native subtask result did not expose child session id", { stepID: step.id, rawResult: result })
  } else {
    logRun(run, "V2 native subtask prompt accepted", { stepID: step.id, sessionID })
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

async function readSessionOutput(runtime: RuntimeContext, sessionID: string, directory?: string) {
  const messagesInput: SessionMessagesInput = { path: { id: sessionID }, query: directory ? { directory } : undefined }
  const messages = await runtime.client.session.messages?.(messagesInput).catch(() => undefined)
  return extractText(messages)
}

async function wakeParent(runtime: RuntimeContext, run: WorkflowRun) {
  const summary = run.status === "completed" ? run.result || "Workflow completed." : `Workflow ${run.status}: ${run.error ?? "No details."}`
  const logs = run.logs?.length ? `\n\nWorkflow logs:\n${run.logs.slice(-30).join("\n")}` : ""
  const wakeInput: SessionPromptInput = {
    path: { id: run.parentSessionID },
    body: { noReply: false, parts: [{ type: "text", synthetic: true, text: `[workflow:${run.workflowID}] run ${run.id} ${run.status}\n\n${summary}${logs}` }] },
    query: runtime.directory ? { directory: runtime.directory } : undefined,
  }
  await runtime.client.session
    .prompt?.(wakeInput)
    .catch(() => undefined)
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

function extractAdmittedID(input: unknown): string | undefined {
  const data = unwrapData(input)
  return findStringKey(data, ["id", "messageID"])
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
  if (error instanceof Error) {
    const extra = objectDetails(error)
    return [error.message, error.stack, extra === "{}" ? undefined : extra].filter(Boolean).join("\n")
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
    `Request: ${safeJson(input.request)}`,
    `Response: ${safeJson(input.response)}`,
    `Raw envelope: ${safeJson(input)}`,
  ].join("\n")
}

function objectDetails(value: object) {
  const out: Record<string, unknown> = {
    constructor: value.constructor?.name,
  }
  for (const key of Object.getOwnPropertyNames(value)) {
    out[key] = (value as Record<string, unknown>)[key]
  }
  for (const [key, current] of Object.entries(value)) {
    out[key] = current
  }
  return safeJson(out)
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
