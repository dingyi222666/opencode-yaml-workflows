# Development

[中文](./development.zh-CN.md) | **English**

## Project structure

- `src/command.ts`: `/workflow` command registration.
- `src/discovery.ts`: Workflow file discovery.
- `src/index.ts`: Plugin entrypoint.
- `src/parser.ts`: YAML parsing, validation, and template rendering.
- `src/persistence.ts`: Run state and saved workflow persistence.
- `src/runner.ts`: Execution runner and child-session handling.
- `src/tools.ts`: `workflow` tool definitions.
- `src/types.ts`: Shared types.

## Current limits

- `workflow_resume` is currently best-effort and status-oriented.
- `planner` currently behaves like a prompt step.
- Generated workflow repair retries are intentionally minimal.
- Tool permission safety still depends on opencode runtime permissions and workflow `tools` maps.

## Commands

```bash
bun install
bun test
bun run check
bun run build
npm pack --dry-run
```
