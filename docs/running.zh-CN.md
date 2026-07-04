# 运行 Workflow

**中文** | [English](./running.md)

## `/workflow`

`/workflow` 命令本质上是捷径：它会让当前模型选择合适的 action。常见流程是先 list，再把用户请求映射成 inputs，最后 run。

执行已有 workflow：

```text
/workflow review the current diff
```

新建并保存 workflow：

```text
/workflow create a release-check workflow for this repo and save it
```

## Tool actions

插件暴露一个模型可调用工具：`workflow`。

- `schema`：返回支持的 YAML 格式。
- `list`：列出已发现的 workflow 和它们需要的 inputs。
- `run`：通过 `workflowID` 执行，或直接执行 inline `yaml`。
- `generate`：让子会话根据目标生成 workflow YAML。
- `save`：校验并保存 workflow YAML。
- `status`：读取 run 状态。
- `resume`：best-effort 的查看或继续执行辅助工具。
- `cancel`：标记 run 为 cancelled，并尽量终止活跃子会话。

## 子会话

Workflow step 不会跑成游离的聊天。每个需要模型执行的 step 都会在当前父会话下面创建真实子会话。

这样做的好处是 workflow 和发起它的对话仍然连在一起，你能看到每个子会话分别做了哪部分工作。

创建子会话的形状类似这样：

```ts
client.session.create({
  parentID: rootSessionID,
  title: `workflow:${workflowID}/${stepID}`,
  agent,
  model,
  metadata,
})
```

step 完成后，父会话会收到一条带真实 child session id 的 task-like 消息：

```xml
<task id="ses_child..." state="completed">
<summary>Workflow step completed: step-id</summary>
<task_result>
...
</task_result>
</task>
```

这不是 opencode 内置 TaskTool UI，只是一个轻量通知格式，用来保留真实的 child-session 关系。

如果插件拿不到当前父会话 id，`workflow run` 会失败，不会 fallback 到 detached worker session。

## 异步执行

默认是异步执行。

当 `async: true`：

- 工具会很快返回 `runID`。
- run 状态保存到 `.opencode/workflows/runs/<run-id>.json`。
- step 会继续在子会话里运行。
- step 成功或失败都会写回父会话。
- 整个 workflow 结束后会写回最终 summary。

只有你希望工具调用一直等到 workflow 结束时，才设置 `async: false`。

## 生成和保存

模型也可以创建 workflow：

- `workflow` + `action: "schema"` 查看 YAML 格式。
- `workflow` + `action: "generate"` 根据目标生成 YAML。
- 生成的 YAML 会先校验，再允许执行。
- inline YAML 可以直接运行。
- 生成或 inline YAML 可以用 `action: "save"` 保存。

保存是显式行为。模型必须提供安全的 `saveAs` id 和目标位置。

`skills` 是提示，不是硬依赖。skill 不存在、未知或没安装，都不会导致 workflow 校验失败。

大多数执行配置都是可选的。如果没有写 `agent`、`model`、`tools`、`skills`、`system`、`context` 或 `format`，插件会使用 workflow 默认值或 opencode runtime 默认值。
