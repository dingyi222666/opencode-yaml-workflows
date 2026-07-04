# Writing Workflows

[中文](./workflows.zh-CN.md) | **English**

## Workflow files

The plugin scans YAML files from:

- `~/.config/opencode/workflows/**/*.yaml`
- `~/.config/opencode/workflows/**/*.yml`
- `.opencode/workflows/**/*.yaml`
- `.opencode/workflows/**/*.yml`
- `.workflows/**/*.yaml`
- `.workflows/**/*.yml`

If two files use the same workflow `id`, project-local `.workflows` wins over `.opencode/workflows`.

## Minimal workflow

Create `.workflows/review.yaml`:

```yaml
id: review
name: Code Review
description: Review code changes and summarize risks.

inputs:
  task:
    type: string
    required: true
    description: What should be reviewed.

steps:
  - id: review
    type: prompt
    prompt: |
      Review this task and report correctness risks, missing tests, and follow-ups:
      {{ inputs.task }}
```

Run it:

```text
/workflow review the current diff
```

The active model lists available workflows, chooses the matching one, fills the `inputs`, and starts the run.

## YAML fields

Top-level fields:

- `id`: Workflow id. Keep it short and safe for filenames and references.
- `name`: Display name. Defaults to `id`.
- `description`: Short explanation used by the model when choosing a workflow.
- `trigger.aliases`: Optional names the user might type.
- `trigger.match`: Optional phrases that hint when this workflow should be used.
- `defaults`: Shared settings for steps, such as `agent`, `model`, `async`, `tools`, `skills`, `system`, `context`, and `format`.
- `inputs`: Values the model must provide before running the workflow.
- `steps`: The work to run.

Step fields:

- `id`: Step id. Later steps can reference it with `{{ steps.<id>.output }}`.
- `type`: `prompt`, `serial`, `parallel`, `summary`, `planner`, or `loop`.
- `prompt`: Prompt text for model-running steps.
- `steps`: Nested steps for `serial` and `parallel`.
- `body`: Loop body for `loop`.
- `maxIterations`: Hard cap for loop runs.
- `agent`, `model`, `tools`, `skills`, `system`, `context`, `format`: Optional per-step overrides.

If `tools` is omitted, the plugin does not override tool permissions. The step keeps opencode's normal tool behavior instead of disabling everything.

Template variables:

- `{{ inputs.task }}` inserts an input value.
- `{{ steps.plan.output }}` inserts output from an earlier step.

## Complete example

This workflow plans a review, runs two reviewers in parallel, then summarizes the result.

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

## Step types

- `prompt`: Creates one child session and sends one prompt.
- `serial`: Runs nested steps one after another.
- `parallel`: Runs nested steps at the same time.
- `summary`: A prompt-style step meant to merge earlier outputs.
- `planner`: Currently runs like a prompt step. Stricter next-step routing can be added later.
- `loop`: Repeats its `body` or nested `steps` up to `maxIterations`.

Planner and loop shape:

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
