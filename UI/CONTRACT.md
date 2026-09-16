# CONTRACT.md — 数据契约 · IPC · 文件所有权

本文是**唯一数据真理来源**。子代理不需要读 Python 源码，照本文实现即可；本文与实际不符时
以本文为准并在 `UI/README.md` 的状态段记一句。

## 1. 数据源

Provider 默认位于 `~/.agent-hub/`；已有 Hub JSON、日志和定价文件仍位于 `~/.cc-switch/`，这些文件不依赖 CC Switch 安装。渠道读取、Hub 写入、外部导入和可选定价库各自解析路径。

| 路径 | 权限 | 内容 | 覆盖变量 |
|---|---|---|---|
| `~/.agent-hub/providers.db` | 桌面/CLI/TUI 经共享层显式写入（Windows 新凭证写入待原生验收） | Hub `providers` 与 `provider_sources` 表 | 读：`CLAUDE1_DB_PATH` → `AGENT_HUB_PROVIDER_DB` → 默认；写：仅 `AGENT_HUB_PROVIDER_DB` → 默认 |
| 显式指定的定价 SQLite | **只读** | 可选 `model_pricing` 表，与渠道 DB 独立 | `AGENT_HUB_PRICING_DB`，未指定不读 DB |
| `claude1-config.json` | 读写 | Agent Hub 本地覆盖：hidden / 别名 / 模型 / effort / routing | `CLAUDE1_CONFIG_PATH` |
| `claude1-mru.json` | 只读 | `{ "<provider name 或 id>": <unix 秒，float> }` 最近使用 | — |
| `claude-hub.json` | 读写 | 默认 hub 配置（槽位、端口、channels、routes） | `CLAUDE_HUB_CONFIG`（**仅** `chat_hub` 与 `doctor` 读它；`hubs.rs` 的 hub 列表仍按 `~/.cc-switch/claude-hub.json` 解析，这个偏差见 §3.2 说明） |
| `claude-hubs.json` | 只读 | 命名 hub 注册表 | — |
| `hubs/<name>.json` | 读写 | 命名 hub 各自配置，结构同 `claude-hub.json` | — |
| `agent-hub-tasks.json` | 读写 | 桌面端自有的计划任务清单（`ScheduledTask[]`，见 §2）。写入纪律与 hub json 相同：原子替换 + 保留未知键 | `AGENT_HUB_TASKS_PATH` |
| `agent-hub-chat.json` | 读写（0600） | 桌面端自有的对话：本地会话 + 当前选中项目。写入纪律同 `agent-hub-tasks.json`。**不是凭证存储**，只存已脱敏的对话正文 | `AGENT_HUB_CHAT_PATH` |
| `~/.claude/projects/<key>/*.jsonl` | **只读** | Claude Code 的会话 transcript，chat 历史回放的唯一来源。只读枚举，不走 `paths::ensure_inside` 白名单；正文进 IPC 前按 §1.2 剥离 | `CLAUDE_CONFIG_DIR` / `CLAUDE1_CLAUDE_HOME`（取该目录下的 `projects/`） |
| `claude1-account-pools.json` | **只读**（首版） | 账号池 | — |
| `model-pricing.json` | 只读 | `{version, models: []}`；非空优先，为空仅尝试显式定价库，仍无价不估算费用 | — |
| `logs/claude-hub-usage.jsonl` + `.bak-*` | 只读 | 用量 journal | — |
| `logs/claude-hub-errors.jsonl` | 只读 | 错误 journal | — |
| `logs/hubs/<name>-usage.jsonl` | 只读 | 命名 hub 的用量 journal | — |

### 1.1 Hub provider schema 与展示投影

唯一 schema 为根 `provider-schema.sql`。Hub 维护 application_id `1095259458`（AHUB）和自己的 `provider_sources`，不跟随 CC Switch 的 `user_version`。共享层拒绝把外部库当写目标；外部来源仅显式只读导入。macOS 管理命令已接不可变系统凭证引用与显式迁移；旧记录仍兼容读取。Windows 新写/迁移后端未放行，Linux 保留受保护的旧格式写入。真实运行验收状态见 S25。

```sql
CREATE TABLE providers (
  id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL,
  settings_config TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}',
  category TEXT, provider_type TEXT, is_current BOOLEAN NOT NULL DEFAULT 0,
  in_failover_queue BOOLEAN NOT NULL DEFAULT 0, sort_index INTEGER,
  credential_ref TEXT, credential_version INTEGER, revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, app_type)
);
```

