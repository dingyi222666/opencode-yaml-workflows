import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseWorkflowYaml } from "../src/parser.js"
import { loadRun } from "../src/persistence.js"
import { runWorkflow } from "../src/runner.js"
import type { RuntimeContext, ToolRuntimeContext } from "../src/types.js"
import type { OpencodeClient } from "@opencode-ai/sdk"

type TestSessionClient = Partial<Record<keyof OpencodeClient["session"], (...args: any[]) => any>> & {
  wait?: (input: Record<string, unknown>) => Promise<unknown>
}

function testRuntime(root: string, session: TestSessionClient): RuntimeContext {
  return { directory: root, worktree: root, client: { session: session as RuntimeContext["client"]["session"] } }
}

const yaml = `
id: run-me
name: Run Me
description: Test
defaults:
  agent: general
  model: anthropic/claude-sonnet-4-6
  tools:
    bash: false
  skills:
    - base
steps:
  - id: one
    prompt: hello {{ inputs.name }}
    model: openai/gpt-5
    tools:
      grep: true
    skills:
      - extra
`

describe("workflow runner", () => {
  test("creates child sessions with parentID and sync execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-run-"))
    const creates: unknown[] = []
    const prompts: unknown[] = []
    const runtime = testRuntime(root, {
          create: async (input) => {
            creates.push(input)
            return { id: "child-1" }
          },
          prompt: async (input) => {
            prompts.push(input)
            return { data: { parts: [{ text: "ok" }] } }
          },
          wait: async () => undefined,
          messages: async () => ({ data: [{ parts: [{ text: "child output" }] }] }),
        })
    const tool: ToolRuntimeContext = { sessionID: "parent-1", directory: root, worktree: root }
    try {
      const run = await runWorkflow({ runtime, tool, workflow: parseWorkflowYaml(yaml), inputs: { name: "task" }, async: false })
      expect(run.status).toBe("completed")
      expect(creates).toHaveLength(1)
      expect(creates[0]).toMatchObject({ body: { parentID: "parent-1", title: "workflow:run-me/one" }, query: { directory: root } })
      expect(prompts[0]).toMatchObject({ path: { id: "child-1" }, query: { directory: root }, body: { agent: "general", tools: { bash: false, grep: true } } })
      expect(JSON.stringify(prompts[0])).toContain("base")
      expect(JSON.stringify(prompts[0])).toContain("extra")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("defaults to async and wakes parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-run-"))
    const prompts: unknown[] = []
    const creates: unknown[] = []
    const runtime = testRuntime(root, {
          create: async (input) => {
            creates.push(input)
            return { id: "child-1" }
          },
          prompt: async (input) => {
            prompts.push(input)
            return prompts.length === 1
              ? { data: { parts: [{ text: '<task id="child-subtask" state="completed">\n<task_result>async output</task_result>\n</task>' }] } }
              : {}
          },
          messages: async () => ({ data: [{ parts: [{ text: "async output" }] }] }),
        })
    const tool: ToolRuntimeContext = { sessionID: "parent-1", directory: root, worktree: root }
    try {
      const run = await runWorkflow({ runtime, tool, workflow: parseWorkflowYaml(yaml), inputs: {} })
      expect(run.async).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(creates).toHaveLength(0)
      expect(prompts[0]).toMatchObject({ path: { id: "parent-1" }, query: { directory: root } })
      expect(JSON.stringify(prompts[0])).toContain('"type":"subtask"')
      expect(JSON.stringify(prompts[0])).toContain("workflow:run-me/one")
      expect(JSON.stringify(prompts)).toContain("parent-1")
      expect(JSON.stringify(prompts)).toContain("workflow:run-me")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("sync execution keeps direct child-session fallback", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-run-"))
    const creates: unknown[] = []
    const runtime = testRuntime(root, {
          create: async (input) => {
            creates.push(input)
            return { id: "child-1" }
          },
          prompt: async () => ({ data: { parts: [{ text: "ok" }] } }),
          messages: async () => ({ data: [{ parts: [{ text: "ok" }] }] }),
        })
    try {
      await runWorkflow({ runtime, tool: { sessionID: "parent-1", directory: root, worktree: root }, workflow: parseWorkflowYaml(yaml), inputs: {}, async: false })
      expect(creates[0]).toMatchObject({ body: { parentID: "parent-1" }, query: { directory: root } })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("fails fast without parent session", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-run-"))
    const runtime = testRuntime(root, { create: async () => ({ id: "x" }) })
    try {
      await expect(runWorkflow({ runtime, tool: { sessionID: "", directory: root, worktree: root }, workflow: parseWorkflowYaml(yaml), inputs: {} })).rejects.toThrow("parent sessionID")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("omits tool overrides when tools are not configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-run-"))
    const prompts: unknown[] = []
    const runtime = testRuntime(root, {
          create: async () => ({ id: "child-1" }),
          prompt: async (input) => {
            prompts.push(input)
            return { data: { parts: [{ text: "ok" }] } }
          },
          messages: async () => ({ data: [{ parts: [{ text: "ok" }] }] }),
        })
    const noToolsYaml = `
id: no-tools
steps:
  - id: one
    prompt: hello
`
    try {
      await runWorkflow({ runtime, tool: { sessionID: "parent-1", directory: root, worktree: root }, workflow: parseWorkflowYaml(noToolsYaml), inputs: {}, async: false })
      expect((prompts[0] as { body?: Record<string, unknown> }).body).not.toHaveProperty("tools")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("records detailed child session creation failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-run-"))
    const runtime = testRuntime(root, {
          create: async () => ({ error: { code: "NO_AGENT", message: "agent not found" } }),
          prompt: async () => ({ data: { parts: [{ text: "unused" }] } }),
        })
    try {
      const run = await runWorkflow({ runtime, tool: { sessionID: "parent-1", directory: root, worktree: root }, workflow: parseWorkflowYaml(yaml), inputs: {}, async: false })
      expect(run.status).toBe("failed")
      expect(run.error).toContain("Failed to create child session for step one")
      expect(run.error).toContain("NO_AGENT")
      const stored = await loadRun(root, run.id)
      expect(stored.logs?.join("\n")).toContain("Creating direct child session")
      expect(stored.logs?.join("\n")).toContain("Step failed")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not mark subtask SDK error envelopes as completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-run-"))
    const runtime = testRuntime(root, {
          create: async () => ({ id: "should-not-fallback" }),
          prompt: async () => ({ error: { code: "SESSION_BUSY", message: "session is busy" }, request: { timeout: false }, response: { status: 409 } }),
        })
    try {
      const run = await runWorkflow({ runtime, tool: { sessionID: "parent-1", directory: root, worktree: root }, workflow: parseWorkflowYaml(yaml), inputs: {}, async: true })
      expect(run.async).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 25))
      const stored = await loadRun(root, run.id)
      expect(stored.status).toBe("failed")
      expect(stored.error).toContain("SESSION_BUSY")
      expect(stored.childSessions.one?.status).toBe("failed")
      const logs = stored.logs?.join("\n") ?? ""
      expect(logs).toContain("Native subtask execution failed")
      expect(logs).not.toContain("Creating direct child session")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
