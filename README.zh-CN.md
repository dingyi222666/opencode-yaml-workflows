# opencode-yaml-workflows

**中文** ｜ [English](./README.md)

用于 opencode 的 YAML 工作流插件。默认以异步方式执行，并把每个 worker 会话挂到当前会话下面，模拟 subagent。

## 功能概览

- 从 YAML 文件加载可复用工作流。
- 提供一个模型可调用的 `workflow` 工具，通过 `action` 参数列出、执行、生成、保存、查看、恢复和取消 workflow。
- 注册 `/workflow <request>`，让当前模型自动选择或生成合适的 workflow。
- 每个模型 step 都通过 `parentID` 创建子会话，因此 worker 会挂在当前会话下，看起来像 subagent。
- 默认异步执行：工具快速返回 run id，后台继续运行，完成后唤醒父会话。

## 安装

本地开发时，先安装依赖并构建：

```bash
bun install
bun run build
```

然后在 opencode 配置里引用这个项目路径：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-yaml-workflows"]
}
```

修改插件代码或 opencode 配置后，需要重启 opencode。

## 工作流位置

插件会从以下位置发现 YAML workflow：

- 全局：`~/.config/opencode/workflows/**/*.yaml` 和 `~/.config/opencode/workflows/**/*.yml`
- 项目 opencode：`.opencode/workflows/**/*.yaml` 和 `.opencode/workflows/**/*.yml`
- 项目本地：`.workflows/**/*.yaml` 和 `.workflows/**/*.yml`

同名 workflow id 下，项目本地 `.workflows` 会覆盖 `.opencode/workflows`。

## 快速开始

创建 `.workflows/review.yaml`：

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

手动执行：

```text
/workflow review the current diff
```

当前模型会查看可用 workflow，把你的请求映射成 inputs，然后调用 `workflow`，并设置 `action: "run"`。

## YAML 语法

顶层字段：

- `id`：安全的 workflow id，用于发现和执行。
- `name`：可选展示名称，省略时默认使用 `id`。
- `description`：可选简短描述，模型会用它选择 workflow。
- `trigger.aliases` 和 `trigger.match`：给 `/workflow` 路由用的提示。
- `defaults`：可选默认 `agent`、`model`、`async`、`tools`、`skills`、`system`、`context`、`format`。
- `inputs`：prompt 模板使用的输入定义。
- `steps`：有序 workflow 步骤。

Step 字段：

- `id`：安全 step id，可通过 `{{ steps.<id>.output }}` 引用。
- `type`：`prompt`、`serial`、`parallel`、`summary`、`planner` 或 `loop`。如果省略但存在 `prompt`，默认就是 `prompt`。
- `prompt`：模型 step 的 prompt 文本。
- `steps`：`serial` 和 `parallel` 的嵌套步骤。
- `body`：`loop` 的循环体。
- `maxIterations`：`loop` 的最大迭代次数。
- `agent`、`model`、`tools`、`skills`、`system`、`context`、`format`：可选 step 级覆盖配置。没有写就使用 workflow 默认值或 opencode 当前/default 行为。

如果没有写 `tools`，插件不会传 tool override。这表示继续使用 opencode 默认可用工具；省略 `tools` 不代表禁用所有工具。

模板变量：

- `{{ inputs.task }}` 读取 workflow 输入 `task`。
- `{{ steps.plan.output }}` 读取前置 step 输出。

## Step 类型

- `prompt`：创建一个子会话并发送一个 prompt。
- `serial`：按顺序执行嵌套步骤。
- `parallel`：并发执行嵌套步骤。
- `summary`：用于总结前面输出的 prompt-like step。
- `planner`：当前作为 prompt-like 规划 step 执行；严格 next-step 路由后续增强。
- `loop`：按 `maxIterations` 重复执行 `body` 或嵌套 `steps`。

planner 和 loop 示例结构：

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

## 工具

插件只暴露一个模型可调用工具：`workflow`。

通过 `action` 参数选择行为：

- `action: "schema"`：返回支持的 workflow YAML 格式和示例。
- `action: "list"`：列出已发现 workflow 的 id、描述、scope 和路径。
- `action: "run"`：通过 `workflowID` 或 inline `yaml` 执行；默认 `async: true`。
- `action: "generate"`：让模型子会话根据目标生成 YAML，并进行校验。
- `action: "save"`：校验并保存 YAML 到 `.workflows` 或 `.opencode/workflows`。
- `action: "status"`：读取持久化 run 状态。
- `action: "resume"`：当前是 best-effort/status-oriented 的恢复辅助工具。
- `action: "cancel"`：标记 run 为 cancelled，并尽量 abort 活跃子会话。

## `/workflow` 手动命令

插件注册了 `/workflow` 命令模板。它不会在 command hook 里直接执行 workflow，而是让当前模型：

1. 如果需要 YAML 格式，先调用 `workflow`，并设置 `action: "schema"`。
2. 调用 `workflow`，并设置 `action: "list"`。
3. 选择已有 workflow，或者调用 `workflow`，并设置 `action: "generate"`。
4. 把用户请求映射为 workflow inputs。
5. 调用 `workflow`，并设置 `action: "run"`。

示例：

```text
/workflow run a code review on the authentication changes
```

## 子会话机制

这个插件不会创建游离的 worker 会话。

默认异步执行时，每个模型 step 都会用当前会话作为 `parentID` 直接创建真实子会话。插件随后在后台等待子会话完成，并用真实子会话 id 向父会话注入 task-like synthetic 通知。

子会话创建使用 legacy opencode SDK session API：

```ts
client.session.create({
  parentID: rootSessionID,
  title: `workflow:${workflowID}/${stepID}`,
  agent,
  model,
  metadata,
})
```

异步 step 通知会使用 task-like 文本，让父会话记录真实子会话 id：

```xml
<task id="ses_child..." state="completed">
<summary>Workflow step completed: step-id</summary>
<task_result>
...
</task_result>
</task>
```

这不是 opencode 内部 TaskTool live UI，但会保留真实 child-session 关系，并让父会话得到可扫描的完成/失败通知。

如果插件拿不到当前父会话 id，`workflow` 的 `run` action 会直接失败，不会 fallback 到 detached session。

## 异步唤醒

`workflow` 的 `run` action 默认 `async: true`。

异步行为：

- 工具会快速返回 run id。
- workflow 状态会持久化到 `.opencode/workflows/runs/<run-id>.json`。
- worker step 会继续在原始父会话下面的子会话里运行。
- 每个 step 完成或失败后，插件会用真实子会话 id 注入一条 task-like synthetic message。
- 整体完成或失败后，插件会向父会话发送一条简洁 workflow summary。

只有在希望工具调用等待完成时，才使用 `async: false`。

## 动态生成与保存

模型可以动态创建 workflow：

- `workflow` 的 `schema` action 会返回当前支持的 YAML 格式。
- `workflow` 的 `generate` action 会在当前会话下创建一个子会话。
- 子会话根据自然语言目标生成 YAML。
- 插件会先校验生成的 YAML，再允许执行。
- 生成的 YAML 可以作为 inline YAML 传给 `workflow` 的 `run` action。
- 生成或 inline YAML 可以通过 `workflow` 的 `save` action 保存，后续复用。

保存是显式行为。模型必须提供安全的 `saveAs` id 和目标位置。

workflow YAML 里的 `skills` 是可选提示。它用于告诉模型采用什么工作流风格或能力，但插件不会因为 skill 名称不存在、未知、或本机没有安装而判定 workflow 无效。

大多数执行配置都是可选的。如果没有写 `agent`、`model`、`tools`、`skills`、`system`、`context` 或 `format`，插件会交给 workflow 默认值或 opencode runtime 默认行为处理，而不是报错。

## 开发

安装依赖：

```bash
bun install
```

运行测试：

```bash
bun test
```

类型检查：

```bash
bun run check
```

构建：

```bash
bun run build
```

预览包内容：

```bash
npm pack --dry-run
```

## 项目结构

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

## 当前限制

- `workflow_resume` 当前是 best-effort/status-oriented。完整 durable resume 后续增强。
- `planner` 当前作为 prompt-like 规划 step 执行。严格机器可读 next-step 路由后续增强。
- 第一版里 generated workflow 的修复重试逻辑较保守。
- 工具权限安全依赖 opencode runtime permission 配置，以及 workflow step 的 `tools` 映射。

## 许可证

MIT
