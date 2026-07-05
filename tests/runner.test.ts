import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseWorkflowYaml } from "../src/parser.js"
import { loadRun } from "../src/persistence.js"
import { runWorkflow } from "../src/runner.js"
import type { RuntimeContext, ToolRuntimeContext } from "../src/types.js"
import type { OpencodeClient } from "@opencode-ai/sdk/v2"

type TestSessionClient = Partial<Record<keyof OpencodeClient["session"], (...args: any[]) => any>> & {
  wait?: (input: Record<string, unknown>) => Promise<unknown>
}
type TestV2SessionClient = Partial<Record<keyof OpencodeClient["v2"]["session"], (...args: any[]) => any>>

function testRuntime(root: string, session: TestSessionClient, v2Session: TestV2SessionClient = {}): RuntimeContext {
  return {
    directory: root,
    worktree: root,
    client: {
      session: session as RuntimeContext["client"]["session"],
      v2: { session: v2Session as RuntimeContext["client"]["v2"]["session"] } as RuntimeContext["client"]["v2"],
    },
  }
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
      expect(creates[0]).toMatchObject({ parentID: "parent-1", title: "workflow:run-me/one", directory: root, agent: "general" })
      expect(prompts[0]).toMatchObject({ sessionID: "child-1", directory: root, agent: "general", tools: { bash: false, grep: true } })
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
    const waits: unknown[] = []
    const runtime = testRuntime(root, {
          get: async () => ({ data: { id: "parent-1", directory: "/parent/repo" } }),
          create: async (input) => {
            creates.push(input)
            return { id: "child-1", directory: "/parent/repo" }
          },
          prompt: async (input) => {
            prompts.push(input)
            return {}
          },
          promptAsync: async (input) => {
            prompts.push(input)
            return {}
          },
          wait: async (input) => {
            waits.push(input)
            return undefined
          },
          messages: async () => ({ data: [{ parts: [{ text: "async output" }] }] }),
        }, { wait: async (input) => {
          waits.push(input)
          return { error: { _tag: "ServiceUnavailableError", message: "Session wait is not available yet", service: "session.wait" }, request: { timeout: false }, response: { status: 503 } }
        } })
    const tool: ToolRuntimeContext = { sessionID: "parent-1", directory: root, worktree: root }
    try {
      const run = await runWorkflow({ runtime, tool, workflow: parseWorkflowYaml(yaml), inputs: {} })
      expect(run.async).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(creates[0]).toMatchObject({ parentID: "parent-1", title: "workflow:run-me/one", directory: "/parent/repo", agent: "general" })
      expect(prompts[0]).toMatchObject({ sessionID: "child-1", directory: "/parent/repo" })
      expect(JSON.stringify(prompts[0])).toContain(`Target repository directory:\\n${root}`)
      expect(waits).toHaveLength(0)
      expect(prompts[1]).toMatchObject({ sessionID: "parent-1", directory: "/parent/repo", noReply: false })
      expect(JSON.stringify(prompts[1])).toContain("Workflow stage completed: one")
      expect(JSON.stringify(prompts[1])).toContain("workflow is still running")
      expect(prompts[2]).toMatchObject({ sessionID: "parent-1", directory: "/parent/repo", noReply: false })
      expect(JSON.stringify(prompts[2])).toContain("async output")
      expect(JSON.stringify(prompts[1])).not.toContain("Child prompt reached terminal signal")
      expect(JSON.stringify(prompts[1])).not.toContain("<task")
      const stored = await loadRun(root, run.id)
      expect(stored.result).toContain("async output")
      expect(stored.childSessions.one).toMatchObject({ sessionID: "child-1", status: "completed", output: "async output" })
      expect(stored.logs?.join("\n")).toContain("Child prompt reached terminal signal")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("validates required workflow inputs before creating sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-run-"))
    const creates: unknown[] = []
    const requiredYaml = `
id: needs-input
inputs:
  task:
    required: true
steps:
  - id: one
    prompt: hello {{ inputs.task }}
`
    const runtime = testRuntime(root, {
      create: async (input) => {
        creates.push(input)
        return { id: "child-1" }
      },
    })
    try {
      await expect(runWorkflow({ runtime, tool: { sessionID: "parent-1", directory: root, worktree: root }, workflow: parseWorkflowYaml(requiredYaml), inputs: {} })).rejects.toThrow('Missing required workflow input "task"')
      expect(creates).toHaveLength(0)
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
      expect(creates[0]).toMatchObject({ parentID: "parent-1", directory: root })
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

  test("does not mark async child prompt SDK error envelopes as completed", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-run-"))
    const prompts: unknown[] = []
    const runtime = testRuntime(root, {
      create: async () => ({ id: "child-err" }),
      prompt: async (input) => {
        prompts.push(input)
        return { error: { code: "SESSION_BUSY", message: "session is busy" }, request: { timeout: false }, response: { status: 409 } }
      },
    })
    try {
      const run = await runWorkflow({ runtime, tool: { sessionID: "parent-1", directory: root, worktree: root }, workflow: parseWorkflowYaml(yaml), inputs: {}, async: true })
      expect(run.async).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 25))
      const stored = await loadRun(root, run.id)
      expect(stored.status).toBe("failed")
      expect(stored.error).toContain("SESSION_BUSY")
      expect(stored.childSessions.one?.status).toBe("failed")
      expect(stored.childSessions.one?.sessionID).toBe("child-err")
      const parentPrompt = prompts.find((input) => (input as { sessionID?: string }).sessionID === "parent-1")
      expect(JSON.stringify(parentPrompt)).toContain("SESSION_BUSY")
      expect(JSON.stringify(parentPrompt)).not.toContain("Prompt input")
      expect(JSON.stringify(parentPrompt)).not.toContain("Request:")
      expect(JSON.stringify(parentPrompt)).not.toContain("<task")
      const logs = stored.logs?.join("\n") ?? ""
      expect(logs).toContain("Creating direct child session")
      expect(logs).toContain("Step attempt failed")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("serial async steps wait for prior child prompt before starting next step", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-run-"))
    const creates: unknown[] = []
    const prompts: unknown[] = []
    let resolveFirst: (() => void) | undefined
    const firstPromptDone = new Promise<void>((resolve) => {
      resolveFirst = resolve
    })
    const serialYaml = `
id: serial-run
steps:
  - id: first
    prompt: first
  - id: second
    prompt: second sees {{ steps.first.output }}
`
    const runtime = testRuntime(root, {
      create: async (input) => {
        creates.push(input)
        return { id: `child-${creates.length}`, directory: root }
      },
      prompt: async (input) => {
        prompts.push(input)
        if ((input as { sessionID?: string }).sessionID === "child-1") await firstPromptDone
        return { data: { parts: [{ text: `output-${(input as { sessionID?: string }).sessionID}` }] } }
      },
      promptAsync: async () => ({}),
      messages: async (input) => ({ data: [{ parts: [{ text: `messages-${(input as { sessionID?: string }).sessionID}` }] }] }),
    })
    try {
      const run = await runWorkflow({ runtime, tool: { sessionID: "parent-1", directory: root, worktree: root }, workflow: parseWorkflowYaml(serialYaml), inputs: {}, async: true })
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(creates).toHaveLength(1)
      expect(prompts.some((input) => (input as { sessionID?: string }).sessionID === "child-2")).toBe(false)
      resolveFirst?.()
      await new Promise((resolve) => setTimeout(resolve, 25))
      expect(creates).toHaveLength(2)
      expect(prompts.some((input) => (input as { sessionID?: string }).sessionID === "child-2")).toBe(true)
      const stored = await loadRun(root, run.id)
      expect(stored.status).toBe("completed")
      expect(stored.result).toContain("messages-child-1")
      expect(stored.result).toContain("messages-child-2")
    } finally {
      resolveFirst?.()
      await rm(root, { recursive: true, force: true })
    }
  })
})