桌面投影保留外部兼容列 `notes`、`icon_color` 等；这些列不是 Hub 必需 schema，不能为了迁入简表 DTO 丢弃已有显示字段。

查询固定为：

```sql
SELECT id, app_type, credential_ref, name, settings_config, meta, is_current, in_failover_queue,
       category, notes, icon, icon_color, provider_type, created_at, sort_index
FROM providers WHERE app_type IN ('claude','codex') ORDER BY sort_index
```

**必须先 `PRAGMA table_info(providers)` 探测可选展示列，缺列则该字段返回 `null`**；
兼容库可选列缺失时不能整个界面白屏。渠道投影与列表 key 使用 `(appType,id)`；Claude 专用槽位、账号池、别名与本地覆盖只接受 Claude。旧任务缺失 appType 时默认为 Claude，Codex 不得进入槽位任务。Codex 历史只有明确 providerApp/providerId 才绑定渠道；旧 Claude gateway journal 可按名称/别名匹配。

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
**表可能不存在**；显式定价库不存在或读失败时当空表，不阻断用量视图。
定价优先级：`model-pricing.json` 的 `models` 非空 → 用文件；否则仅当 `AGENT_HUB_PRICING_DB` 显式指定且 `model_pricing` 非空 → 用表；
都没有 → 不估算成本。任一模型无价 → 整体 `estimatedCostUsd = null`，绝不猜。

### 1.2 凭证脱敏（fail-closed）

Rust 侧构造 `Channel` 时**先剥离后返回**，凭证不允许出现在任何 IPC 响应里，包括调试字段。

- 剥离键名（大小写不敏感，子串匹配即命中）：`key`、`token`、`secret`、`password`、`auth`、
  `credential`、`cookie`、`authorization`、`bearer`。命中即替换为布尔 `configured` 标记。
- 端点 URL 保留，但**剥掉 userinfo 与查询串**（`https://u:p@h/x?k=v` → `https://h/x`）。<!-- secret-guard: allow embedded-url-credential（u/p/h 为占位符） -->
- `notes` 字段可能被用户塞过 key：整段过一遍
  `[A-Za-z0-9_\-]{24,}` 正则，命中即替换为 `••••`。
- 错误 journal 的 `message` 已由 Python 侧脱敏，但 UI 渲染前**再过一次同样的正则**。
- **第二道闸的已登记偏离**（`src/lib/redact.ts` `LONG_RUN`）：前端复扫正则字符类是
  `[A-Za-z0-9+/]{24,}`，比第一道少 `-`/`_` 两个字符——模型 id（`claude-opus-5`、
  `gpt-4_1` 等）形态的串必须在界面上原样显示，而含 `-`/`_` 的凭证形状由 Rust 侧
  第一道 `redact_text`（字符类含 `-`/`_`）兜底。每段 `<24` 字符的 `glpat-` 风格
  token 第二道闸不命中，这是用换来的取舍，不是疏漏。
- 上述剥离规则对 §2 的全部类型一体适用，包括后增的对话 / 插件 / 计划任务类型：
  `PluginItem.detail`、`ChatMessage.content` 等任何来自源数据的字符串，进 IPC 响应前都要过同一套剥离。
  本地回显（如 chat 的 pending 消息、回复摘录）没过第一道，渲染前必须过第二道。
  **这条一体适用于事件通道的 payload**（§3.2 的 `chat-stream*`），以及
  `~/.claude/projects` 里读出来的 transcript 正文——后者是仓库里第一次把历史对话正文
  送到 renderer，脱敏是新增的必需环节，不是既有保障。

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
  /** pricing-file：本地文件；pricing-db：显式指定的定价库；旧名称只兼容旧响应 */
  costSource: 'pricing-file' | 'pricing-db' | 'cc-switch-db' | 'hub-db' | null;
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

/** 对话消息。role/content 形状对齐 Anthropic 兼容的 POST /v1/messages（role + 文本 content）。
    历史会话的正文来自 `~/.claude/projects` 的 transcript；thinking / tool_use / tool_result
    块在 Rust 侧拍平成文本占位，所以这里恒为纯文本，不引入 block 数组 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  /** 文本内容；进 IPC 前按 §1.2 过一遍凭证剥离 */
  content: string;
  /** unix 秒 */
  ts: number;
}

