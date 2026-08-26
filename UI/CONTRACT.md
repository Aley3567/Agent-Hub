# CONTRACT.md — 数据契约 · IPC · 文件所有权

本文是**唯一数据真理来源**。子代理不需要读 Python 源码，照本文实现即可；本文与实际不符时
以本文为准并在 `UI/README.md` 的状态段记一句。

## 1. 数据源

全部位于 `~/.cc-switch/`（可被环境变量覆盖，Rust 侧按下表顺序解析）。

| 路径 | 权限 | 内容 | 覆盖变量 |
|---|---|---|---|
| `cc-switch.db` | **只读**（`mode=ro`） | SQLite，`providers` 表、`model_pricing` 表 | `CLAUDE1_DB_PATH` |
| `claude1-config.json` | 读写 | Agent Hub 本地覆盖：hidden / 别名 / 模型 / effort / routing | `CLAUDE1_CONFIG_PATH` |
| `claude1-mru.json` | 只读 | `{ "<provider name 或 id>": <unix 秒，float> }` 最近使用 | — |
| `claude-hub.json` | 读写 | 默认 hub 配置（槽位、端口、channels、routes） | — |
| `claude-hubs.json` | 只读 | 命名 hub 注册表 | — |
| `hubs/<name>.json` | 读写 | 命名 hub 各自配置，结构同 `claude-hub.json` | — |
| `agent-hub-tasks.json` | 读写 | 桌面端自有的计划任务清单（`ScheduledTask[]`，见 §2）。**唯一新增的可写文件**；写入纪律与 hub json 相同：原子替换 + 保留未知键 | `AGENT_HUB_TASKS_PATH` |
| `claude1-account-pools.json` | **只读**（首版） | 账号池 | — |
| `model-pricing.json` | 只读 | `{version, models: []}`，**当前为空**；为空时回退读 `cc-switch.db` 的 `model_pricing` 表，仍无价才不显示成本 | — |
| `logs/claude-hub-usage.jsonl` + `.bak-*` | 只读 | 用量 journal | — |
| `logs/claude-hub-errors.jsonl` | 只读 | 错误 journal | — |
| `logs/hubs/<name>-usage.jsonl` | 只读 | 命名 hub 的用量 journal | — |

### 1.1 `providers` 表实测 schema

```sql
CREATE TABLE providers (
  id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
  settings_config TEXT NOT NULL, website_url TEXT, category TEXT,
  created_at INTEGER, sort_index INTEGER, notes TEXT, icon TEXT, icon_color TEXT,
  meta TEXT NOT NULL DEFAULT '{}', is_current BOOLEAN NOT NULL DEFAULT 0,
  in_failover_queue BOOLEAN NOT NULL DEFAULT 0, cost_multiplier TEXT NOT NULL DEFAULT '1.0',
  limit_daily_usd TEXT, limit_monthly_usd TEXT, provider_type TEXT,
  PRIMARY KEY (id, app_type)
);
```

查询固定为：

```sql
SELECT id, name, settings_config, meta, is_current, in_failover_queue,
       category, notes, icon, icon_color, provider_type, created_at, sort_index
FROM providers WHERE app_type='claude' ORDER BY sort_index
```

**必须先 `PRAGMA table_info(providers)` 探测列是否存在，缺列则该字段返回 `null`**——CC Switch
升级 schema 时不能整个界面白屏。`app_type` 只取 `'claude'`（其余 `codex`/`gemini` 与本工具无关）。

`settings_config` 是 JSON 字符串，实测形状（**斜体键含凭证**）：

```text
env.ANTHROPIC_BASE_URL          → 端点（可显示）
env.ANTHROPIC_API_KEY           → 凭证，必须剥离
env.ANTHROPIC_AUTH_TOKEN        → 凭证，必须剥离
env.ANTHROPIC_MODEL             → 主模型
env.ANTHROPIC_DEFAULT_{FABLE,OPUS,SONNET,HAIKU}_MODEL[_NAME]  → 槽位默认模型
env.CLAUDE_CODE_SUBAGENT_MODEL  → 子代理固定值（doctor 要报它）
env.CLAUDE_CODE_MAX_CONTEXT_TOKENS / CLAUDE_CODE_AUTO_COMPACT_WINDOW
effortLevel                     → 'low'|'medium'|'high'|'xhigh'
auth_mode / transport.mode / transport.proxies[]
claude1_capabilities.context_window → int
model / language / outputStyle / permissions / hooks / statusLine / sandbox
```

