# Install

[中文](./install.zh-CN.md) | **English**

## From opencode config

Add the package to `opencode.json` or `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-yaml-workflows"]
}
```

Restart opencode after changing the config.

## Local development

Build the project first:

```bash
bun install
bun run build
```

Then point your config at this repo:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-yaml-workflows"]
}
```