/** 对话会话。两类来源：history 是只读回放的历史 transcript（不可发送），
    local 是本应用新建、经 hub 真发送的会话（落 `agent-hub-chat.json`） */
export interface ChatSession {
  id: string;
  title: string;
  /** 关联 Channel.id，未绑定渠道为 null */
  channelId: string | null;
  model: string;
  messages: ChatMessage[];
  createdAt: number;    // unix 秒
  updatedAt: number;    // unix 秒
  /** history = 只读回放；local = 可写、走 hub 真发送 */
  source: 'history' | 'local';
  /** 仅 local 有意义：绑定的 hub id；null = 默认 hub */
  hubName: string | null;
  /** 仅 history 有意义：来源项目目录 key（`~/.claude/projects` 下的目录名） */
  projectKey: string | null;
}

/** `~/.claude/projects` 下的一个项目目录。
    key 到真实路径**不可逆**（`-` 与路径里的连字符有歧义），所以 path 取 transcript
    里的 `cwd` 字段，不由 key 反解 */
export interface ChatProject {
  key: string;
  path: string;
  sessionCount: number;
  updatedAt: number;    // unix 秒
}

/** 流式增量事件 `chat-stream` 的 payload */
export interface ChatStreamChunk {
  sessionId: string;
  requestId: string;
  delta: string;
}

/** 流终态事件 `chat-stream-end` 的 payload。
    reason 为 `truncated` 表示上游没发终止帧就干净结束了：本轮收到的正文已落盘，
    并由一条 system 消息说明截断。**绝不补 `message_stop`**（失败不伪装成功） */
export interface ChatStreamEnd {
  sessionId: string;
  requestId: string;
  reason: 'stop' | 'truncated';
  stopReason: string | null;
}

/** 流失败事件 `chat-stream-error` 的 payload。message 已按 §1.2 剥离。
    带 sessionId / requestId 是为了让前端能把错误归因到具体某次发送——
    没有它就只能靠「缓冲还在就是在途」去猜，迟到的旧流错误会误伤新流 */
export interface ChatStreamError {
  sessionId: string;
  requestId: string;
  message: string;
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

/** schedule 的结构化解释。
    人话文案**由前端按当前语言渲染**，Rust 只给结构——英文界面下不出现中文人话。
    `unknown` 是兜底：认不出的表达式原样回显，不硬翻（翻错比不翻更糟），
    典型如 `0 9 1 * 1,3,5`（日与周同时受限，Vixie 惯例取「或」，翻成人话必然误导） */
export type ScheduleSpec =
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; minute: number; hour: number }
  /** days：0 = 周日 … 6 = 周六，升序去重 */
  | { kind: 'weekly'; minute: number; hour: number; days: number[] }
  | { kind: 'monthly'; minute: number; hour: number; day: number }
  | { kind: 'everyMinutes'; period: number }
  | { kind: 'unknown'; raw: string };

/** 应用运行期间定时派发会话 / 记录体检提醒；不补跑退出期间的任务。 */
export interface ScheduledTask {
  id: string;
  name: string;
  kind: 'launch-channel' | 'launch-slot' | 'doctor-reminder';
  /** 复用 LaunchTarget 的形状（子集）：launch-channel → {kind:'channel', channelId, model?}；
      launch-slot → {kind:'slot', hubName?, slot, model?}；doctor-reminder 为 null */
  target: LaunchTarget | null;
  /** cron 五字段字符串（分 时 日 月 周），解析与计算都在 Rust 侧 */
  schedule: string;
  /** schedule 的结构化解释，人话文案由前端按当前语言渲染 */
  scheduleSpec: ScheduleSpec;
  /** 降级或异常备注（cron 无法解析、kind 不在支持列表等），由前端一并展示。
      独立成字段是为了让「有损但可观测」的记号在双语界面下也能如实呈现 */
  notes: string[];
  enabled: boolean;
  /** unix 秒，未跑过为 null */
  lastRunAt: number | null; // Last dispatch attempt, not session completion
  lastRunStatus?: 'unconfirmed' | 'dispatched' | 'reminded' | 'failed' | null;
  lastRunMessage?: string | null;
  /** unix 秒，由 Rust 侧按 cron 计算返回，前端不自算；disabled 时为 null */
  nextRunAt: number | null;
  createdAt: number;    // unix 秒
}

