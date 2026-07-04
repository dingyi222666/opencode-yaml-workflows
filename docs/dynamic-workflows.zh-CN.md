# Dynamic Workflows 对比

**中文** | [English](./dynamic-workflows.md)

Claude Code Dynamic Workflows 和 `opencode-yaml-workflows` 都能编排多个 agent，但使用习惯不一样。

## Claude Code Dynamic Workflows

- Claude 会为当前任务写一个 JavaScript workflow script。
- runtime 在后台执行这个脚本。
- 循环、分支和中间结果存在脚本变量里。
- 通过 Claude Code 的 `/workflows` UI 管理。
- 保存后的 workflow 会成为 `.claude/workflows/` 或 `~/.claude/workflows/` 里的命令。
- 更适合大型一次性任务，也就是让 Claude 现场设计编排方案。

## opencode-yaml-workflows

- 你写 YAML，或者让模型生成 YAML。
- workflow 放在普通项目目录或用户配置目录里。
- inputs、steps、prompts、models、agents 和 tool 设置都容易阅读和 diff。
- run 会在当前父会话下面创建真实子会话。
- 更适合复用、审查、提交到仓库和团队共享。

简单说：如果计划应该为某个大任务现场生成，用 Claude Dynamic Workflows。如果 workflow 本身应该沉淀成项目资产，用这个插件。