`meta` 是 JSON 字符串：`apiFormat`（`anthropic` | `openai_chat` | `openai_responses`）、
`providerType`、`authBinding`、`commonConfigEnabled`、`endpointAutoSelect`、`usage_script`。

### 1.2 `model_pricing` 表实测 schema

```sql
CREATE TABLE model_pricing (
  model_id TEXT PRIMARY KEY, display_name TEXT NOT NULL,
  input_cost_per_million TEXT NOT NULL, output_cost_per_million TEXT NOT NULL,
  cache_read_cost_per_million TEXT NOT NULL DEFAULT '0',
  cache_creation_cost_per_million TEXT NOT NULL DEFAULT '0'
);
```

价是 TEXT 存的数字（每百万 token 美元），读取时转 f64；`model_id` 小写归一后做 key。
**表可能不存在**（老版本 CC Switch），读失败一律当空表，不阻断用量视图。
定价优先级：`model-pricing.json` 的 `models` 非空 → 用文件；否则 `model_pricing` 非空 → 用表；
都没有 → 不估算成本。任一模型无价 → 整体 `estimatedCostUsd = null`，绝不猜。

### 1.2 凭证脱敏（fail-closed）

Rust 侧构造 `Channel` 时**先剥离后返回**，凭证不允许出现在任何 IPC 响应里，包括调试字段。

- 剥离键名（大小写不敏感，子串匹配即命中）：`key`、`token`、`secret`、`password`、`auth`、
  `credential`、`cookie`、`authorization`、`bearer`。命中即替换为布尔 `configured` 标记。
- 端点 URL 保留，但**剥掉 userinfo 与查询串**（`https://u:p@h/x?k=v` → `https://h/x`）。<!-- secret-guard: allow embedded-url-credential（u/p/h 为占位符） -->
- `notes` 字段可能被用户塞过 key：整段过一遍
  `[A-Za-z0-9_\-]{24,}` 正则，命中即替换为 `••••`。
- 错误 journal 的 `message` 已由 Python 侧脱敏，但 UI 渲染前**再过一次同样的正则**。
- 上述剥离规则对 §2 的全部类型一体适用，包括后增的对话 / 插件 / 计划任务类型：
  `PluginItem.detail`、`ChatMessage.content` 等任何来自源数据的字符串，进 IPC 响应前都要过同一套剥离。

## 2. TypeScript 类型（`src/types/contract.ts`，两侧各一份，内容逐字相同）