/** create_task 的入参：id / 时间戳 / scheduleSpec / nextRunAt 都由 Rust 侧补全 */
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
| `open_path` | `path` | `()` | 用系统默认程序打开（历史状态目录内，或精确匹配当前 provider DB；不放行其父目录/相邻文件） |
| `reveal_in_folder` | `path` | `()` | 同上白名单 |
| `list_chat_sessions` | — | `ChatSession[]` | 当前选中项目的历史会话（只读回放）+ 本应用新建的本地会话。**签名与返回形状未变**，语义已从演示实现换成真实数据源 |
| `send_chat_message` | `sessionId, content` | `ChatMessage` | 走 hub 真发送。Rust 侧新增 `AppHandle` 首参（JS 可见签名不变），流式增量经 §3.2 的事件通道投递；返回值是落盘后的最终副本。历史会话（`source === 'history'`）一律拒绝 |
| `chat_projects` | — | `ChatProject[]` | 枚举 `~/.claude/projects` 下**真有 transcript** 的项目目录。只读，不走 `paths::ensure_inside` 白名单 |
| `select_chat_project` | `key` | `()` | 记住当前项目，落 `agent-hub-chat.json` 的 `selectedProject`。未选中 = 不显示任何历史 |
| `create_chat_session` | `hubName, channelId` | `ChatSession` | 新建本地会话。模型取该渠道的本地覆盖或声明模型；两者皆无则报中文错误，**不编默认模型名** |
| `delete_chat_session` | `id` | `()` | 只删本地会话；历史会话不可删 |
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

### 3.2 对话流式事件通道（`chat-stream*`）

对话的流式增量不走 IPC 回执，走 Tauri event——一条命令只能有一个返回值，而流式要的是
「随时到达的增量」。payload 一律 `#[serde(rename_all = "camelCase")]`：

| 事件 | payload | 语义 |
|---|---|---|
| `chat-stream` | `ChatStreamChunk` | 增量片段，非终态 |
| `chat-stream-end` | `ChatStreamEnd` | **唯一**的成功 / 截断终态 |
| `chat-stream-error` | `ChatStreamError` | 失败终态 |

**终态纪律（「失败不伪装成功」的落点）**：

- 收到上游 `message_stop` → `reason: "stop"`，落盘 assistant 消息
- 流干净结束但**没有**收到终止帧 → `reason: "truncated"`，把已收到的正文落盘，
  并附一条 system 消息说明截断。**绝不补一个 `message_stop` 出来**
- 传输层错误 / 超时 / 收到上游 `error` 事件 → 发 `chat-stream-error`，
  **不落盘 assistant 消息**，命令本身也返回 `Err`
- 前端收到 error 时**不得在消息流里插入任何 assistant 气泡**——只在 toast 里如实报错

**超时**：连接超时 2 秒；两个 chunk 之间允许的最长静默 120 秒（reqwest `read_timeout`，
即单次读的空闲上限）；整条流 deadline 600 秒，在 chunk 之间检查。不用 reqwest 的全局
`.timeout()`——那是「整条响应必须在 N 秒内结束」，会把正常长回复腰斩且原因被伪装成超时。
静默窗取 120 秒而非更小，依据 `docs/sse-truncation-fix-2026-08-26.md` 的实测：
真 Claude Code 对 75 秒纯静默耐受无恙，hub 自身的上游保护窗是 45 秒——客户端必须让
hub 先按它的窗口收尾并发出真实终态帧，不能抢先把一次合法长思考判成失败。

**凭证边界**：`local_token` 只在 Rust 侧的发送流程里作为局部值存在，
**不进任何序列化结构体、不进事件 payload、不进错误字符串**。解析顺序为
「hub 配置的 `local_token_env`（缺省 `CLAUDE_HUB_LOCAL_TOKEN`）→ 配置文件里的
`local_token` 键」，两者皆无则报错，**绝不发不带 Authorization 的请求**。
所有 `Err` 与事件 payload 里的文本都要过 `redact::redact_text`；HTTP 错误页会先截断
到 500 字符、再把 `Authorization` 整行打码，然后才过闸——响应体回显请求头是这条链路上
最容易漏的一处。

