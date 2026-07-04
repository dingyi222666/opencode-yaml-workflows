import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { workflowToYaml } from "./parser.js"
import type { Workflow, WorkflowRun } from "./types.js"

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

export function createRunID() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function runsDir(worktree: string) {
  return join(worktree, ".opencode", "workflows", "runs")
}

export async function saveRun(worktree: string, run: WorkflowRun) {
  const path = runPath(worktree, run.id)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ ...run, updatedAt: new Date().toISOString() }, null, 2))
}

export async function loadRun(worktree: string, runID: string): Promise<WorkflowRun> {
  assertSafeID(runID)
  return JSON.parse(await readFile(runPath(worktree, runID), "utf8")) as WorkflowRun
}

export async function saveWorkflow(input: { worktree: string; workflow: Workflow; location: "opencode" | "project"; saveAs?: string }) {
  const id = input.saveAs ?? input.workflow.id
  assertSafeID(id)
  const root = input.location === "opencode" ? join(input.worktree, ".opencode", "workflows") : join(input.worktree, ".workflows")
  const path = join(root, `${id}.yaml`)
  const workflow: Workflow = {
    ...input.workflow,
    id,
    provenance: {
      ...(input.workflow.provenance ?? {}),
      savedAt: new Date().toISOString(),
    },
  }
  await mkdir(root, { recursive: true })
  await writeFile(path, workflowToYaml(workflow))
  return path
}

export function assertSafeID(id: string) {
  if (!SAFE_ID.test(id) || id.includes("..") || id.includes("/") || id.includes("\\")) throw new Error(`Unsafe workflow id: ${id}`)
}

function runPath(worktree: string, runID: string) {
  assertSafeID(runID)
  return join(runsDir(worktree), `${runID}.json`)
}
