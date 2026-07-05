import type { createOpencodeClient } from "@opencode-ai/sdk/v2"

export type JsonObject = { [key: string]: WorkflowValue }
export type WorkflowValue = string | number | boolean | null | WorkflowValue[] | JsonObject

export type WorkflowInputDefinition = {
  type?: "string" | "number" | "boolean" | "object" | "array"
  required?: boolean
  description?: string
  default?: WorkflowValue
}

export type WorkflowDefaults = {
  agent?: string
  model?: string
  async?: boolean
  tools?: Record<string, boolean>
  skills?: string[]
  system?: string
  context?: WorkflowValue
  format?: WorkflowValue
}

export type WorkflowTrigger = {
  aliases?: string[]
  match?: string[]
}

export type StepType = "prompt" | "serial" | "parallel" | "summary" | "planner" | "loop"

type WorkflowStepBase = WorkflowDefaults & {
  id: string
  prompt?: string
}

export type PromptStep = WorkflowStepBase & {
  type: "prompt" | "summary"
  prompt: string
}

export type PlannerStep = WorkflowStepBase & {
  type: "planner"
  prompt: string
  planner?: WorkflowStep
}

export type SerialStep = WorkflowStepBase & {
  type: "serial" | "parallel"
  steps: WorkflowStep[]
}

export type LoopStep = WorkflowStepBase & {
  type: "loop"
  steps?: WorkflowStep[]
  body: WorkflowStep[]
  maxIterations: number
}

export type WorkflowStep = PromptStep | PlannerStep | SerialStep | LoopStep

export type Workflow = {
  id: string
  name: string
  description: string
  trigger?: WorkflowTrigger
  defaults: WorkflowDefaults
  inputs: Record<string, WorkflowInputDefinition>
  steps: WorkflowStep[]
  provenance?: JsonObject
  sourcePath?: string
}

export type WorkflowSource = {
  workflow: Workflow
  path: string
  scope: "global" | "opencode" | "project"
}

export type StepExecutionSettings = Required<Pick<WorkflowDefaults, "tools" | "skills">> &
  Omit<WorkflowDefaults, "tools" | "skills"> & {
    agent?: string
    model?: string
  }

export type WorkflowRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled"

export type WorkflowChildSession = {
  stepID: string
  sessionID: string
  status: WorkflowRunStatus
  output?: string
  error?: string
}

export type WorkflowRun = {
  id: string
  workflowID: string
  parentSessionID: string
  status: WorkflowRunStatus
  async: boolean
  inputs: Record<string, WorkflowValue>
  childSessions: Record<string, WorkflowChildSession>
  result?: string
  error?: string
  logs?: string[]
  createdAt: string
  updatedAt: string
}

export type WorkflowRunRequest = {
  workflowID?: string
  yaml?: string
  inputs?: Record<string, WorkflowValue>
  async?: boolean
}

export type WorkflowRegistry = {
  workflows: WorkflowSource[]
  byID: Map<string, WorkflowSource>
}

export type OpencodeClient = {
  session: ReturnType<typeof createOpencodeClient>["session"]
  v2: ReturnType<typeof createOpencodeClient>["v2"]
}

export type RuntimeContext = {
  client: OpencodeClient
  directory: string
  worktree: string
}

export type ToolRuntimeContext = {
  sessionID: string
  messageID?: string
  agent?: string
  directory: string
  worktree: string
  abort?: AbortSignal
}