**已知偏差（`CLAUDE_HUB_CONFIG`）**：该变量目前只被 `chat_hub::resolve_target`（默认 hub）
与 `doctor.rs` 读取，`hubs.rs` 的 hub 列表仍按 `~/.cc-switch/claude-hub.json` 解析。
设了这个变量时，界面上的 hub 与对话实际发送的目标可能不是同一个文件。
CLI 侧（`claude-hub.py:112`）认这个变量，所以这是桌面端内部的不一致，不是与 CLI 的不一致。
本机当前未设置该变量，所以这条偏差暂无实际影响；要消除得让 `hubs.rs` 的默认 hub
也走 `paths::default_hub_config_path()`。

## 4. Mock 数据（`src/api/mock.ts`）

Rust 不可用时（浏览器里跑 `npm run dev:renderer`、或 IPC 抛错）自动回退到 mock，并在
StatusBar 显示琥珀色 `离线示例数据` 徽章——**绝不让假数据冒充真实数据**。

判定：`typeof window.__TAURI_INTERNALS__ === 'undefined'` 即视为无 Rust 环境。

mock 至少提供：8 个渠道（覆盖三种 apiFormat、1 个 hidden、1 个 incompatible、1 个 isCurrent）、
2 个 hub（一个 running）、400 行 usage（跨 7 天、含 6 种降级码）、30 行 errors（含 4xx/5xx/超时/
连接失败）、2 个账号池、10 条 doctor 结果（含 2 个 fail）。
**对话不提供 mock 数据**：chat 的会话与消息一律来自真实数据源（transcript 回放或 hub 发送），
离线时 `list_chat_sessions` 返回空数组、发送被拒绝，**绝不退回假会话**——
「假数据必须显式标明」这条在 chat 上的落实方式是根本不造。

另需：10 个插件项（五种 kind 全覆盖，含只读与可写两态）、
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
  /** 历史项目候选，只服务对话视图的项目选择器 */
  chatProjects: ChatProject[];
  /** 在途的流式缓冲。整会话同一时刻只允许一条流；null = 无在途流。
      requestId 为空串表示「本次尝试尚未收到第一个增量」——Rust 的 requestId 只出现在
      事件里，发送回执不带，所以首个增量「认领」这次尝试，此后 sessionId 或 requestId
      对不上一律丢弃（切换会话后作废的流不许写状态） */
  chatStream: { sessionId: string; requestId: string; text: string } | null;
  /** 本轮流是否已由事件通道交代过终态。纯粹用于「同一次失败不弹两条 toast、
      截断不重复报」，不参与渲染 */
  chatStreamTerminal: { sessionId: string; reason: 'stop' | 'truncated' | 'error' } | null;
  env: AppEnv | null;
  offline: boolean;                 // 使用 mock 数据
  loading: Record<string, boolean>; // 按 key 的加载态
  error: Record<string, string | null>;
  loadedKeys: Record<string, boolean>; // 该 key 是否至少完成过一次加载（成败都算）；
                                       // 空态只准在 loadedKeys[key]===true 且数据为空时出现
  // refresh 永不抛出；await 后读 error[key]===null 即成功，非 null 即失败原因原文
  refresh(key: 'channels'|'hubs'|'pools'|'usage'|'errors'|'doctor'|'env'|'chat'|'chatProjects'|'plugins'|'tasks'): Promise<void>;
  refreshAll(): Promise<void>;
  // 动作直通 IPC，成功后自动 refresh 相关 key
  setHidden(id: string, hidden: boolean): Promise<void>;
  setAlias(id: string, alias: string | null): Promise<void>;
  setOverride(id: string, model: string | null, effort: Effort | null): Promise<void>;
  setSlot(hub: string, slot: SlotName, channel: string | null, model: string | null): Promise<void>;
  setSlotEffort(hub: string, slot: SlotName, effort: Effort | null): Promise<void>;
  launch(target: LaunchTarget): Promise<LaunchResult>;
  // 流式发送：返回值是**落盘后的最终副本**，只用于兜底与失败判定，不驱动渲染——
  // 渲染由 chat-stream* 事件驱动（§3.2）。截断时命令返回 Err，但该次终态已由
  // chat-stream-end 交代过，前端靠 chatStreamTerminal 判重，不重复播报。
  // 历史会话（source==='history'）调用会被拒绝。
  sendChatMessage(sessionId: string, content: string): Promise<ChatMessage>;
  // 对话的四个动作：选择历史项目 / 新建本地会话 / 删除本地会话 / 流式事件三件套
  selectChatProject(key: string): Promise<void>;                              // 成功后 refresh('chatProjects') + refresh('chat')
  createChatSession(hubName: string | null, channelId: string): Promise<ChatSession>; // 成功后 refresh('chat')
  deleteChatSession(id: string): Promise<void>;                               // 成功后 refresh('chat')
  appendChatDelta(chunk: ChatStreamChunk): void;                              // 事件驱动，不经 IPC
  endChatStream(end: ChatStreamEnd): void;
  failChatStream(error: ChatStreamError): void;
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
| `channels` | 渠道 | 渠道 | 选择渠道与模型，开始会话 |
| `slots` | 槽位 | 模型槽位 | 四个槽位分别绑到哪个渠道的哪个模型 |
| `usage` | 用量 | 用量与成本 | token 花在哪儿、缓存命中多少 |
| `diagnostics` | 诊断 | 诊断 | 失败了什么、悄悄降级了什么 |
| `accounts` | 账号池 | 账号池 | 同一渠道的多个账号怎么轮换 |
| `doctor` | 体检 | 本机体检 | 本机配置有没有问题，只读不联网 |
| `plugins` | 插件 | 插件 | hooks、输出风格、状态栏、权限这些扩展点各自是什么状态 |
| `tasks` | 定时任务 | 定时任务 | 应用运行期间自动触发，退出或休眠后不补跑 |
| `pullRequests` | Pull Request | Pull Request | 查看与你相关的代码审查 |
| `settings` | 设置 | 设置 | 外观、路径与本机环境 |


