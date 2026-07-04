import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { injectWorkflowCommand } from "./command.js"
import { createWorkflowTools } from "./tools.js"

export { injectWorkflowCommand, workflowCommandTemplate } from "./command.js"
export { discoverWorkflows } from "./discovery.js"
export { parseWorkflowYaml, normalizeWorkflow, renderTemplate, resolveStepSettings, WorkflowValidationError } from "./parser.js"
export { saveRun, loadRun, saveWorkflow } from "./persistence.js"
export { runWorkflow, statusWorkflow, cancelWorkflow } from "./runner.js"
export { WORKFLOW_SCHEMA_TEXT } from "./schema.js"
export type * from "./types.js"

const server: Plugin = async ({ directory, worktree, serverUrl }) => {
  const previousNoProxy = {
    no_proxy: process.env.no_proxy,
    NO_PROXY: process.env.NO_PROXY,
  }
  ensureNoProxyFor(serverUrl)
  const client = createOpencodeClient({ baseUrl: normalizeServerUrl(serverUrl), directory })
  return {
    dispose: async () => {
      restoreEnv("no_proxy", previousNoProxy.no_proxy)
      restoreEnv("NO_PROXY", previousNoProxy.NO_PROXY)
    },
    config: async (config) => {
      injectWorkflowCommand(config)
    },
    tool: createWorkflowTools({ client, directory, worktree }),
  }
}

function normalizeServerUrl(input: URL) {
  const url = new URL(input.toString())
  if (url.hostname === "0.0.0.0" || url.hostname === "::") url.hostname = "127.0.0.1"
  return url.toString().replace(/\/$/, "")
}

function ensureNoProxyFor(input: URL) {
  const entries = new Set<string>()
  for (const current of [process.env.no_proxy, process.env.NO_PROXY]) {
    for (const item of (current ?? "").split(",")) {
      const value = item.trim()
      if (value) entries.add(value)
    }
  }
  entries.add(input.hostname)
  if (input.hostname === "0.0.0.0" || input.hostname === "::") {
    entries.add("127.0.0.1")
    entries.add("localhost")
    entries.add("0.0.0.0")
  }
  const next = Array.from(entries).join(",")
  process.env.no_proxy = next
  process.env.NO_PROXY = next
}

function restoreEnv(key: "no_proxy" | "NO_PROXY", value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

export default { id: "opencode-yaml-workflows", server } satisfies PluginModule
export { server }
