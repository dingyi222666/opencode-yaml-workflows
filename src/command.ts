export function workflowCommandTemplate() {
  return `You are selecting or creating a YAML workflow for this request: $ARGUMENTS

Call the workflow tool with action="schema" if you need the YAML format. Then call workflow with action="list" to inspect available workflows. If one matches, call workflow with action="run", workflowID, and mapped inputs. If none match, call workflow with action="generate" and the goal, then call workflow with action="run" and the generated YAML. Workflows default to async wake-up and must run as child sessions attached to the current conversation.`
}

export function injectWorkflowCommand(config: { command?: Record<string, unknown> }) {
  config.command ??= {}
  config.command.workflow = {
    description: "Select, generate, and run a YAML workflow.",
    template: workflowCommandTemplate(),
  }
}