```ts
export type ApiFormat = 'anthropic' | 'openai_chat' | 'openai_responses' | 'unknown';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';
export type SlotName = 'fable' | 'opus' | 'sonnet' | 'haiku';
export type Compatibility = 'compatible' | 'incompatible' | 'unassessed';

export interface Channel {
  id: string;
  name: string;
  /** claude1-config.json 里的独立别名，可直接 `claude1 <alias>` 启动 */
  alias: string | null;
  apiFormat: ApiFormat;
  /** 端点主机（已剥 userinfo 与 query），无则 null */
  endpoint: string | null;
  /** 凭证是否已配置。永远不含凭证本身 */
  credential: 'configured' | 'missing';
  /** DB 的 is_current：CC Switch 当前渠道 */
  isCurrent: boolean;
  inFailoverQueue: boolean;
  hidden: boolean;
  /** 本地覆盖，来自 claude1-config.json，null 表示未设置 */
  modelOverride: string | null;
  effortOverride: Effort | null;
  /** settings_config 声明的默认模型（只读展示） */
  declaredModel: string | null;
  slotModels: Partial<Record<SlotName, string>>;
  contextWindow: number | null;
  /** Claude Code 语义兼容性闸门结论 */
  compatibility: Compatibility;
  compatibilityReason: string | null;
  /** settings_config 固定了子代理模型，doctor 会建议清理 */
  pinsSubagentModel: boolean;
  category: string | null;
  notes: string | null;
  iconColor: string | null;
  /** claude1-mru.json 的 unix 秒，未用过为 null */
  lastUsedAt: number | null;
  sortIndex: number;
}

export interface HubChannel {
  name: string;
  /** `id:<provider-id>` 或 provider 名 */
  provider: string;
  /** 解析到的 Channel.id，解析失败为 null（界面要显示"未解析" */
  resolvedChannelId: string | null;
  apiFormat: ApiFormat | null;
  models: string[];
  proxy: string | null;
}

export interface RouteTarget { channel: string; model: string }

export interface HubConfig {
  /** hub 名；默认 hub 为 'claude-hub' */
  name: string;
  isDefault: boolean;
  version: number;
  port: number | null;
  localTokenEnv: string | null;
  defaultChannel: string | null;
  launchSlot: SlotName | null;
  /** 槽位 → "channel,model"，解析后的结构 */
  slots: Partial<Record<SlotName, { channel: string; model: string } | null>>;
  effortBySlot: Partial<Record<SlotName, Effort>>;
  channels: HubChannel[];
  routes: Record<string, RouteTarget[]>;
  /** 该 hub 是否有活着的进程（读 .lock + 端口探测，只探回环） */
  running: boolean;
  configPath: string;
}

export interface UsageRow {
  ts: number;                 // unix 秒
  channel: string;
  model: string;
  format: string;             // journal 里字段名就是 format
  source: 'upstream' | 'estimated' | string;
  in: number | null;          // input_tokens
  out: number | null;         // output_tokens
  cr: number | null;          // cache_read_input_tokens
  cw: number | null;          // cache_creation_input_tokens
  hub: string | null;         // instance id
  account: string | null;
  deg: string[];              // HUB_DEGRADE_* 列表
  cacheCreation: Record<string, number> | null;
  serverToolUse: Record<string, number> | null;
}

export interface ErrorRow {
  ts: number;
  phase: string;              // 'request' | 'response' | 'stream' | 'connect' | ...
  channel: string | null;
  model: string | null;
  format: string | null;
  status: number | null;      // HTTP 状态
  code: string | null;        // 上游错误 code
  message: string | null;     // 已脱敏
  exc: string | null;         // 异常类型名（journal 字段名是 exc）
  route: string | null;
  deg: string[];
}

/** 聚合结果，Rust 侧算好再给前端，避免在 JS 里遍历十万行 */
export interface UsageSummary {
  windowFrom: number;
  windowTo: number;
  totals: { in: number; out: number; cr: number; cw: number; turns: number };
  /** 缓存命中率 = cr / (in + cr)，无输入时为 null */
  cacheHitRate: number | null;
  byChannel: UsageBucket[];
  byModel: UsageBucket[];
  /** 按桶的时间序列，桶宽由 granularity 决定；cost 为该桶估算成本，桶内任一无价模型则为 null */
  series: { t: number; in: number; out: number; cr: number; turns: number; cost: number | null }[];
  granularity: 'hour' | 'day';
  /** 降级码计数，降序 */
  degradeCounts: { code: string; count: number }[];
  /** 定价缺失时为 null，绝不猜 */
  estimatedCostUsd: number | null;
  /** 成本定价来源：'pricing-file' = model-pricing.json；'cc-switch-db' = model_pricing 表；null = 无价可估 */
  costSource: 'pricing-file' | 'cc-switch-db' | null;
}

export interface UsageBucket {
  key: string;
  in: number; out: number; cr: number; cw: number; turns: number;
  cacheHitRate: number | null;
  degradedTurns: number;
}

export interface AccountPool {
  providerRef: string;
  resolvedChannelId: string | null;
  strategy: string;                 // 'weighted' | 'priority' | ...
  cooldownSeconds: number | null;
  maxCooldownSeconds: number | null;
  members: AccountMember[];
}

export interface AccountMember {
  providerRef: string;
  resolvedChannelId: string | null;
  displayName: string;
  weight: number;
  priority: number;
  enabled: boolean;
  /** 从 usage journal 的 account 字段统计出的最近使用与回合数 */
  lastUsedAt: number | null;
  turns: number;
}

export type DoctorLevel = 'ok' | 'info' | 'fail';

export interface DoctorCheck {
  id: string;
  level: DoctorLevel;
  title: string;
  detail: string | null;
  /** 有修复动作时给出 IPC 名，界面显示按钮 */
  fixAction: string | null;
}

export interface LaunchTarget {
  kind: 'channel' | 'slot' | 'hub';
  channelId?: string;
  hubName?: string;
  slot?: SlotName;
  model?: string;
}

export interface LaunchResult {
  ok: boolean;
  /** 实际执行的命令行，凭证已剥离，用于让用户看到"我到底跑了什么" */
  command: string;
  message: string;
}

export type DegradeSeverity = 'info' | 'notice' | 'degraded' | 'lossy';

export interface DegradeEntry {
  code: string;
  title: string;        // 中文人话标题
  what: string;         // 发生了什么
  impact: string;       // 对你的影响
  action: string;       // 建议动作
  severity: DegradeSeverity;
}

/** 对话消息。role/content 形状对齐 Anthropic 兼容的 POST /v1/messages（role + 文本 content）；
    本轮为演示数据，后端 seam 在 IPC 层，未来直连 claude-hub 时签名与形状不变 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  /** 文本内容；进 IPC 前按 §1.2 过一遍凭证剥离 */
  content: string;
  /** unix 秒 */
  ts: number;
}

/** 对话会话。本轮只做 UI 骨架 + 演示数据，不接真实后端 */
export interface ChatSession {
  id: string;
  title: string;
  /** 关联 Channel.id，未绑定渠道为 null */
  channelId: string | null;
  model: string;
  messages: ChatMessage[];
  createdAt: number;    // unix 秒
  updatedAt: number;    // unix 秒
}

/** Claude Code 配置扩展点（hooks / outputStyle / statusLine / permissions / mcp）。
    边界：DB 只读 → 渠道级 settings_config 里的扩展点只读展示，不可写；
    可写项（enabled 切换）只落到 `claude1-config.json` 的本地覆盖，绝不写 DB */
export interface PluginItem {
  id: string;
  kind: 'hook' | 'outputStyle' | 'statusLine' | 'permissions' | 'mcp';
  name: string;
  /** 'global' = 全局配置；'channel' = 渠道级（来自 settings_config，只读） */
  scope: 'global' | 'channel';
  /** scope 为 'channel' 时是 Channel.id，否则为 null */
  channelId: string | null;
  enabled: boolean;
  /** 一行人话说明这是什么 */
  summary: string;
  /** 展开的原始配置摘要（已按 §1.2 剥离凭证），无则 null */
  detail: string | null;
}

/** 计划任务：定时启动会话 / 定时体检提醒。桌面端只管本地任务清单（CRUD + 展示），
    持久化到 `agent-hub-tasks.json`；执行层本轮不做 */
export interface ScheduledTask {
  id: string;
  name: string;
  kind: 'launch-channel' | 'launch-slot' | 'doctor-reminder';
  /** 复用 LaunchTarget 的形状（子集）：launch-channel → {kind:'channel', channelId, model?}；
      launch-slot → {kind:'slot', hubName?, slot, model?}；doctor-reminder 为 null */
  target: LaunchTarget | null;
  /** cron 五字段字符串（分 时 日 月 周），解析与计算都在 Rust 侧 */
  schedule: string;
  /** schedule 的中文人话，如「每工作日 09:00」，由 Rust 侧生成 */
  scheduleText: string;
  enabled: boolean;
  /** unix 秒，未跑过为 null */
  lastRunAt: number | null;
  /** unix 秒，由 Rust 侧按 cron 计算返回，前端不自算；disabled 时为 null */
  nextRunAt: number | null;
  createdAt: number;    // unix 秒
}

/** create_task 的入参：id / 时间戳 / scheduleText / nextRunAt 都由 Rust 侧补全 */
export interface NewScheduledTask {
  name: string;
  kind: ScheduledTask['kind'];
  target: LaunchTarget | null;
  schedule: string;
  enabled: boolean;
}
```

