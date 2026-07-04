import { describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { discoverWorkflows } from "../src/discovery.js"

function workflow(name: string) {
  return `id: shared\nname: ${name}\ndescription: test\nsteps:\n  - id: one\n    prompt: hello\n`
}

describe("workflow discovery", () => {
  test("project .workflows override .opencode workflows", async () => {
    const root = await Bun.$`mktemp -d ${join(tmpdir(), "workflow-discovery-XXXXXX")}`.text().then((x) => x.trim())
    try {
      await mkdir(join(root, ".opencode", "workflows"), { recursive: true })
      await mkdir(join(root, ".workflows"), { recursive: true })
      await writeFile(join(root, ".opencode", "workflows", "shared.yaml"), workflow("opencode"))
      await writeFile(join(root, ".workflows", "shared.yaml"), workflow("project"))
      const registry = await discoverWorkflows({ worktree: root, directory: root })
      expect(registry.byID.get("shared")?.workflow.name).toBe("project")
      expect(registry.workflows.some((entry) => entry.workflow.id === "shared")).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
