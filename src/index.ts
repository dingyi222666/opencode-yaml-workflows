import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createOpencodeClient as createOpencodeV2Client } from "@opencode-ai/sdk/v2"
import { injectWorkflowCommand } from "./command.js"
import { createWorkflowTools } from "./tools.js"

export { injectWorkflowCommand, workflowCommandTemplate } from "./command.js"
export { discoverWorkflows } from "./discovery.js"
export { parseWorkflowYaml, normalizeWorkflow, renderTemplate, resolveStepSettings, WorkflowValidationError } from "./parser.js"
export { saveRun, loadRun, saveWorkflow } from "./persistence.js"
export { runWorkflow, statusWorkflow, cancelWorkflow } from "./runner.js"
export { WORKFLOW_SCHEMA_TEXT } from "./schema.js"
export type * from "./types.js"

const server: Plugin = async ({ client, directory, worktree, serverUrl }) => {
  const v2Client = createOpencodeV2Client({ baseUrl: serverUrl.toString(), directory })
  return {
    config: async (config) => {
      injectWorkflowCommand(config)
    },
    tool: createWorkflowTools({ client, v2Client, directory, worktree }),
  }
}

export default { id: "opencode-yaml-workflows", server } satisfies PluginModule
export { server }