## 3. IPC 命令（Rust `#[tauri::command]`）

命名用 snake_case，前端在 `src/api/index.ts` 里包一层同名 camelCase 函数。**所有命令都必须
返回 `Result<T, String>`，错误字符串直接是给人看的中文原因**（沿用 CLAUDE.md：错误原样暴露，
不伪装成功）。

| 命令 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `list_channels` | — | `Channel[]` | 含 hidden 项，前端自己过滤 |
| `set_channel_hidden` | `id, hidden` | `()` | 写 `claude1-config.json` |
| `set_channel_alias` | `id, alias: string \| null` | `()` | 别名冲突/保留字须返回中文错误 |
| `set_channel_override` | `id, model: string\|null, effort: Effort\|null` | `()` | 只写本地配置，**绝不写 DB** |
| `list_hubs` | — | `HubConfig[]` | 默认 hub + 命名 hub |
| `set_hub_slot` | `hubName, slot, channel: string\|null, model: string\|null` | `()` | 写对应 hub json，原子替换 + 保留未知键 |
| `set_hub_slot_effort` | `hubName, slot, effort: Effort\|null` | `()` | |
| `usage_summary` | `hubName?: string, fromTs, toTs, granularity` | `UsageSummary` | 流式读 jsonl，不整体载入内存 |
| `recent_usage` | `limit, hubName?` | `UsageRow[]` | 倒序最近 N 行 |
| `recent_errors` | `limit` | `ErrorRow[]` | 倒序 |
| `list_account_pools` | — | `AccountPool[]` | 池文件缺失返回空数组，不报错 |
| `run_doctor` | — | `DoctorCheck[]` | 纯本地只读，不连上游 |
| `doctor_fix_subagent_pins` | — | `DoctorCheck[]` | 备份后清理，重跑体检 |
| `launch` | `LaunchTarget` | `LaunchResult` | 在终端中启动会话，见 §3.1 |
| `app_env` | — | `{ platform, appVersion, tauriVersion, dbPath, configPath, logsDir, hasClaudeBin, pythonVersion }` | 设置页与 doctor 用 |
| `open_path` | `path` | `()` | 用系统默认程序打开（只允许 `~/.cc-switch/` 下路径） |
| `reveal_in_folder` | `path` | `()` | 同上白名单 |
| `list_chat_sessions` | — | `ChatSession[]` | 本轮恒走演示实现：返回内置演示会话，不连任何上游；真后端接入时签名不变 |
| `send_chat_message` | `sessionId, content` | `ChatMessage` | 本轮恒走演示实现：Rust 侧返回内置演示回复（内容按 Anthropic 消息形状构造，前端模拟流式逐字呈现），不连任何上游；真后端接入时签名不变 |
| `list_plugins` | — | `PluginItem[]` | 聚合全局与渠道级扩展点：只读源 + `claude1-config.json` 本地覆盖合并后返回 |
| `set_plugin_enabled` | `id, enabled` | `()` | 只写 `claude1-config.json` 的本地覆盖；对只读来源（渠道级 settings_config）的项返回中文错误说明不可写 |
| `list_tasks` | — | `ScheduledTask[]` | 读 `agent-hub-tasks.json`，文件缺失返回空数组，不报错 |
| `create_task` | `task: NewScheduledTask` | `ScheduledTask` | 写 `agent-hub-tasks.json`（原子替换 + 保留未知键）；`nextRunAt` 由 Rust 侧按 cron 计算返回，前端不自算 |
| `update_task` | `id, patch: {enabled?, schedule?, name?}` | `ScheduledTask` | 同上；改了 `schedule` 或 `enabled` 时重算 `nextRunAt` |
| `delete_task` | `id` | `()` | 同上；id 不存在返回中文错误 |

