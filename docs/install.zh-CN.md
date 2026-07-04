# 安装

**中文** | [English](./install.md)

## 通过 opencode config 安装

在 `opencode.json` 或 `opencode.jsonc` 里加入插件：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-yaml-workflows"]
}
```

修改配置后重启 opencode。

## 本地开发

先构建项目：

```bash
bun install
bun run build
```

然后在配置里引用本地路径：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["/absolute/path/to/opencode-yaml-workflows"]
}
```
