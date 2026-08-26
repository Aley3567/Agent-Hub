/**
 * 数据契约的 TypeScript 落地。
 *
 * 内容逐字取自 UI/CONTRACT.md 第 2 节；Rust 侧的 serde 用
 * `rename_all = "camelCase"` 与本文件严格对齐。
 * 两个平台工程各存一份，内容必须完全相同。
 */

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
  /** 解析到的 Channel.id，解析失败为 null（界面要显示"未解析"） */
  resolvedChannelId: string | null;
  apiFormat: ApiFormat | null;
  models: string[];
  proxy: string | null;
}

export interface RouteTarget {
  channel: string;
  model: string;
}

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
  ts: number; // unix 秒
  channel: string;
  model: string;
  format: string; // journal 里字段名就是 format
  source: 'upstream' | 'estimated' | string;
  in: number | null; // input_tokens
  out: number | null; // output_tokens
  cr: number | null; // cache_read_input_tokens
  cw: number | null; // cache_creation_input_tokens
  hub: string | null; // instance id
  account: string | null;
  deg: string[]; // HUB_DEGRADE_* 列表
  cacheCreation: Record<string, number> | null;
  serverToolUse: Record<string, number> | null;
}

export interface ErrorRow {
  ts: number;
  phase: string; // 'request' | 'response' | 'stream' | 'connect' | ...
  channel: string | null;
  model: string | null;
  format: string | null;
  status: number | null; // HTTP 状态
  code: string | null; // 上游错误 code
  message: string | null; // 已脱敏
  exc: string | null; // 异常类型名（journal 字段名是 exc）
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
  /** 按桶的时间序列，桶宽由 granularity 决定 */
  series: { t: number; in: number; out: number; cr: number; turns: number; cost: number | null }[];
  granularity: 'hour' | 'day';
  /** 降级码计数，降序 */
  degradeCounts: { code: string; count: number }[];
  /** 定价缺失时为 null，绝不猜 */
  estimatedCostUsd: number | null;
  /** 成本数据来源：`pricing-file` 优先，回退 `cc-switch-db`，都没有为 null */
  costSource: 'pricing-file' | 'cc-switch-db' | null;
}

export interface UsageBucket {
  key: string;
  in: number;
  out: number;
  cr: number;
  cw: number;
  turns: number;
  cacheHitRate: number | null;
  degradedTurns: number;
}

export interface AccountPool {
  providerRef: string;
  resolvedChannelId: string | null;
  strategy: string; // 'weighted' | 'priority' | ...
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
  title: string; // 中文人话标题
  what: string; // 发生了什么
  impact: string; // 对你的影响
  action: string; // 建议动作
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

/**
 * 以下类型不在 CONTRACT.md 第 2 节的代码块里，但第 3 节的 `app_env` 返回值与
 * 第 6.2 节的 Store 契约都引用它们，所以在这里补齐，字段与命令返回值逐一对应。
 */

/** 用量聚合的时间粒度。等价于 `UsageSummary['granularity']`。 */
export type Granularity = UsageSummary['granularity'];

/** `app_env` 的返回值。取不到的项为 false 或 null，界面显示「未检测到」。 */
export interface AppEnv {
  /** Rust 的 `std::env::consts::OS`，macOS 上是 'macos' */
  platform: string;
  appVersion: string;
  tauriVersion: string;
  /** 绝对路径，可直接交给 openPath / revealInFolder */
  dbPath: string;
  configPath: string;
  logsDir: string;
  /** 是否检测到 Claude Code 可执行文件 */
  hasClaudeBin: boolean;
  /** `python3 --version` 的原文，检测不到为 null */
  pythonVersion: string | null;
}
