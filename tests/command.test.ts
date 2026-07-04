import { describe, expect, test } from "bun:test"
import { injectWorkflowCommand, workflowCommandTemplate } from "../src/command.js"

describe("workflow command", () => {
  test("registers /workflow command template", () => {
    const config: { command?: Record<string, unknown> } = {}
    injectWorkflowCommand(config)
    expect(config.command?.workflow).toBeTruthy()
    expect(workflowCommandTemplate()).toContain("workflow tool")
    expect(workflowCommandTemplate()).toContain('action="schema"')
    expect(workflowCommandTemplate()).toContain('action="list"')
    expect(workflowCommandTemplate()).toContain('action="generate"')
    expect(workflowCommandTemplate()).toContain('action="run"')
  })
})
