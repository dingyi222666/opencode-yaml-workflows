import { describe, expect, test } from "bun:test"
import { parseWorkflowYaml, renderTemplate, resolveStepSettings } from "../src/parser.js"

const workflowYaml = `
id: review
name: Review
description: Review workflow
defaults:
  agent: general
  model: anthropic/claude-sonnet-4-6
  tools:
    bash: true
    edit: false
  skills:
    - base
inputs:
  task:
    type: string
    required: true
steps:
  - id: plan
    prompt: Plan {{ inputs.task }}
    agent: build
    model: openai/gpt-5
    tools:
      grep: true
    skills:
      - repo
`

describe("workflow parser", () => {
  test("normalizes YAML and defaults async to true", () => {
    const workflow = parseWorkflowYaml(workflowYaml)
    expect(workflow.id).toBe("review")
    expect(workflow.defaults.async).toBe(true)
    expect(workflow.steps[0]?.type).toBe("prompt")
  })

  test("merges step model, tool, and skill overrides", () => {
    const workflow = parseWorkflowYaml(workflowYaml)
    const settings = resolveStepSettings(workflow.defaults, workflow.steps[0]!)
    expect(settings.agent).toBe("build")
    expect(settings.model).toBe("openai/gpt-5")
    expect(settings.tools).toEqual({ bash: true, edit: false, grep: true })
    expect(settings.skills).toEqual(["base", "repo"])
  })

  test("renders input and step output templates", () => {
    expect(renderTemplate("A {{ inputs.task }} B {{ steps.plan.output }}", { inputs: { task: "x" }, steps: { plan: { output: "done" } } })).toBe("A x B done")
  })
})
