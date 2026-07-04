# 编写 Workflow

**中文** | [English](./workflows.md)

## Workflow 文件位置

插件会扫描这些 YAML 文件：

- `~/.config/opencode/workflows/**/*.yaml`
- `~/.config/opencode/workflows/**/*.yml`
- `.opencode/workflows/**/*.yaml`
- `.opencode/workflows/**/*.yml`
- `.workflows/**/*.yaml`
- `.workflows/**/*.yml`

如果多个文件用了同一个 workflow `id`，项目本地 `.workflows` 会覆盖 `.opencode/workflows`。

## 最小例子

创建 `.workflows/review.yaml`：

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

执行：

```text
/workflow review the current diff
```

当前模型会列出可用 workflow，选择匹配的 workflow，填好 `inputs`，然后启动执行。

## YAML 字段

顶层字段：

- `id`：workflow id。建议短一点，方便文件名和引用。
- `name`：展示名称。省略时使用 `id`。
- `description`：简短说明，模型会用它判断该不该选择这个 workflow。
- `trigger.aliases`：用户可能输入的别名。
- `trigger.match`：用于辅助匹配的短语。
- `defaults`：step 共享默认值，比如 `agent`、`model`、`async`、`tools`、`skills`、`system`、`context` 和 `format`。
- `inputs`：运行前需要模型补齐的输入。
- `steps`：实际要执行的步骤。

Step 字段：

- `id`：step id。后续 step 可以用 `{{ steps.<id>.output }}` 引用它的输出。
- `type`：`prompt`、`serial`、`parallel`、`summary`、`planner` 或 `loop`。
- `prompt`：发送给模型的 prompt。
- `steps`：`serial` 和 `parallel` 的嵌套步骤。
- `body`：`loop` 的循环体。
- `maxIterations`：loop 的最大次数。
- `agent`、`model`、`tools`、`skills`、`system`、`context`、`format`：当前 step 的覆盖配置。

如果没有写 `tools`，插件不会覆盖工具权限。也就是说，step 会继续使用 opencode 的默认工具行为，而不是禁用所有工具。

模板变量：

- `{{ inputs.task }}` 插入 input 值。
- `{{ steps.plan.output }}` 插入前面 step 的输出。

## 完整例子

这个 workflow 会先生成 review 计划，再并行跑两个 reviewer，最后汇总结果。

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

## Step 类型

- `prompt`：创建一个子会话，发送一个 prompt。
- `serial`：按顺序执行嵌套 step。
- `parallel`：并发执行嵌套 step。
- `summary`：用来合并前面输出的 prompt-style step。
- `planner`：目前按 prompt step 执行，后面可以加强 next-step routing。
- `loop`：按 `maxIterations` 重复执行 `body` 或嵌套 `steps`。

planner 和 loop 的结构：

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
