import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseWorkflowYaml } from "../src/parser.js"
import { saveWorkflow } from "../src/persistence.js"

const yaml = `
id: save-me
name: Save Me
description: Test
steps:
  - id: one
    prompt: hello
`

describe("workflow persistence", () => {
  test("saves workflows safely under project workflows", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-save-"))
    try {
      const path = await saveWorkflow({ worktree: root, workflow: parseWorkflowYaml(yaml), location: "project", saveAs: "saved" })
      expect(path).toEndWith(join(".workflows", "saved.yaml"))
      expect(await readFile(path, "utf8")).toContain("id: saved")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects unsafe save ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-save-"))
    try {
      await expect(saveWorkflow({ worktree: root, workflow: parseWorkflowYaml(yaml), location: "project", saveAs: "../bad" })).rejects.toThrow("Unsafe workflow id")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