### 3.1 `launch` 的实现边界

桌面端**不自己起会话进程**，而是拼出与 CLI 等价的命令交给终端：

- macOS：`osascript` 让 Terminal.app（或 `$TERM_PROGRAM` 对应的 iTerm）新窗口执行
  `claude1 <selector>`。
- Windows：`cmd /c start wt.exe -- <cmd>`，`wt` 不存在时退回 `powershell`。

`LaunchResult.command` 必须回显真实命令。找不到 `claude1` 时返回中文错误，**不静默失败**。

## 4. Mock 数据（`src/api/mock.ts`）

Rust 不可用时（浏览器里跑 `npm run dev:renderer`、或 IPC 抛错）自动回退到 mock，并在
StatusBar 显示琥珀色 `离线示例数据` 徽章——**绝不让假数据冒充真实数据**。

判定：`typeof window.__TAURI_INTERNALS__ === 'undefined'` 即视为无 Rust 环境。

mock 至少提供：8 个渠道（覆盖三种 apiFormat、1 个 hidden、1 个 incompatible、1 个 isCurrent）、
2 个 hub（一个 running）、400 行 usage（跨 7 天、含 6 种降级码）、30 行 errors（含 4xx/5xx/超时/
连接失败）、2 个账号池、10 条 doctor 结果（含 2 个 fail）。
另需：3 个对话会话（合计 ≥12 条消息，覆盖 user/assistant/system 三种 role，含一条演示降级提示，
如「当前为演示数据，未连接真实后端」）、10 个插件项（五种 kind 全覆盖，含只读与可写两态）、
4 个计划任务（三种 kind 全覆盖、1 个 disabled、`nextRunAt` 为过去与将来各一）。

