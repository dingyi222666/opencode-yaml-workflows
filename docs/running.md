# Running Workflows

[中文](./running.zh-CN.md) | **English**

## `/workflow`

The `/workflow` command asks the active model to choose the right action. A typical run is: list workflows, map the user request into inputs, then run the workflow.

Run an existing workflow:

```text
/workflow review the current diff
```

Create and save a new workflow:

```text
/workflow create a release-check workflow for this repo and save it
```

## Tool actions

The plugin exposes one model-callable tool named `workflow`.

- `schema`: Show the supported YAML format.
- `list`: List discovered workflows and their input requirements.
- `run`: Run a workflow by `workflowID`, or run inline `yaml`.
- `generate`: Ask a child session to generate workflow YAML from a goal.
- `save`: Validate and save workflow YAML.
- `status`: Read run state.
- `resume`: Best-effort helper for checking or continuing a run.
- `cancel`: Mark a run cancelled and try to abort active child sessions.

## Child sessions

Workflow steps do not run as detached chats. Each model-running step creates a real child session under the current parent session.

That matters because the workflow stays connected to the conversation that started it. You can still see which child session did each piece of work.

The runner creates child sessions like this:

```ts
client.session.create({
  parentID: rootSessionID,
  title: `workflow:${workflowID}/${stepID}`,
  agent,
  model,
  metadata,
})
```

When a step finishes, the parent gets a task-like message with the real child session id:

```xml
<task id="ses_child..." state="completed">
<summary>Workflow step completed: step-id</summary>
<task_result>
...
</task_result>
</task>
```

This is not opencode's internal TaskTool UI. It is a lightweight notification format that keeps the real child-session relationship visible.

If the plugin cannot find the current parent session id, `workflow run` fails instead of creating detached worker sessions.

## Async runs

Runs are async by default.

When `async: true`:

- The tool returns a `runID` quickly.
- Run state is saved under `.opencode/workflows/runs/<run-id>.json`.
- Steps keep running in child sessions.
- Step completion or failure is posted back to the parent session.
- The final workflow summary is posted when the run ends.

Use `async: false` only when you want the tool call to wait until the workflow is done.

## Generate and save

Models can create workflows too:

- `workflow` with `action: "schema"` shows the YAML format.
- `workflow` with `action: "generate"` drafts YAML from a goal.
- Generated YAML is validated before it can run.
- Inline YAML can be run directly.
- Generated or inline YAML can be saved with `action: "save"`.

Saving is explicit. The model must provide a safe `saveAs` id and a target location.

`skills` are hints, not hard dependencies. A workflow is not rejected just because a skill name is unknown or not installed.

Most execution settings are optional. If `agent`, `model`, `tools`, `skills`, `system`, `context`, or `format` are missing, the plugin uses workflow defaults or opencode runtime defaults.
