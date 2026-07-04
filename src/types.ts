import type { createOpencodeClient } from "@opencode-ai/sdk"

export type WorkflowInputDefinition = {
  type?: "string" | "number" | "boolean" | "object" | "array"
  required?: boolean
  description?: string
  default?: unknown
}

export type WorkflowDefaults = {
  agent?: string
  model?: string
  async?: boolean
  tools?: Record<string, boolean>
  skills?: string[]
  system?: string
  context?: unknown
  format?: unknown
}

export type WorkflowTrigger = {
  aliases: string[]
  match: string[]
}

export type StepType = "prompt" | "serial" | "parallel" | "summary" | "planner" | "loop"

export type WorkflowStep = WorkflowDefaults & {
  id: string
  type: StepType
  prompt?: string
  steps: WorkflowStep[]
  planner?: WorkflowStep
  body: WorkflowStep[]
  maxIterations: number
}

export type Workflow = {
  id: string
  name: string
  description: string
  trigger: WorkflowTrigger
  defaults: WorkflowDefaults
  inputs: Record<string, WorkflowInputDefinition>
  steps: WorkflowStep[]
  provenance?: Record<string, unknown>
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
  inputs: Record<string, unknown>
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
  inputs?: Record<string, unknown>
  async?: boolean
}

export type WorkflowRegistry = {
  workflows: WorkflowSource[]
  byID: Map<string, WorkflowSource>
}

export type OpencodeClient = {
  session: ReturnType<typeof createOpencodeClient>["session"] & {
    wait?(input: Record<string, unknown>): Promise<unknown>
  }
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
