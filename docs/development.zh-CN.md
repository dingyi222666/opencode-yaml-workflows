# 开发

**中文** | [English](./development.md)

## 项目结构

- `src/command.ts`：注册 `/workflow` 命令。
- `src/discovery.ts`：发现 workflow 文件。
- `src/index.ts`：插件入口。
- `src/parser.ts`：解析 YAML、校验字段、渲染模板。
- `src/persistence.ts`：保存 run 状态和 workflow 文件。
- `src/runner.ts`：执行 workflow 和处理子会话。
- `src/tools.ts`：定义 `workflow` 工具。
- `src/types.ts`：共享类型。

## 当前限制

- `workflow_resume` 目前是 best-effort/status-oriented。
- `planner` 目前按 prompt step 执行。
- 生成 workflow 后的自动修复重试比较保守。
- 工具权限仍然依赖 opencode runtime 权限和 workflow 里的 `tools` 配置。

## 命令

```bash
bun install
bun test
bun run check
bun run build
npm pack --dry-run
```
