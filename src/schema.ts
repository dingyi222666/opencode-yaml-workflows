export const WORKFLOW_SCHEMA_TEXT = `# YAML Workflow Format

Use this format when creating a workflow for the workflow tool.

Required top-level fields:

- id: safe workflow id matching /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
- steps: non-empty array of workflow steps

Optional top-level fields:

- name: display name. Defaults to id when omitted.
- description: short model-readable description. Defaults to an empty description when omitted.
- trigger.aliases: string[]
- trigger.match: string[]
- defaults.agent: optional agent. Omitted means use the current opencode/default agent.
- defaults.model: optional provider/model id, for example anthropic/claude-sonnet-4-6. Omitted means use the current opencode/default model.
- defaults.async: boolean, defaults to true
- defaults.tools: optional map of tool name to boolean. Omitted means no workflow-level tool override; opencode default tool availability applies.
- defaults.skills: optional string[] of skill hints. These do not need to match installed skills exactly.
- defaults.system: optional string
- defaults.context: optional YAML value
- defaults.format: optional YAML value
- inputs.<name>.type: string | number | boolean | object | array
- inputs.<name>.required: boolean
- inputs.<name>.description: string
- inputs.<name>.default: any YAML value
- provenance: object

Step fields:

- id: safe step id matching /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/
- type: prompt | serial | parallel | summary | planner | loop. If omitted and prompt is present, type defaults to prompt.
- prompt: required for prompt, summary, and planner
- steps: non-empty array for serial and parallel
- body: non-empty array for loop, or use steps as the loop body
- maxIterations: loop cap, defaults to 3
- agent: optional per-step agent override. Omitted means inherit workflow/default/current agent.
- model: optional per-step provider/model override. Omitted means inherit workflow/default/current model.
- tools: optional per-step tool map merged over defaults.tools. If tools are omitted everywhere, all default opencode tool availability remains unchanged.
- skills: optional per-step skill hints appended after defaults.skills. These are guidance for the model, not strict validation targets.
- system: optional per-step system prompt override
- context: optional per-step extra context
- format: optional per-step output format hint

Template variables:

- {{ inputs.name }} reads an input value.
- {{ steps.stepID.output }} reads a previous step output.

Execution rules:

- workflow action=run defaults to async true unless async is explicitly false.
- every model-running step must run as a child session attached to the current parent session.
- generated or inline YAML must validate against this shape before execution.
- agent, model, tools, skills, system, context, and format are optional. Missing values mean use opencode defaults/current session behavior.
- omitted tools mean "do not override tools"; they do not mean "disable tools".
- skills are optional hints. Missing, unknown, or unmatched skill names must not make a workflow invalid.
- static if is not supported; use planner and bounded loop for dynamic behavior.

Example:

\`\`\`yaml
id: review
name: Code Review
description: Review a change with parallel specialists and summarize the result.

trigger:
  aliases:
    - review
  match:
    - review this

defaults:
  agent: general
  model: anthropic/claude-sonnet-4-6
  async: true
  tools:
    read: true
    grep: true
    bash: false
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
    prompt: |
      Create a concise review plan for: {{ inputs.task }}

  - id: specialists
    type: parallel
    steps:
      - id: correctness
        type: prompt
        model: anthropic/claude-sonnet-4-6
        prompt: |
          Check correctness risks using this plan:
          {{ steps.plan.output }}
      - id: tests
        type: prompt
        model: openai/gpt-5
        tools:
          read: true
          grep: true
        skills:
          - testing
        prompt: |
          Check missing tests using this plan:
          {{ steps.plan.output }}

  - id: final-summary
    type: summary
    prompt: |
      Summarize findings.
      Correctness: {{ steps.correctness.output }}
      Tests: {{ steps.tests.output }}
\`\`\`
`
