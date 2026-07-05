import { parse as parseYaml, stringify } from "yaml"
import type {
  JsonObject,
  StepExecutionSettings,
  StepType,
  Workflow,
  WorkflowDefaults,
  WorkflowInputDefinition,
  WorkflowStep,
  WorkflowValue,
} from "./types.js"

const STEP_TYPES: StepType[] = ["prompt", "serial", "parallel", "summary", "planner", "loop"]
const INPUT_TYPES: Array<NonNullable<WorkflowInputDefinition["type"]>> = ["string", "number", "boolean", "object", "array"]

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "WorkflowValidationError"
  }
}

export function parseWorkflowYaml(input: string, sourcePath?: string): Workflow {
  return normalizeWorkflow(parseYaml(input), sourcePath)
}

export function normalizeWorkflow(input: unknown, sourcePath?: string): Workflow {
  const data = object(input, "workflow")
  const id = safeID(data.id, "workflow.id")
  const defaults = data.defaults === undefined ? {} : normalizeDefaults(data.defaults, "workflow.defaults")
  defaults.async ??= true

  return {
    id,
    name: optionalString(data.name, "workflow.name") ?? id,
    description: optionalString(data.description, "workflow.description") ?? "",
    trigger: data.trigger === undefined ? undefined : normalizeTrigger(data.trigger),
    defaults,
    inputs: data.inputs === undefined ? {} : normalizeInputs(data.inputs),
    steps: stepArray(data.steps, "workflow.steps"),
    provenance: data.provenance === undefined ? undefined : jsonObject(data.provenance, "workflow.provenance"),
    sourcePath,
  }
}

export function workflowToYaml(workflow: Workflow): string {
  const { sourcePath: _sourcePath, ...plain } = workflow
  return stringify(plain)
}

