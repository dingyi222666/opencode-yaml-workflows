# opencode-yaml-workflows

[中文](./README.zh-CN.md) ｜ **English**

YAML workflows for opencode, executed as child-session subagents with async wake-up by default.

## What It Does

- Loads reusable workflow definitions from YAML files.
- Exposes one model-callable `workflow` tool with `action` values for listing, running, generating, saving, checking, resuming, and cancelling workflows.
- Registers `/workflow <request>` so users can ask the active model to choose or generate the right workflow.
- Runs every model step as a child session using `parentID`, so workflow workers appear under the current conversation like subagents.
- Defaults to async execution: the tool returns a run id quickly, continues in the background, then wakes the parent session when complete.

## Install

For local development, install dependencies and build:

```bash
bun install
bun run build
```

Then reference this project from your opencode config:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-yaml-workflows"]
}
```

After changing plugin code or opencode config, restart opencode.

## Workflow Locations

The plugin discovers workflow YAML files from these locations:

- Global: `~/.config/opencode/workflows/**/*.yaml` and `~/.config/opencode/workflows/**/*.yml`
- Project opencode: `.opencode/workflows/**/*.yaml` and `.opencode/workflows/**/*.yml`
- Project local: `.workflows/**/*.yaml` and `.workflows/**/*.yml`

Project-local `.workflows` entries override `.opencode/workflows` entries with the same workflow id.

## Quick Start

Create `.workflows/review.yaml`:

```yaml
id: review
name: Code Review
description: Review a change with parallel specialists and a final summary.

trigger:
  aliases:
    - review
    - code review
  match:
    - review this
    - audit changes

defaults:
  agent: general
  model: anthropic/claude-sonnet-4-6
  async: true
  tools:
    bash: false
    grep: true
    read: true
  skills:
    - repo-analysis

inputs:
  task:
    type: string
    required: true
    description: What should be reviewed.

steps:
  - id: plan
    type: prompt
    agent: build
    model: anthropic/claude-sonnet-4-6
    system: Create concise implementation-focused plans.
    context:
      notes: Focus on bugs, regressions, and missing tests.
    format:
      type: text
    prompt: |
      Create a review plan for: {{ inputs.task }}

  - id: specialists
    type: parallel
    steps:
      - id: correctness
        agent: general
        model: anthropic/claude-sonnet-4-6
        prompt: |
          Check correctness risks using this plan:
          {{ steps.plan.output }}
      - id: tests
        agent: general
        model: openai/gpt-5
        tools:
          grep: true
          read: true
        skills:
          - testing
        prompt: |
          Check missing tests using this plan:
          {{ steps.plan.output }}

  - id: final-summary
    type: summary
    agent: build
    prompt: |
      Summarize the review findings.
      Correctness: {{ steps.correctness.output }}
      Tests: {{ steps.tests.output }}
```

Run it manually:

```text
/workflow review the current diff
```

The active model should inspect available workflows, map your request into inputs, then call `workflow` with `action: "run"`.

## YAML Schema

Top-level fields:

- `id`: safe workflow id, used for discovery and execution.
- `name`: optional display name. Defaults to `id`.
- `description`: optional model-readable description used for workflow selection.
- `trigger.aliases` and `trigger.match`: hints for `/workflow` routing.
- `defaults`: optional fallback `agent`, `model`, `async`, `tools`, `skills`, `system`, `context`, and `format`.
- `inputs`: input definitions consumed by prompt templates.
- `steps`: ordered workflow steps.

Step fields:

- `id`: safe step id, referenced as `{{ steps.<id>.output }}`.
- `type`: `prompt`, `serial`, `parallel`, `summary`, `planner`, or `loop`. If omitted and `prompt` is present, it defaults to `prompt`.
- `prompt`: prompt text for model-running steps.
- `steps`: nested steps for `serial` and `parallel`.
- `body`: loop body for `loop` steps.
- `maxIterations`: hard cap for `loop`.
- `agent`, `model`, `tools`, `skills`, `system`, `context`, `format`: optional per-step overrides. Missing values use workflow defaults or opencode's current/default behavior.

If `tools` is omitted, the plugin does not send a tool override. That means opencode's default tool availability remains available; omitted `tools` does not mean all tools are disabled.

Template variables:

- `{{ inputs.task }}` reads workflow input `task`.
- `{{ steps.plan.output }}` reads a previous step output.

## Step Types

- `prompt`: creates one child session and sends one prompt.
- `serial`: runs nested steps one by one.
- `parallel`: runs nested steps concurrently.
- `summary`: prompt-like step intended to summarize prior outputs.
- `planner`: currently parsed and executed as a prompt-like planning step; stricter next-step routing is planned.
- `loop`: repeats its `body` or nested `steps` up to `maxIterations`.

Example planner and loop shape:

```yaml
steps:
  - id: inspect
    type: planner
    prompt: |
      Decide the next useful investigation step. Return a concise plan.

  - id: iterate
    type: loop
    maxIterations: 3
    body:
      - id: investigate
        type: prompt
        prompt: |
          Continue investigation using: {{ steps.inspect.output }}
