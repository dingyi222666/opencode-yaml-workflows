import { describe, expect, test } from "bun:test"
import { injectWorkflowCommand, markWorkflowAsPrimaryTool, workflowCommandTemplate } from "../src/command.js"

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

  test("marks workflow as a primary-only tool for task subagents", () => {
    const config: { experimental?: { primary_tools?: string[] } } = {
      experimental: { primary_tools: ["existing", "workflow"] },
    }
    markWorkflowAsPrimaryTool(config)
    expect(config.experimental?.primary_tools).toEqual(["existing", "workflow"])
  })
})