export function renderTemplate(template: string, input: { inputs: Record<string, WorkflowValue>; steps: Record<string, { output?: string }> }) {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath: string) => {
    let current: unknown = input
    for (const part of rawPath.trim().split(".")) {
      if (!isObject(current)) return ""
      current = current[part]
    }
    if (current === undefined || current === null) return ""
    return typeof current === "string" ? current : JSON.stringify(current)
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

function normalizeTrigger(input: unknown): Workflow["trigger"] {
  const data = object(input, "workflow.trigger")
  return {
    aliases: data.aliases === undefined ? undefined : stringArray(data.aliases, "workflow.trigger.aliases"),
    match: data.match === undefined ? undefined : stringArray(data.match, "workflow.trigger.match"),
  }
}

function normalizeStep(input: unknown, path: string): WorkflowStep {
  const data = object(input, path)
  const id = safeID(data.id, `${path}.id`)
  const type = stepType(data.type, data.prompt, `${path}.type`)
  const base = { ...normalizeDefaults(data, path), id }

  if (type === "prompt" || type === "summary") {
    return { ...base, type, prompt: requiredString(data.prompt, `${path}.prompt`) }
  }
  if (type === "planner") {
    return {
      ...base,
      type,
      prompt: requiredString(data.prompt, `${path}.prompt`),
      planner: data.planner === undefined ? undefined : normalizeStep(data.planner, `${path}.planner`),
    }
  }
  if (type === "serial" || type === "parallel") {
    return { ...base, type, steps: stepArray(data.steps, `${path}.steps`) }
  }
  return {
    ...base,
    type,
    steps: data.steps === undefined ? undefined : stepArray(data.steps, `${path}.steps`),
    body: stepArray(data.body ?? data.steps, data.body === undefined ? `${path}.steps` : `${path}.body`),
    maxIterations: optionalPositiveInteger(data.maxIterations, `${path}.maxIterations`) ?? 3,
  }
}

function normalizeDefaults(input: unknown, path: string): WorkflowDefaults {
  const data = object(input, path)
  return {
    agent: optionalString(data.agent, `${path}.agent`),
    model: optionalString(data.model, `${path}.model`),
    async: optionalBoolean(data.async, `${path}.async`),
    tools: data.tools === undefined ? undefined : booleanMap(data.tools, `${path}.tools`),
    skills: data.skills === undefined ? undefined : stringArray(data.skills, `${path}.skills`),
    system: optionalString(data.system, `${path}.system`),
    context: data.context === undefined ? undefined : jsonValue(data.context, `${path}.context`),
    format: data.format === undefined ? undefined : jsonValue(data.format, `${path}.format`),
  }
}

function normalizeInputs(input: unknown): Workflow["inputs"] {
  const data = object(input, "workflow.inputs")
  const result: Workflow["inputs"] = {}
  for (const [name, raw] of Object.entries(data)) {
    const item = object(raw, `workflow.inputs.${name}`)
    const type = item.type === undefined ? "string" : inputType(item.type, `workflow.inputs.${name}.type`)
    result[name] = {
      type,
      required: item.required === undefined ? false : requiredBoolean(item.required, `workflow.inputs.${name}.required`),
      description: optionalString(item.description, `workflow.inputs.${name}.description`),
      default: item.default === undefined ? undefined : jsonValue(item.default, `workflow.inputs.${name}.default`),
    }
  }
  return result
}

function stepArray(input: unknown, path: string) {
  if (!Array.isArray(input) || input.length === 0) throw new WorkflowValidationError(`${path} must be a non-empty array`)
  return input.map((step, index) => normalizeStep(step, `${path}[${index}]`))
}

function booleanMap(input: unknown, path: string) {
  const data = object(input, path)
  const result: Record<string, boolean> = {}
  for (const [key, value] of Object.entries(data)) result[key] = requiredBoolean(value, `${path}.${key}`)
  return result
}

function stringArray(input: unknown, path: string) {
  if (!Array.isArray(input)) throw new WorkflowValidationError(`${path} must be an array`)
  return input.map((value, index) => requiredString(value, `${path}[${index}]`))
}

function stepType(input: unknown, prompt: unknown, path: string): StepType {
  if (input === undefined && typeof prompt === "string") return "prompt"
  if (typeof input !== "string" || !STEP_TYPES.includes(input as StepType)) throw new WorkflowValidationError(`${path} must be one of: ${STEP_TYPES.join(", ")}`)
  return input as StepType
}

function inputType(input: unknown, path: string): WorkflowInputDefinition["type"] {
  if (typeof input !== "string" || !INPUT_TYPES.includes(input as NonNullable<WorkflowInputDefinition["type"]>)) {
    throw new WorkflowValidationError(`${path} must be one of: ${INPUT_TYPES.join(", ")}`)
  }
  return input as WorkflowInputDefinition["type"]
}

function safeID(input: unknown, path: string) {
  const value = requiredString(input, path)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value)) throw new WorkflowValidationError(`${path} must be a safe id`)
  return value
}

function optionalString(input: unknown, path: string) {
  if (input === undefined) return undefined
  return requiredString(input, path)
}

function requiredString(input: unknown, path: string) {
  if (typeof input !== "string") throw new WorkflowValidationError(`${path} must be a string`)
  return input
}

function optionalBoolean(input: unknown, path: string) {
  if (input === undefined) return undefined
  return requiredBoolean(input, path)
}

function requiredBoolean(input: unknown, path: string) {
  if (typeof input !== "boolean") throw new WorkflowValidationError(`${path} must be a boolean`)
  return input
}

function optionalPositiveInteger(input: unknown, path: string) {
  if (input === undefined) return undefined
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1) throw new WorkflowValidationError(`${path} must be a positive integer`)
  return input
}

function jsonObject(input: unknown, path: string) {
  const value = jsonValue(input, path)
  if (!isObject(value)) throw new WorkflowValidationError(`${path} must be an object`)
  return value
}

function jsonValue(input: unknown, path: string): WorkflowValue {
  if (input === null || typeof input === "string" || typeof input === "number" || typeof input === "boolean") return input
  if (Array.isArray(input)) return input.map((value, index) => jsonValue(value, `${path}[${index}]`))
  if (isObject(input)) return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, jsonValue(value, `${path}.${key}`)]))
  throw new WorkflowValidationError(`${path} must be JSON-compatible`)
}

function object(input: unknown, path: string) {
  if (!isObject(input)) throw new WorkflowValidationError(`${path} must be an object`)
  return input
}

function isObject(input: unknown): input is JsonObject {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
