import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseWorkflowYaml } from "./parser.js"
import type { WorkflowRegistry, WorkflowSource } from "./types.js"

const WORKFLOW_EXTENSIONS = new Set([".yml", ".yaml"])

export async function discoverWorkflows(input: { worktree: string; directory: string }): Promise<WorkflowRegistry> {
  const roots: Array<{ path: string; scope: WorkflowSource["scope"] }> = [
    { path: join(homedir(), ".config", "opencode", "workflows"), scope: "global" },
    { path: join(input.worktree || input.directory, ".opencode", "workflows"), scope: "opencode" },
    { path: join(input.worktree || input.directory, ".workflows"), scope: "project" },
  ]
  const workflows: WorkflowSource[] = []
  const byID = new Map<string, WorkflowSource>()
  for (const root of roots) {
    for (const path of await listYamlFiles(root.path)) {
      const workflow = parseWorkflowYaml(await readFile(path, "utf8"), path)
      const source = { workflow, path, scope: root.scope }
      workflows.push(source)
      byID.set(workflow.id, source)
    }
  }
  return { workflows: [...byID.values()], byID }
}

async function listYamlFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return []
  const entries = await readdir(root, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...(await listYamlFiles(path)))
    else if (WORKFLOW_EXTENSIONS.has(path.slice(path.lastIndexOf(".")))) result.push(path)
  }
  return result.sort()
}
