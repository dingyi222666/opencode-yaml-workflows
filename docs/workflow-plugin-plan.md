# YAML Workflow Plugin Plan

## Goal

Build an opencode plugin that loads YAML workflow definitions and runs them as child sessions attached to the current session, so workflow steps appear and behave like subagents under the original conversation instead of detached background chats.

## Core Requirements

- Workflows are written in YAML, not JSON.
- Workflows can be invoked by a model through a tool, or manually with `/workflow <request>`.
- The plugin discovers workflow files from global and project locations.
- Workflow execution supports serial steps, parallel batches, summary steps, loop-style planner steps, selected agents, selected models, and extra context attachments.
- Each step can customize its own agent, model, enabled tools, skills, system prompt, output format, and extra context; workflow defaults are only fallbacks.
- Workflows can be static YAML files, dynamically created by a model through a skill/tool before execution, or saved by the model for later reuse.
- Each workflow worker runs as a child session using the current `sessionID` as `parentID`, matching opencode's subagent session model.
- Async execution with parent-session wake-up is supported by default: workflows continue in the background unless explicitly run synchronously, then wake the original session when results are ready.

## opencode API Findings

- Plugins can expose commands by mutating `config.command` in the plugin `config` hook.
- Plugins can expose model-callable tools through the returned `tool` object.
- Tool execution receives the current `sessionID`, `messageID`, `agent`, `directory`, and `worktree` through `ToolContext`.
- SDK session creation supports `parentID`, `agent`, `model`, `title`, `metadata`, `permission`, `directory`, and `workspace`.
- SDK session APIs include `session.create`, `session.prompt`, `session.prompt_async`, `session.wait`, `session.children`, `session.messages`, `session.get`, and `session.abort`.
- `prompt` and `prompt_async` accept `agent`, `model`, `system`, `tools`, `format`, `variant`, and `parts`.
- Prompt parts support text, files, agent mentions, and subtask-like parts, but workflow execution should primarily use child sessions with `parentID` to mirror subagent behavior.
- Events include `session.created`, `session.idle`, `session.status`, `message.updated`, `message.part.updated`, `tool.execute.before`, `tool.execute.after`, `command.executed`, and `tui.command.execute`.

## Workflow Locations

Load workflow YAML files from these locations, in order:

- Global user workflows: `~/.config/opencode/workflows/**/*.yml` and `~/.config/opencode/workflows/**/*.yaml`.
- Project opencode workflows: `.opencode/workflows/**/*.yml` and `.opencode/workflows/**/*.yaml`.
- Project-local workflows: `.workflows/**/*.yml` and `.workflows/**/*.yaml`.

Project workflows override global workflows with the same workflow id. `.workflows` is intentionally supported for users who want workflow files independent from opencode configuration.

## YAML Shape

```yaml
id: code-review
name: Code Review
description: Review a change with parallel specialists and summarize the result.

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
    bash: true
    edit: false
  skills:
    - code-review

inputs:
  task:
    type: string
    required: true

steps:
  - id: plan
    type: prompt
    agent: build
    model: anthropic/claude-sonnet-4-6
    tools:
      grep: true
      read: true
    skills:
      - repo-analysis
    prompt: |
      Create a concise review plan for: {{ inputs.task }}

  - id: parallel-review
    type: parallel
    steps:
      - id: correctness
        agent: general
        prompt: Check correctness risks using the plan: {{ steps.plan.output }}
      - id: tests
        agent: general
        prompt: Check missing tests using the plan: {{ steps.plan.output }}

  - id: summary
    type: summary
    agent: build
    prompt: |
      Summarize the review findings and rank by severity.
      Correctness: {{ steps.correctness.output }}
      Tests: {{ steps.tests.output }}
```

## Supported Step Types

- `prompt`: create one child session attached to the root session and send one prompt.
- `serial`: run child steps one by one, carrying previous outputs into context.
- `parallel`: run child steps concurrently, each as its own child session under the original root session.
- `summary`: run one child session that summarizes selected prior outputs.
- `planner`: ask a model to choose the next step id or terminate, giving dynamic branching without hardcoded `if` syntax.
- `loop`: repeat a planner-controlled body until the planner returns `done` or `maxIterations` is reached.

Every step type can override execution settings:

- `agent`: opencode agent for this step.
- `model`: provider/model id for this step.
- `tools`: per-step tool enable/disable map passed into `session.prompt` or `session.prompt_async`.
- `skills`: skill names or skill hints to include in the step prompt/system context.
- `system`: additional system instruction for this step.
- `context`: extra text, file paths, previous step outputs, or generated notes attached to this step.
- `format`: optional output format for structured planner/summary results.

Do not add static `if` expressions in v1. Dynamic branching should be model-driven through `planner` and bounded `loop`.

## Child Session Execution Model

Hard requirement: every workflow worker session must be attached under the current conversation, exactly like a subagent. The current tool or command `sessionID` is the single root parent session id for the whole workflow run. Workflow steps must never create detached top-level sessions.

Every workflow step that calls a model should create or reuse a child session with:

- `parentID`: the current tool or command session id.
- `title`: `workflow:<workflow-id>/<step-id>`.
- `agent`: step agent, workflow default agent, or current agent fallback.
- `model`: step model, workflow default model, or current model fallback.
- `tools`: step tool settings merged over workflow defaults.
- `skills`: step skills rendered into the child prompt/system context.
- `metadata`: workflow id, run id, step id, parent session id, async flag, and status.
- `directory`: current tool context directory.

The runner should call `client.session.create({ parentID: rootSessionID, ... })` for each model-running step, then send the step prompt into that child session. This makes the workflow visible in the parent conversation as attached child/subagent sessions, while preserving each step's own agent, model, prompt, tools, metadata, and output history.

The root parent session id must be captured before execution starts and passed through every serial, parallel, summary, planner, and loop step. Nested workflow steps still attach to the original parent session unless a future feature explicitly introduces nested child-of-child sessions.

## Manual Command Flow

Register `/workflow` through `config.command.workflow`.

Command prompt behavior:

1. Accept `/workflow <request>`.
2. Ask the active model to choose the best workflow from loaded workflow descriptions.
3. Ask the model to map user text into workflow inputs.
4. Instruct the model to call the `workflow_run` tool with the selected workflow id and inputs.

The command should not execute workflows directly from the `command.execute.before` hook in v1. Keeping execution inside `workflow_run` gives one consistent path for model-triggered and manual execution.

## Tool Flow

Expose these tools:

- `workflow_list`: list discovered workflows with id, name, description, aliases, file path, and trigger hints.
- `workflow_run`: run a workflow by id with YAML-derived inputs and options.
- `workflow_generate`: ask a model to create workflow YAML from a natural-language goal, optionally using selected skills/tools, then validate it.
- `workflow_save`: save validated generated or inline workflow YAML into `.opencode/workflows` or `.workflows` for later reuse.
- `workflow_status`: inspect an async run by run id.
- `workflow_resume`: continue a paused or failed async run if resumable.
- `workflow_cancel`: abort active child sessions for a run.

`workflow_run` receives the current `ToolContext.sessionID` and treats it as the root parent session for all child sessions.

If `workflow_run` cannot resolve a current parent session id, it should fail fast. It must not silently fall back to detached execution.

`workflow_run` should support registered workflow ids, inline workflow YAML, and generated workflow YAML. Generated workflows are validated and normalized through the same schema path as file-backed workflows before any child session is created.

## Dynamic Workflow Generation

Models can create and save workflows dynamically through `workflow_generate`, `workflow_save`, or by calling `workflow_run` with inline YAML.

Generation flow:

1. The user or model provides a goal, constraints, preferred skills, preferred tools, agent/model defaults, and optional source workflow ids to remix.
2. `workflow_generate` starts a child session under the current parent session to draft YAML, using the requested model/agent/skills/tools.
3. The plugin parses and validates the generated YAML with the same schema used for static files.
4. If valid, the generated workflow is returned with a temporary id like `generated:<run-id>` and can be executed immediately.
5. If `saveAs` or `workflow_save` is used, the model can persist the generated workflow to `.opencode/workflows/<id>.yaml` or `.workflows/<id>.yaml` for future `/workflow` selection and `workflow_run` calls.
6. If invalid, the generator child session receives validation errors and may retry within a bounded retry count.

Dynamic workflows must still obey the child-session rule: generation, validation repair, and execution worker sessions all attach to the current parent session through `parentID`.

