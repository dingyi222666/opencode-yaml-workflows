import { parse as parseYaml, stringify } from "yaml"
import type { StepExecutionSettings, Workflow, WorkflowDefaults, WorkflowStep } from "./types.js"

const STEP_TYPES = new Set(["prompt", "serial", "parallel", "summary", "planner", "loop"])

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowValidationError"
  }
}

export function parseWorkflowYaml(input: string, sourcePath?: string): Workflow {
  const parsed = parseYaml(input) as unknown
  return normalizeWorkflow(parsed, sourcePath)
}

export function normalizeWorkflow(input: unknown, sourcePath?: string): Workflow {
  const data = asRecord(input, "workflow")
  const id = readID(data.id, "workflow.id")
  const name = readString(data.name, "workflow.name", id)
  const description = readString(data.description, "workflow.description", "")
  const trigger = asRecord(data.trigger ?? {}, "workflow.trigger")
  const defaults = normalizeDefaults(data.defaults ?? {})
  const stepsInput = Array.isArray(data.steps) ? data.steps : fail("workflow.steps must be an array")

  return {
    id,
    name,
    description,
    trigger: {
      aliases: readStringArray(trigger.aliases ?? [], "workflow.trigger.aliases"),
      match: readStringArray(trigger.match ?? [], "workflow.trigger.match"),
    },
    defaults: { ...defaults, async: defaults.async ?? true },
    inputs: normalizeInputs(data.inputs ?? {}),
    steps: stepsInput.map((step, index) => normalizeStep(step, `workflow.steps[${index}]`)),
    provenance: isRecord(data.provenance) ? data.provenance : undefined,
    sourcePath,
  }
}

export function workflowToYaml(workflow: Workflow): string {
  const { sourcePath: _sourcePath, ...plain } = workflow
  return stringify(plain)
}

export function renderTemplate(template: string, input: { inputs: Record<string, unknown>; steps: Record<string, { output?: string }> }) {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath: string) => {
    const path = rawPath.trim().split(".")
    let current: unknown = input as unknown
    for (const part of path) {
      if (!isRecord(current)) return ""
      current = current[part]
    }
    if (current === undefined || current === null) return ""
    if (typeof current === "string") return current
    return JSON.stringify(current)
  })
}

export function resolveStepSettings(defaults: WorkflowDefaults, step: WorkflowStep): StepExecutionSettings {
  return {
    agent: step.agent ?? defaults.agent,
    model: step.model ?? defaults.model,
    async: step.async ?? defaults.async ?? true,
    tools: { ...(defaults.tools ?? {}), ...(step.tools ?? {}) },
    skills: [...(defaults.skills ?? []), ...(step.skills ?? [])],
    system: step.system ?? defaults.system,
    context: step.context ?? defaults.context,
    format: step.format ?? defaults.format,
  }
}

function normalizeStep(input: unknown, path: string): WorkflowStep {
  const data = asRecord(input, path)
  const id = readID(data.id, `${path}.id`)
  const typeValue = data.type ?? (typeof data.prompt === "string" ? "prompt" : undefined)
  const type = typeof typeValue === "string" && STEP_TYPES.has(typeValue) ? (typeValue as WorkflowStep["type"]) : fail(`${path}.type is invalid`)
  const nested = Array.isArray(data.steps) ? data.steps.map((step, index) => normalizeStep(step, `${path}.steps[${index}]`)) : []
  const body = Array.isArray(data.body) ? data.body.map((step, index) => normalizeStep(step, `${path}.body[${index}]`)) : nested
  const planner = data.planner === undefined ? undefined : normalizeStep(data.planner, `${path}.planner`)

  if ((type === "prompt" || type === "summary" || type === "planner") && typeof data.prompt !== "string") {
    fail(`${path}.prompt is required for ${type} steps`)
  }
  if ((type === "serial" || type === "parallel") && nested.length === 0) {
    fail(`${path}.steps must contain at least one step`)
  }
  if (type === "loop" && body.length === 0) fail(`${path}.body or ${path}.steps must contain at least one step`)

  return {
    ...normalizeDefaults(data),
    id,
    type,
    prompt: typeof data.prompt === "string" ? data.prompt : undefined,
    steps: nested,
    planner,
    body,
    maxIterations: readNumber(data.maxIterations, `${path}.maxIterations`, 3),
  }
}

function normalizeDefaults(input: unknown): WorkflowDefaults {
  const data = asRecord(input, "defaults")
  return {
    agent: typeof data.agent === "string" ? data.agent : undefined,
    model: typeof data.model === "string" ? data.model : undefined,
    async: typeof data.async === "boolean" ? data.async : undefined,
    tools: normalizeBooleanMap(data.tools),
    skills: readStringArray(data.skills ?? [], "skills"),
    system: typeof data.system === "string" ? data.system : undefined,
    context: data.context,
    format: data.format,
  }
}

function normalizeInputs(input: unknown) {
  const data = asRecord(input, "workflow.inputs")
  const result: Workflow["inputs"] = {}
  for (const [key, value] of Object.entries(data)) {
    const definition = asRecord(value ?? {}, `workflow.inputs.${key}`)
    result[key] = {
      type: typeof definition.type === "string" ? (definition.type as Workflow["inputs"][string]["type"]) : "string",
      required: definition.required === true,
      description: typeof definition.description === "string" ? definition.description : undefined,
      default: definition.default,
    }
  }
  return result
}

function normalizeBooleanMap(input: unknown) {
  if (input === undefined) return undefined
  const data = asRecord(input, "tools")
  return Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value === true]))
}

function readID(input: unknown, path: string) {
  if (typeof input !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(input)) fail(`${path} must be a safe id`)
  return input
}

function readString(input: unknown, path: string, fallback: string) {
  if (input === undefined) return fallback
  if (typeof input !== "string") fail(`${path} must be a string`)
  return input
}

function readNumber(input: unknown, path: string, fallback: number) {
  if (input === undefined) return fallback
  if (typeof input !== "number" || !Number.isFinite(input)) fail(`${path} must be a number`)
  return Math.max(1, Math.floor(input))
}

function readStringArray(input: unknown, path: string) {
  if (!Array.isArray(input)) fail(`${path} must be an array`)
  return input.filter((item): item is string => typeof item === "string")
}

function asRecord(input: unknown, path: string): Record<string, unknown> {
  if (!isRecord(input)) fail(`${path} must be an object`)
  return input
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}

function fail(message: string): never {
  throw new WorkflowValidationError(message)
}
