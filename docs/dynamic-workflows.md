# Dynamic Workflows Comparison

[中文](./dynamic-workflows.zh-CN.md) | **English**

Claude Code Dynamic Workflows and `opencode-yaml-workflows` both coordinate multiple agents, but they are built for different habits.

## Claude Code Dynamic Workflows

- Claude writes a JavaScript workflow script for the task.
- The runtime executes that script in the background.
- Loops, branching, and intermediate results live in script variables.
- Runs are managed through Claude Code's `/workflows` UI.
- Saved workflows become commands under `.claude/workflows/` or `~/.claude/workflows/`.
- Best for large one-off work where Claude should design the orchestration at runtime.

## opencode-yaml-workflows

- You write or generate YAML.
- Workflows live in normal project or user config folders.
- Inputs, steps, prompts, models, agents, and tool settings are easy to read and diff.
- Runs create real child sessions under the current parent conversation.
- Best for workflows you want to reuse, review, commit, and share.

Short version: use Claude Dynamic Workflows when the plan should be invented for one big task. Use this plugin when the workflow itself should be a durable project asset.
