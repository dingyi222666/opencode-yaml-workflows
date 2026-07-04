import { describe, expect, test } from "bun:test"
import { WORKFLOW_SCHEMA_TEXT } from "../src/schema.js"
import { createWorkflowTools } from "../src/tools.js"
import type { RuntimeContext, ToolRuntimeContext } from "../src/types.js"

describe("workflow schema action", () => {
  test("returns the workflow YAML format", async () => {
    const runtime: RuntimeContext = {
      directory: "/tmp",
      worktree: "/tmp",
      client: { session: { create: async () => ({ id: "child" }) } },
    }
    const context: ToolRuntimeContext = { sessionID: "parent", directory: "/tmp", worktree: "/tmp" }
    const result = await createWorkflowTools(runtime).workflow.execute({ action: "schema" }, context)
    expect(result).toBe(WORKFLOW_SCHEMA_TEXT)
    expect(result).toContain("YAML Workflow Format")
    expect(result).toContain("action=run defaults to async true")
  })
})
