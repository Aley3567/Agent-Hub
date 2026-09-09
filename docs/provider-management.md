# Provider 管理与导入

Agent Hub 0.2 的 provider 由 Hub 自己保存。CC Switch 是可选的一次性导入来源；关闭、更新或卸载 CC Switch 不会改变已经导入的 provider。运行时读取 `~/.agent-hub/providers.db`，不会后台同步 CC Switch 数据库。

## TUI

运行 `agent-hub`：

- `a`：手动添加。选择 Claude Code 或 Codex，填写稳定 ID、名称、API 地址、协议、默认模型和隐藏输入的 API key。填写已有 ID 可以确认后更新。
- `i`：从 CC Switch 导入，按序号多选或 `all` 全选。确认前会显示新增和保留数量。
- `f`：从统一 JSON 文件导入，支持多选。
- `r`：重新读取 Hub 本地配置。不会重新读取 CC Switch。

导入确认输入 `yes` 仅新增；输入 `replace` 明确覆盖所选同 ID 的已有配置。导入不会删除源文件中已不存在的本地条目。API key 只保存在权限为 `0600` 的本地数据库中，不通过列表、日志或桌面 IPC 返回。

## CLI

```sh
agent-hub provider init
agent-hub provider import --cc-switch --preview
agent-hub provider import --cc-switch
agent-hub provider import --file /absolute/path/providers.json --preview
agent-hub provider import --file /absolute/path/providers.json
agent-hub provider add
agent-hub provider list --json
```

需要更新已有 provider 时，为导入命令添加 `--replace`。`--source-db PATH` 可指定 CC Switch 源库；它只与 `--cc-switch` 一起使用。`AGENT_HUB_PROVIDER_DB` 可以覆盖目标存储路径。原 `CLAUDE1_DB_PATH`、`CODEX1_DB_PATH`、`CLAUDE_HUB_DB` 显式覆盖继续有效；如果主动把它们指回 CC Switch，就仍然使用该外部库。

## 统一文件格式

`version` 为 1；`providers` 可以包含多条记录。每条记录的 `(app_type, id)` 是稳定身份，改名不改 ID。`settings_config` 与现有运行时格式兼容，`meta.apiFormat` 明确上游协议。

```json
{
  "version": 1,
  "providers": [
    {
      "id": "example-provider",
      "app_type": "claude",
      "name": "Example",
      "settings_config": {
        "env": {
          "ANTHROPIC_BASE_URL": "https://api.example.com",
          "ANTHROPIC_AUTH_TOKEN": "REPLACE_WITH_YOUR_KEY",
          "ANTHROPIC_MODEL": "your-model"
        }
      },
      "meta": { "apiFormat": "anthropic" }
    }
  ]
}
```

Claude provider 的协议可以是 `anthropic`、`openai_chat`、`openai_responses`。Codex provider 使用 `auth.OPENAI_API_KEY` 和 `config` TOML 字符串，协议为 `openai_responses`；建议用 TUI 表单生成，避免手写 TOML 字符串。导入文件含凭据，应保存在本地受限目录，勿提交到版本库。

## 数据所有权和兼容

Hub 自有 SQLite 继续使用运行时已验证的 `providers` 记录格式，但维护自己的 schema；`provider_sources` 记录来源和最近导入时间。外部导入为批量事务，格式校验失败不写入半批数据。相同导入重复执行默认幂等，本地编辑不会被静默覆盖。

为了保留已有路由、账号池和历史用量，0.2 不搬迁 `~/.cc-switch` 中原有的 Hub JSON 配置与日志。这些是 Hub 自身文件，目录名称不代表必须安装 CC Switch。定价可以继续通过 `~/.cc-switch/model-pricing.json` 提供。