## macOS 0.2 用量契约

- Provider 数据库默认 `~/.agent-hub/providers.db`。CC Switch provider 仅在管理 TUI/CLI 显式导入或用户显式配置只读覆盖时读取。桌面端对该库只读；凭据仍不进入 IPC。
- 图表范围：最近 24 小时、含今天的 7/30 个本地自然日、自定义起止时刻；小时或日分桶。自定义窗口在自动刷新时保持不变。
- `UsageRow.harness` 为 `claude` / `codex` / `unknown`。Hub 从明确的 Claude CLI User-Agent 记录归属；缺少 harness 的旧 Claude Code 网关流水按其已确认来源归为 claude，`harnessEvidence=legacy-claude-hub`，显式 unknown 不覆盖。Codex 来自本地会话 token_count。`providerId` 优先显式 ID，再读旧流水 account 的 id: 稳定引用；无可靠映射时为 unknown。
- `series` 每个桶增加 `cw`、`harnesses`、`providers` 与 `components_cost`。后者顺序固定为普通输入、输出、缓存读、缓存写，单位 USD；任意未知字段或缺价使该桶完整成本为 null。维度切换不改变计量单位。
- 普通输入 `in` 不含缓存读写；总 Token 为 `in + out + cr + cw`。Hub 已完成上游协议归一化，UI 不再次扣除缓存。Codex 通过累计计数差分去掉重复快照，用 `total_tokens` 验证输入是否包含缓存子集；无法证明时保持未知。reasoning_output 不再叠加到 output。
- 缓存读取占输入比例为 `sum(cr) / (sum(in) + sum(cr) + sum(cw))`，不平均每请求比例。缺失字段通过 `incompleteTurns` 报告；缓存率仅对 in/cr/cw 完整的记录做加权计算，`cacheKnownTurns` 提供覆盖记录数。四类 Token 构成百分比以已记录总量为分母。
- `turns` 是用量记录数（Hub 已记账请求 + Codex 累计量更新事件），不是合并后的 HTTP 请求总数。明细表合并两种来源，跟随时间范围、每页 20 行，最多返回最近 5,000 条；点击行查看完整名称和来源。
- 定价是配置单价估算，不是账单结算。缺价格或计量字段时显示未知；费用图中的已知部分不代表完整费用。
- Codex 只读取 `sessions/**/*.jsonl` 的元数据、模型和 token_count，不返回对话正文；只消费一种用量事件，避免 token_usage_record 重复记账。缓存只保存归一化统计，不保存正文。
- 0.2 本轮桌面交付为 macOS，Windows 独立工程未同步此版本。

## S25 provider management commands

macOS 已实现下列命令；Windows 接入同一合同后独立验证。无 Tauri 的离线示例模式拒绝所有管理操作。