Saved generated workflows must preserve provenance metadata in YAML comments or fields, including creator session id, source generated run id, created timestamp, and optional prompt summary. Saving should be explicit: the model can propose saving, but the tool should require a `saveAs` target and respect configured write locations.

## Async Wake-Up Flow

Async wake-up is the default execution mode. Unless a workflow or `workflow_run` call explicitly sets `async: false`, the runner should use async execution, return quickly with a run id, and wake the original parent session when the workflow completes.

Async mode should use `session.prompt_async` for worker child sessions and persist run state under `.opencode/workflows/runs/<run-id>.json`.

Execution flow:

1. Start async workflow from `workflow_run`.
2. Create child sessions attached to the original `sessionID`.
3. Return a short run id immediately to the current session.
4. Track `session.idle`, `session.status`, or explicit `session.wait` results for child sessions.
5. When all required children complete, run a summary child session if configured.
6. Wake the original session by sending a follow-up `session.prompt` or `session.prompt_async` to the parent session with a concise workflow completion summary and links/ids for child sessions.

The wake-up prompt must be clearly marked as plugin-generated workflow output to avoid pretending it is user input.

Default async behavior:

- `workflow_run` defaults to `async: true`.
- File-backed YAML workflows default to `defaults.async: true` when omitted.
- Generated workflows default to async wake-up unless the generator explicitly asks for synchronous execution and the caller allows it.
- Synchronous mode is opt-in with `async: false` and should still create child sessions under the current parent session.

## State Model

Persist run state so async workflows survive process restarts where possible.

```ts
type WorkflowRun = {
  id: string
  workflowID: string
  parentSessionID: string
  status: "queued" | "running" | "completed" | "failed" | "cancelled"
  async: boolean
  inputs: Record<string, unknown>
  childSessions: Record<string, {
    stepID: string
    sessionID: string
    status: "queued" | "running" | "completed" | "failed" | "cancelled"
    output?: string
    error?: string
  }>
  createdAt: string
  updatedAt: string
}
```

## Implementation Phases

1. Rename package/plugin ids from template names to the real workflow plugin name.
2. Add dependencies: `yaml` for parsing, `zod` for schema validation if not already available through plugin dependencies.
3. Implement workflow discovery across global, `.opencode/workflows`, and `.workflows` directories.
4. Implement YAML schema validation and normalized internal workflow types.
5. Add per-step model, agent, tools, skills, system, context, and format resolution.
6. Add `workflow_list`, `workflow_generate`, `workflow_save`, and `workflow_run` tools.
7. Implement child-session runner using `client.session.create({ parentID })` and `client.session.prompt`.
8. Add `serial`, `parallel`, and `summary` execution.
9. Add model-driven `planner` and bounded `loop` execution.
10. Add inline/generated workflow validation, bounded repair retries, and model-driven save-as behavior.
11. Add default async run state, `prompt_async`, event/wait handling, and parent wake-up behavior.
12. Add `/workflow` command that routes natural language requests through workflow selection or workflow generation, then tool invocation.
13. Add tests for discovery, YAML validation, dynamic generation, execution planning, per-step model/tool/skill resolution, child session creation payloads, async persistence, and command prompt generation.
14. Update README with usage examples and YAML authoring docs.

## Risks And Decisions

- The most important design decision is that workflow workers must be child sessions via `parentID`, never independent root sessions.
- The subagent simulation depends on preserving `parentID` for every worker. If a step cannot create a child session under the current parent session, the runner should fail the workflow instead of silently falling back to a detached session.
- Static `if` is intentionally omitted; dynamic branching is handled by planner/loop steps with strict max iteration limits.
- Dynamic workflow generation must be validated before execution; generated YAML cannot bypass schema checks, child-session attachment, tool permission limits, or loop bounds.
- Step-level model/tool/skill overrides are allowed, but workflow-level defaults and plugin-level safety caps still apply.
- Async wake-up depends on reliable session event handling or `session.wait`; implementation should support both if events are missed.
- Async wake-up is the default behavior. Sync mode must be explicit so long workflows do not block the original turn by default.
- Tool permissions should be configurable per workflow and per step so child agents do not inherit unsafe defaults accidentally.
- The plugin should keep workflow YAML deterministic and auditable even when planner steps choose dynamic next actions.