## 5. 降级码目录

`src/data/degradeCatalog.ts` **已由编排者写好，是 35 个码的人话译文，子代理禁止改写内容**；
`UI/windows` 侧逐字复制同一文件。未收录的码走兜底：标题取 code 去前缀后转中文不可得时，
直接显示原码 + 「未收录的降级类型，请把这个码发给作者」。

## 6. 文件所有权（**并发写入的唯一冲突边界，越界即视为错误**）

每个子代理只允许创建/修改自己名下的路径。需要别人的文件时，按本文的类型与签名直接
import，不去改它。

| 所有者 | 路径 |
|---|---|
| 编排者（已完成） | `UI/README.md`、`UI/DESIGN.md`、`UI/CONTRACT.md`、`UI/macos/src/data/degradeCatalog.ts` |
| `mac-scaffold` | `UI/macos/package.json`、`.gitignore`、`index.html`、`vite.config.ts`、`tsconfig*.json`、`src/styles/**`、`src/vite-env.d.ts`、`src-tauri/{Cargo.toml,build.rs,tauri.conf.json,capabilities/**,icons/**}` |
| `mac-backend` | `UI/macos/src-tauri/src/**`、`UI/macos/src/types/contract.ts`、`UI/macos/src/api/**` |
| `mac-primitives` | `UI/macos/src/components/**`、`src/lib/**` |
| `mac-shell` | `UI/macos/src/main.tsx`、`src/App.tsx`、`src/shell/**`、`src/store/**` |
| `view-channels` | `UI/macos/src/views/channels/**` |
| `view-slots` | `UI/macos/src/views/slots/**` |
| `view-observability` | `UI/macos/src/views/usage/**`、`src/views/diagnostics/**` |
| `view-ops` | `UI/macos/src/views/accounts/**`、`src/views/doctor/**`、`src/views/settings/**` |
| `view-chat` | `UI/macos/src/views/chat/**` |
| `view-plugins` | `UI/macos/src/views/plugins/**` |
| `view-tasks` | `UI/macos/src/views/tasks/**` |
| `win-shell` | `UI/windows/**`（除 `src/views/**`） |
| `win-views` | `UI/windows/src/views/**` |

三个新视图在 Windows 侧的对应目录（`UI/windows/src/views/{chat,plugins,tasks}/**`）同归
`win-views`，沿用 `src/views/<name>/index.tsx` 默认导出无 props 组件的形式。

### 6.1 视图的统一契约

每个视图目录必须有 `index.tsx`，默认导出一个**无 props 的组件**，自己从 store 取数据：

```ts
// src/views/<name>/index.tsx
export default function ChannelsView() { /* ... */ }
```

`mac-shell` 的路由表按固定路径 lazy import 这十个视图，因此**目录名与导出形式不可更改**：