| IPC | 请求 | 响应 |
|---|---|---|
| `preview_import` | `source: {kind, path}`；Codex 用 `{kind, config, auth, profile}` | `planId, source, candidates, blocked` |
| `select_import` | `planId, selected: candidateId[], replace` | `added, updated, skipped, selected, replace` |
| `apply_import` | 与已确认 selection 完全一致 | `added, updated, skipped, pendingCleanup` |
| `cancel_import` | `planId` | void，取消不写库 |
| `provider_edit_view` | `appType, id` | 安全 `provider` 投影、`revision, model` |
| `save_provider` | `input: {appType,id,name,expectedRevision,endpoint?,model?,protocol?,secret?,clearSecret}` | 与 apply 相同 |
| `remove_provider` | `appType, id` | `removed, blockers, pendingCleanup` |
| `credential_status` | 无 | `legacy, referenced, pendingCleanup` |
| `migrate_credentials` | 无，必须来自明确确认 | `applied, storageCleanupPending` |

候选只有 `candidateId,id,appType,name,endpoint,protocol,credential,conflict,blockedReason`，endpoint 仅保留 scheme/authority。原始 settings 与凭证留在后端短期计划中；手填 secret 只出现在一次写请求，禁止进共享状态、响应、事件和日志。omitted secret 保留、clearSecret 显式清除，不能同时替换与清除；编辑复核 revision。错误留在弹窗，不重复 error toast，提交期间关闭与重复提交被阻止；成功刷新 channels/hubs/pools，取消和卸载清理计划与输入。

`LaunchTarget.appType` 可为 claude/codex，缺失时兼容旧任务默认 claude；channel 目标按复合身份查找并分派 claude1/codex1。hub/slot 仅 Claude。`set_channel_hidden/alias/override` 请求显式携带 appType，并在后端拒绝非 Claude。

### 桌面语言偏好（2026-09-16）

设置、主导航和渠道管理支持简体中文 / English，即时切换并保存到本机 localStorage 的 `agent-hub.desktop.language`。默认中文，非法值回退中文；存储不可用时本次会话仍可切换。用户命名、模型、诊断目录与后端错误保留原文；其余既有视图不宣称完整双语。设置按常规、外观、路径、环境、关于分组，搜索只过滤现有设置。macOS / Windows 保留各自窗口行为与快捷键。

### PR 与应用内调度（2026-09-16）

- 新 `pullRequests` 路由、`pull-request` 图标，与 `tasks` 位于主导航顶部“工作”组。原 Cmd/Ctrl+1…9/0 保持，PR 不占数字快捷键。
- `list_pull_requests(filter, repository)` 使用既有 `gh` 登录，仅搜索 github.com 的开放 PR：`all`=involves @me、`review`=review-requested @me、`authored`=author @me。仓库可空或 owner/repository；更新时间倒序最多 100 条，本地搜索标题/仓库/作者。20 秒超时，错误脱敏后展示；离线预览明确不可读取，绝不伪造 PR。
- `open_pull_request(url)` 只允许 HTTPS github.com/{owner}/{repo}/pull/{number}。无创建、评论、合并或凭证复制能力。
- Tauri 应用运行时每 2 秒扫描任务；cron 用本地时区。启动时以当前时间为边界，超过 60 秒的轮询间隙及时间回拨不补跑。退出应用没有后台服务。暂停在认领前生效，认领后的终端派发不能撤回。
- CRUD 与调度共用 fs2 文件锁；先原子持久化 `lastClaimAt`、`lastRunAt`、`lastRunStatus=unconfirmed`，再释放锁调用执行器。每个任务每个 cron occurrence 最多尝试一次，中断可能漏一次，绝不承诺 exactly-once。完成后重新读文件合并结果，不覆盖并发暂停/改名/删除。
- `lastRunAt` 是派发尝试时间；新增可选 `lastRunStatus`（unconfirmed/dispatched/reminded/failed）、`lastRunMessage`。会话派发成功不等于模型执行完成；体检提醒写入最近结果并在应用内提示，不自动执行 doctor --fix，也没有系统通知保证。未来 cron 仍继续。
- UI 搜索、全部/已开启/已暂停/最近成功筛选；失败和未确认结果在全部页可见，最近成功仅包含 dispatched/reminded。事件丢失时每 15 秒刷新任务结果。语言可切换，后端错误保留原文。