```

## Tool

The plugin exposes one model-callable tool named `workflow`.

Use the `action` argument to choose behavior:

- `action: "schema"`: return the supported workflow YAML format and examples.
- `action: "list"`: list discovered workflow ids, descriptions, scopes, and paths.
- `action: "run"`: run by `workflowID` or inline `yaml`; defaults to `async: true`.
- `action: "generate"`: ask a model child session to generate YAML from a goal, then validate it.
- `action: "save"`: validate and save YAML to `.workflows` or `.opencode/workflows`.
- `action: "status"`: read persisted run state.
- `action: "resume"`: best-effort status-oriented resume helper.
- `action: "cancel"`: mark a run cancelled and abort active child sessions when possible.

## `/workflow` Command

The plugin registers `/workflow` as a command template. It does not execute workflow logic directly in the command hook. Instead, it asks the active model to:

1. Call `workflow` with `action: "schema"` if the YAML format is needed.
2. Call `workflow` with `action: "list"`.
3. Select an existing workflow or call `workflow` with `action: "generate"`.
4. Map the user request into workflow inputs.
5. Call `workflow` with `action: "run"`.

Example:

```text
/workflow run a code review on the authentication changes
```

## Child Sessions

This plugin intentionally does not create detached worker sessions.

For default async runs, each model-running step creates a real child session directly with the current session as `parentID`. The plugin then waits for the child in the background and injects a task-like synthetic notification back into the parent session using the real child session id.

Child session creation uses the legacy opencode SDK session API:

```ts
client.session.create({
  parentID: rootSessionID,
  title: `workflow:${workflowID}/${stepID}`,
  agent,
  model,
  metadata,
})
```

Async step notifications use task-like text so the parent conversation records the real child session id:

```xml
<task id="ses_child..." state="completed">
<summary>Workflow step completed: step-id</summary>
<task_result>
...
</task_result>
</task>
```

This is not the internal TaskTool live UI, but it preserves the child-session relationship and gives the parent session a scan-friendly completion/error notification.

If the plugin cannot resolve the current parent session id, `workflow` action `run` fails fast instead of falling back to detached execution.

## Async Wake-Up

`workflow` action `run` defaults to `async: true`.

Async behavior:

- The tool returns a run id quickly.
- Workflow state is persisted under `.opencode/workflows/runs/<run-id>.json`.
- Worker steps continue in child sessions under the original parent session.
- Each step completion or failure injects a task-like synthetic message with the real child session id.
- On overall completion or failure, the plugin sends a concise workflow summary back to the parent session.

Use `async: false` only when you want the tool call to wait for completion.

## Dynamic Generation And Saving

Models can create workflows dynamically:

- `workflow` action `schema` returns the supported YAML format before generation.
- `workflow` action `generate` creates a child session attached to the current session.
- The child session drafts YAML from a natural-language goal.
- The plugin validates generated YAML before it can run.
- Generated YAML can be passed to `workflow` action `run` inline.
- Generated or inline YAML can be saved with `workflow` action `save` for future reuse.

Saving is explicit. The model must provide a safe `saveAs` id and a target location.

`skills` in workflow YAML are optional hints. They help the model understand which workflow style or capability to apply, but the plugin does not reject a workflow because a skill name is missing, unknown, or not installed.

Most execution settings are optional. If `agent`, `model`, `tools`, `skills`, `system`, `context`, or `format` are missing, the plugin leaves them to workflow defaults or opencode runtime defaults instead of treating them as errors.

## Development

Install dependencies:

```bash
bun install
```

Run tests:

```bash
bun test
```

Type-check:

```bash
bun run check
```

Build:

```bash
bun run build
```

Preview package contents:

```bash
npm pack --dry-run
```

## Project Layout

```text
src/
  command.ts      /workflow command registration
  discovery.ts    workflow file discovery
  index.ts        plugin entrypoint
  parser.ts       YAML parsing, validation, template rendering
  persistence.ts  run state and saved workflow persistence
  runner.ts       child-session execution runner
  tools.ts        opencode tool definitions
  types.ts        shared types
tests/
  *.test.ts       parser, persistence, discovery, command, runner tests
docs/
  workflow-plugin-plan.md
```

## Current Limitations

- `workflow_resume` is currently best-effort and status-oriented. Full durable resume of incomplete nested execution is planned.
- `planner` is currently accepted and executed as a prompt-like planning step. Strict machine-readable next-step routing is planned.
- Generated workflow repair retries are intentionally minimal in the first implementation.
- Tool permission safety depends on opencode runtime permission configuration plus workflow step `tools` maps.

## License

MIT