```ts
const VIEWS = {
  chat:        () => import('../views/chat'),
  channels:    () => import('../views/channels'),
  slots:       () => import('../views/slots'),
  usage:       () => import('../views/usage'),
  diagnostics: () => import('../views/diagnostics'),
  accounts:    () => import('../views/accounts'),
  doctor:      () => import('../views/doctor'),
  plugins:     () => import('../views/plugins'),
  tasks:       () => import('../views/tasks'),
  settings:    () => import('../views/settings'),
} as const;
```

键的顺序即侧栏分组顺序：chat 在 channels 前，plugins/tasks 在 doctor 后、settings 前。

### 6.2 Store 契约（`mac-shell` 提供，视图消费）

```ts
// src/store/index.ts
export interface AppState {
  channels: Channel[]; hubs: HubConfig[]; pools: AccountPool[];
  usage: UsageSummary | null; recentUsage: UsageRow[]; errors: ErrorRow[];
  doctor: DoctorCheck[];
  chatSessions: ChatSession[]; plugins: PluginItem[]; tasks: ScheduledTask[];
  env: AppEnv | null;
  offline: boolean;                 // 使用 mock 数据
  loading: Record<string, boolean>; // 按 key 的加载态
  error: Record<string, string | null>;
  loadedKeys: Record<string, boolean>; // 该 key 是否至少完成过一次加载（成败都算）；
                                       // 空态只准在 loadedKeys[key]===true 且数据为空时出现
  // refresh 永不抛出；await 后读 error[key]===null 即成功，非 null 即失败原因原文
  refresh(key: 'channels'|'hubs'|'pools'|'usage'|'errors'|'doctor'|'env'|'chat'|'plugins'|'tasks'): Promise<void>;
  refreshAll(): Promise<void>;
  // 动作直通 IPC，成功后自动 refresh 相关 key
  setHidden(id: string, hidden: boolean): Promise<void>;
  setAlias(id: string, alias: string | null): Promise<void>;
  setOverride(id: string, model: string | null, effort: Effort | null): Promise<void>;
  setSlot(hub: string, slot: SlotName, channel: string | null, model: string | null): Promise<void>;
  setSlotEffort(hub: string, slot: SlotName, effort: Effort | null): Promise<void>;
  launch(target: LaunchTarget): Promise<LaunchResult>;
  sendChatMessage(sessionId: string, content: string): Promise<ChatMessage>;   // 成功后自动 refresh('chat')
  setPluginEnabled(id: string, enabled: boolean): Promise<void>;               // 成功后自动 refresh('plugins')
  createTask(task: NewScheduledTask): Promise<ScheduledTask>;                  // 成功后自动 refresh('tasks')
  updateTask(id: string, patch: {enabled?: boolean; schedule?: string; name?: string}): Promise<ScheduledTask>; // 成功后自动 refresh('tasks')
  deleteTask(id: string): Promise<void>;                                       // 成功后自动 refresh('tasks')
  // 以下失败时抛出，原因原文在 error.<方法名>
  doctorFixSubagentPins(): Promise<DoctorCheck[]>; // 成功后直接落 state.doctor
  openPath(path: string): Promise<void>;
  revealInFolder(path: string): Promise<void>;
  usageRange: { fromTs: number; toTs: number; granularity: 'hour'|'day' };
  setUsageRange(r: Partial<AppState['usageRange']>): void;
}
export const useApp: UseBoundStore<StoreApi<AppState>>;
```

另有导航 store：

```ts
// src/store/nav.ts
// VIEWS 扩为十项后，ViewId 自动包含 'chat' | 'plugins' | 'tasks'，此处无需手写联合类型
export type ViewId = keyof typeof VIEWS;
export interface NavState {
  view: ViewId; setView(v: ViewId): void;
  // 折叠状态持久化到 localStorage（key: claude1.desktop.sidebar-collapsed）
  sidebarCollapsed: boolean; toggleSidebar(): void;
  paletteOpen: boolean; setPaletteOpen(o: boolean): void;
  theme: 'system'|'dark'|'light'; setTheme(t: NavState['theme']): void;
  // 视图可注册自己的 reload，壳层"刷新"优先转发；卸载时必须传 null 注销
  viewReloads: Partial<Record<ViewId, () => void | Promise<void>>>;
  registerViewReload(view: ViewId, reload: (() => void | Promise<void>) | null): void;
}
export const useNav: UseBoundStore<StoreApi<NavState>>;
```

壳层刷新走 `src/shell/views.ts` 的统一入口：`refreshView(view)` 优先转发视图注册的 reload，
未注册则按 `VIEW_REFRESH_KEY: Record<ViewId, RefreshKey[]>` 逐个刷新（数组口径与各视图
自身 reload 一致，如 diagnostics = errors + usage）。

### 6.3 组件清单（`mac-primitives` 提供，视图只消费不新建同名组件）

`src/components/` 导出：`Button`、`IconButton`、`Input`、`Textarea`、`Select`、`Switch`、
`SegmentedControl`、`Badge`、`StatusDot`、`Tooltip`、`Dialog`、`Table`（+`Th`/`Td`/`MidTruncate`）、
`EmptyState`、`CodeBlock`、`Spinner`、`Field`、`Card`、`SectionHeader`、`Toolbar`、
`SearchInput`、`Icon`（含 `IconName` 联合类型）。

`src/components/charts/` 导出：`Sparkline`、`BarChart`、`TimeSeries`、`Donut`。

`src/lib/` 导出：`formatTokens(n)`、`formatTime(ts)`、`formatRelative(ts)`、`formatPercent(x)`、
`redactSecrets(s)`、`cx(...)`、`fuzzyMatch(query, text)`。

视图确实需要新原语时，放在自己目录下的 `parts/`，不污染 `components/`。

### 6.4 `IconName` 固定清单（`Icon` 组件必须全部实现，视图只能用这些名字）

线性风格，`stroke-width: 1.5`，`viewBox="0 0 24 24"`，`currentColor` 取色，尺寸默认 16。

```ts
export type IconName =
  // 导航
  | 'channels' | 'slots' | 'usage' | 'diagnostics' | 'accounts' | 'doctor' | 'settings'
  | 'chat' | 'plugins' | 'tasks'
  // 动作
  | 'search' | 'plus' | 'close' | 'check' | 'refresh' | 'play' | 'copy' | 'edit'
  | 'trash' | 'external' | 'filter' | 'download' | 'reveal' | 'send' | 'puzzle' | 'calendar'
  // 状态与语义
  | 'warning' | 'error' | 'info' | 'success' | 'dot' | 'clock' | 'zap' | 'lock'
  | 'star' | 'eye' | 'eye-off' | 'pin'
  // 结构
  | 'chevron-right' | 'chevron-down' | 'chevron-left' | 'chevron-up'
  | 'sidebar' | 'terminal' | 'database' | 'network' | 'link' | 'brain' | 'coins'
  // 主题
  | 'moon' | 'sun' | 'monitor'
  // Windows 自绘窗口按钮（仅 windows 工程使用，macOS 侧也要实现以保持文件一致）
  | 'win-minimize' | 'win-maximize' | 'win-restore' | 'win-close';
```

### 6.5 视图内的固定文案锚点

十个视图的标题与副标题固定如下，命令面板与侧栏都引用它们（`src/shell/views.ts` 导出）：

| view | 侧栏标签 | 视图标题 | 副标题（一句话说清这页在回答什么问题） |
|---|---|---|---|
| `chat` | 对话 | 对话 | 和当前渠道直接说上话，验证配置是不是真的能用 |
| `channels` | 渠道 | 渠道 | 哪些渠道可用、各自说什么协议、这次用哪个 |
| `slots` | 槽位 | 模型槽位 | 四个槽位分别绑到哪个渠道的哪个模型 |
| `usage` | 用量 | 用量与成本 | token 花在哪儿、缓存命中多少 |
| `diagnostics` | 诊断 | 诊断 | 失败了什么、悄悄降级了什么 |
| `accounts` | 账号池 | 账号池 | 同一渠道的多个账号怎么轮换 |
| `doctor` | 体检 | 本机体检 | 本机配置有没有问题，只读不联网 |
| `plugins` | 插件 | 插件 | hooks、输出风格、状态栏、权限这些扩展点各自是什么状态 |
| `tasks` | 任务 | 计划任务 | 哪些事被定时触发，下一次什么时候跑 |
| `settings` | 设置 | 设置 | 外观、路径与本机环境 |
