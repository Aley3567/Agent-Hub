/**
 * 离线示例数据。
 *
 * 只在**没有 Rust 环境**时使用（浏览器里跑 `npm run dev:renderer`），判定见 `./index.ts`。
 * 用它的时候 StatusBar 必须亮琥珀色「离线示例数据」徽章——绝不让假数据冒充真实数据
 * （CONTRACT.md 第 4 节）。
 *
 * 两条自我约束：
 *   1. 数据是**确定性**的：随机数走固定种子的 LCG，刷新页面看到的还是同一批数字，
 *      不然调布局时数字乱跳，分不清是代码变了还是数据变了。
 *   2. 示例里**没有任何形似凭证的串**。凭证边界不因为"这只是 mock"就松一格：
 *      credential 字段只有 'configured' / 'missing' 两种值，notes 里不塞长串。
 *
 * 覆盖面按 CONTRACT.md 第 4 节的下限：8 个渠道（三种 apiFormat、1 个 hidden、
 * 1 个 incompatible、1 个 isCurrent）、2 个 hub（一个 running）、400 行 usage
 * （跨 7 天、含 6 种降级码）、30 行 errors（4xx / 5xx / 超时 / 连接失败）、
 * 2 个账号池、10 条 doctor 结果（含 2 个 fail）。
 */
import type {
  AccountPool,
  AppEnv,
  Channel,
  DoctorCheck,
  ErrorRow,
  Granularity,
  HubConfig,
  UsageBucket,
  UsageRow,
  UsageSummary,
} from '../types/contract';

const HOUR = 3600;
const DAY = 86400;

/**
 * 示例数据的时间锚点：今天本地零点。
 * 模块加载时算一次，之后所有行都相对它，保证同一次会话里时间轴不动。
 */
const TODAY_START = (() => {
  const now = new Date();
  return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);
})();

/**
 * 模块加载那一刻的 unix 秒。
 * journal 里不可能有未来的行，所以示例数据的时间戳一律不超过它——否则默认时间窗
 * （今天零点往前 6 天到现在）会把那些行整段滤掉，看起来像少了数据。
 */
const NOW = Math.floor(Date.now() / 1000);

/** 固定种子的线性同余发生器。要的是可复现，不是统计质量。 */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** [min, max] 闭区间取整数 */
function pickInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

function pickOne<T>(random: () => number, items: readonly T[]): T {
  // items 非空由调用点保证：本文件里的候选表都是字面量常量
  return items[Math.floor(random() * items.length)] as T;
}

// ---------------------------------------------------------------------------
// 渠道
// ---------------------------------------------------------------------------

export const MOCK_CHANNELS: Channel[] = [
  {
    id: 'ch-anthropic-official',
    name: 'Anthropic 官方',
    alias: 'ant',
    apiFormat: 'anthropic',
    endpoint: 'https://api.anthropic.com',
    credential: 'configured',
    isCurrent: true,
    inFailoverQueue: false,
    hidden: false,
    modelOverride: null,
    effortOverride: null,
    declaredModel: 'claude-opus-4-1-20250805',
    slotModels: {
      fable: 'claude-fable-1-20260710',
      opus: 'claude-opus-4-1-20250805',
      sonnet: 'claude-sonnet-4-5-20250929',
      haiku: 'claude-haiku-4-5-20251001',
    },
    contextWindow: 200000,
    compatibility: 'compatible',
    compatibilityReason: null,
    pinsSubagentModel: false,
    category: '官方',
    notes: '主力渠道，四个槽位都声明了默认模型。',
    iconColor: '#2f6f8f',
    lastUsedAt: NOW - 40 * 60,
    sortIndex: 0,
  },
  {
    id: 'ch-relay-cn',
    name: '国内中转',
    alias: 'relay',
    apiFormat: 'anthropic',
    endpoint: 'https://relay.example.net/anthropic',
    credential: 'configured',
    isCurrent: false,
    inFailoverQueue: true,
    hidden: false,
    modelOverride: 'claude-sonnet-4-5-20250929',
    effortOverride: 'medium',
    declaredModel: 'claude-sonnet-4-5-20250929',
    slotModels: { sonnet: 'claude-sonnet-4-5-20250929', haiku: 'claude-haiku-4-5-20251001' },
    contextWindow: 200000,
    compatibility: 'compatible',
    compatibilityReason: null,
    pinsSubagentModel: true,
    category: '中转',
    notes: 'settings_config 里固定了子代理模型，体检会建议清理。',
    iconColor: '#8a5cf0',
    lastUsedAt: TODAY_START - 2 * HOUR,
    sortIndex: 1,
  },
  {
    id: 'ch-grok-chat',
    name: 'Grok',
    alias: 'grok',
    apiFormat: 'openai_chat',
    endpoint: 'https://api.x.ai/v1',
    credential: 'configured',
    isCurrent: false,
    inFailoverQueue: true,
    hidden: false,
    modelOverride: null,
    effortOverride: 'high',
    declaredModel: 'grok-4.5',
    slotModels: { opus: 'grok-4.5', sonnet: 'grok-4.5-fast' },
    contextWindow: 256000,
    compatibility: 'compatible',
    compatibilityReason: null,
    pinsSubagentModel: false,
    category: '第三方',
    notes: null,
    iconColor: '#c07a1e',
    lastUsedAt: TODAY_START - DAY - 3 * HOUR,
    sortIndex: 2,
  },
  {
    id: 'ch-gpt-responses',
    name: 'OpenAI Responses',
    alias: null,
    apiFormat: 'openai_responses',
    endpoint: 'https://api.openai.com/v1',
    credential: 'configured',
    isCurrent: false,
    inFailoverQueue: false,
    hidden: false,
    modelOverride: null,
    effortOverride: 'xhigh',
    declaredModel: 'gpt-5.4',
    slotModels: { opus: 'gpt-5.4', sonnet: 'gpt-5.4-mini' },
    contextWindow: 400000,
    compatibility: 'compatible',
    compatibilityReason: null,
    pinsSubagentModel: false,
    category: '第三方',
    notes: 'reasoning 走 effort 档位，thinking 预算会被换算。',
    iconColor: '#2f8f5b',
    lastUsedAt: TODAY_START - 2 * DAY,
    sortIndex: 3,
  },
  {
    id: 'ch-local-llama',
    name: '本地 Llama',
    alias: 'local',
    apiFormat: 'openai_chat',
    endpoint: 'http://127.0.0.1:11434/v1',
    credential: 'missing',
    isCurrent: false,
    inFailoverQueue: false,
    hidden: false,
    modelOverride: null,
    effortOverride: null,
    declaredModel: 'llama-4-70b',
    slotModels: {},
    contextWindow: 131072,
    compatibility: 'incompatible',
    compatibilityReason:
      '不支持 tool_use 的并行调用与 cache_control，Claude Code 的子代理与编辑工具链会直接失败。',
    pinsSubagentModel: false,
    category: '本地',
    notes: '装着玩的本地模型，没配凭证。',
    iconColor: '#7b7b83',
    lastUsedAt: null,
    sortIndex: 4,
  },
  {
    id: 'ch-bedrock',
    name: 'Bedrock',
    alias: null,
    apiFormat: 'anthropic',
    endpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    credential: 'configured',
    isCurrent: false,
    inFailoverQueue: false,
    hidden: false,
    modelOverride: null,
    effortOverride: null,
    declaredModel: 'us.anthropic.claude-opus-4-1-20250805-v1:0',
    slotModels: { opus: 'us.anthropic.claude-opus-4-1-20250805-v1:0' },
    contextWindow: 200000,
    compatibility: 'unassessed',
    compatibilityReason: null,
    pinsSubagentModel: false,
    category: '云厂商',
    notes: null,
    iconColor: null,
    lastUsedAt: TODAY_START - 4 * DAY,
    sortIndex: 5,
  },
  {
    id: 'ch-qwen-chat',
    name: 'Qwen',
    alias: null,
    apiFormat: 'openai_chat',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    credential: 'configured',
    isCurrent: false,
    inFailoverQueue: false,
    hidden: false,
    modelOverride: null,
    effortOverride: 'low',
    declaredModel: 'qwen3-max',
    slotModels: { haiku: 'qwen3-flash' },
    contextWindow: 262144,
    compatibility: 'unassessed',
    compatibilityReason: null,
    pinsSubagentModel: false,
    category: '第三方',
    notes: null,
    iconColor: null,
    lastUsedAt: TODAY_START - 5 * DAY,
    sortIndex: 6,
  },
  {
    id: 'ch-retired-relay',
    name: '停用的旧中转',
    alias: null,
    apiFormat: 'unknown',
    endpoint: 'https://old-relay.example.net',
    credential: 'missing',
    isCurrent: false,
    inFailoverQueue: false,
    hidden: true,
    modelOverride: null,
    effortOverride: null,
    declaredModel: null,
    slotModels: {},
    contextWindow: null,
    compatibility: 'unassessed',
    compatibilityReason: null,
    pinsSubagentModel: false,
    category: null,
    notes: '已停用，隐藏起来不出现在启动器里。',
    iconColor: null,
    lastUsedAt: TODAY_START - 30 * DAY,
    sortIndex: 7,
  },
];

// ---------------------------------------------------------------------------
// hub
// ---------------------------------------------------------------------------

export const MOCK_HUBS: HubConfig[] = [
  {
    name: 'claude-hub',
    isDefault: true,
    version: 3,
    port: 15721,
    localTokenEnv: 'CLAUDE_HUB_LOCAL_TOKEN',
    defaultChannel: 'ant',
    launchSlot: 'opus',
    slots: {
      fable: { channel: 'ant', model: 'claude-fable-1-20260710' },
      opus: { channel: 'ant', model: 'claude-opus-4-1-20250805' },
      sonnet: { channel: 'grok', model: 'grok-4.5' },
      haiku: { channel: 'qwen', model: 'qwen3-flash' },
    },
    effortBySlot: { opus: 'high', sonnet: 'medium', haiku: 'low' },
    channels: [
      {
        name: 'ant',
        provider: 'id:ch-anthropic-official',
        resolvedChannelId: 'ch-anthropic-official',
        apiFormat: 'anthropic',
        models: [
          'claude-fable-1-20260710',
          'claude-opus-4-1-20250805',
          'claude-sonnet-4-5-20250929',
          'claude-haiku-4-5-20251001',
        ],
        proxy: null,
      },
      {
        name: 'grok',
        provider: 'Grok',
        resolvedChannelId: 'ch-grok-chat',
        apiFormat: 'openai_chat',
        models: ['grok-4.5', 'grok-4.5-fast'],
        proxy: 'http://127.0.0.1:7890',
      },
      {
        name: 'qwen',
        provider: 'Qwen',
        resolvedChannelId: 'ch-qwen-chat',
        apiFormat: 'openai_chat',
        models: ['qwen3-max', 'qwen3-flash'],
        proxy: null,
      },
      {
        name: 'ghost',
        provider: 'id:ch-deleted-in-cc-switch',
        resolvedChannelId: null,
        apiFormat: null,
        models: ['some-model'],
        proxy: null,
      },
    ],
    routes: {
      'claude-3-5-haiku-20241022': [{ channel: 'qwen', model: 'qwen3-flash' }],
      'claude-opus-4-1-20250805': [
        { channel: 'ant', model: 'claude-opus-4-1-20250805' },
        { channel: 'grok', model: 'grok-4.5' },
      ],
    },
    running: true,
    configPath: '~\\.cc-switch\\claude-hub.json',
  },
  {
    name: 'review',
    isDefault: false,
    version: 3,
    port: 15731,
    localTokenEnv: null,
    defaultChannel: 'gpt',
    launchSlot: 'sonnet',
    slots: {
      opus: { channel: 'gpt', model: 'gpt-5.4' },
      sonnet: { channel: 'gpt', model: 'gpt-5.4-mini' },
      haiku: null,
    },
    effortBySlot: { opus: 'xhigh' },
    channels: [
      {
        name: 'gpt',
        provider: 'id:ch-gpt-responses',
        resolvedChannelId: 'ch-gpt-responses',
        apiFormat: 'openai_responses',
        models: ['gpt-5.4', 'gpt-5.4-mini'],
        proxy: null,
      },
    ],
    routes: {},
    running: false,
    configPath: '~\\.cc-switch\\hubs\\review.json',
  },
];

// ---------------------------------------------------------------------------
// 用量 journal
// ---------------------------------------------------------------------------

/** 示例里出现的六种降级码，全部取自 degradeCatalog 的真实条目 */
const MOCK_DEGRADE_CODES = [
  'HUB_DEGRADE_CACHE_CONTROL_DROPPED',
  'HUB_DEGRADE_THINKING_TO_EFFORT',
  'HUB_DEGRADE_SYNTHETIC_TOOL_ID',
  'HUB_DEGRADE_TOP_K_DROPPED',
  'HUB_DEGRADE_LATE_INPUT_USAGE',
  'HUB_DEGRADE_UNSIGNED_THINKING',
] as const;

const MOCK_TRAFFIC: readonly { channel: string; model: string; format: string; account: string | null }[] = [
  { channel: 'ant', model: 'claude-opus-4-1-20250805', format: 'anthropic', account: 'ant-main' },
  { channel: 'ant', model: 'claude-sonnet-4-5-20250929', format: 'anthropic', account: 'ant-backup' },
  { channel: 'ant', model: 'claude-fable-1-20260710', format: 'anthropic', account: 'ant-main' },
  { channel: 'grok', model: 'grok-4.5', format: 'openai_chat', account: 'grok-a' },
  { channel: 'grok', model: 'grok-4.5-fast', format: 'openai_chat', account: 'grok-b' },
  { channel: 'qwen', model: 'qwen3-flash', format: 'openai_chat', account: null },
  { channel: 'gpt', model: 'gpt-5.4', format: 'openai_responses', account: null },
];

/** 400 行 usage，跨 7 天（含今天） */
export const MOCK_USAGE: UsageRow[] = (() => {
  const random = makeRandom(20260819);
  const rows: UsageRow[] = [];
  const windowStart = TODAY_START - 6 * DAY;
  // 铺到「现在」为止，不铺到 7×24 小时整——那会把最后一批行推到明天
  const span = NOW - windowStart;

  for (let i = 0; i < 400; i += 1) {
    const traffic = pickOne(random, MOCK_TRAFFIC);
    // 时间在窗口内均匀铺开，再加一点抖动，让按小时聚合时不是等距刺
    const ts = Math.min(NOW, windowStart + Math.floor((i / 400) * span) + pickInt(random, 0, 900));
    const inTokens = pickInt(random, 800, 42000);
    const cacheRead = random() < 0.72 ? pickInt(random, 0, inTokens * 3) : 0;
    const cacheWrite = random() < 0.35 ? pickInt(random, 500, 9000) : 0;
    const degraded = random() < 0.22;
    const deg = degraded
      ? Array.from(new Set([pickOne(random, MOCK_DEGRADE_CODES), pickOne(random, MOCK_DEGRADE_CODES)]))
      : [];

    rows.push({
      ts,
      channel: traffic.channel,
      model: traffic.model,
      format: traffic.format,
      source: random() < 0.88 ? 'upstream' : 'estimated',
      in: inTokens,
      out: pickInt(random, 40, 6400),
      cr: cacheRead,
      cw: cacheWrite,
      hub: random() < 0.85 ? 'claude-hub' : 'review',
      account: traffic.account,
      deg,
      cacheCreation: cacheWrite > 0 ? { ephemeral_5m_input_tokens: cacheWrite } : null,
      serverToolUse: random() < 0.12 ? { web_search_requests: pickInt(random, 1, 4) } : null,
    });
  }
  return rows.sort((a, b) => a.ts - b.ts);
})();

/** 30 行 errors：4xx / 5xx / 超时 / 连接失败各有覆盖 */
export const MOCK_ERRORS: ErrorRow[] = (() => {
  type Shape = Pick<ErrorRow, 'phase' | 'status' | 'code' | 'message' | 'exc'>;
  const shapes: readonly Shape[] = [
    {
      phase: 'response',
      status: 429,
      code: 'rate_limit_error',
      message: '上游返回 429：本分钟的请求数超过配额，60 秒后重试',
      exc: null,
    },
    {
      phase: 'response',
      status: 401,
      code: 'authentication_error',
      message: '上游返回 401：凭证被拒，检查这个渠道在 CC Switch 里的配置',
      exc: null,
    },
    {
      phase: 'response',
      status: 400,
      code: 'invalid_request_error',
      message: '上游返回 400：max_tokens 超过该模型上限',
      exc: null,
    },
    {
      phase: 'response',
      status: 404,
      code: 'not_found_error',
      message: '上游返回 404：这个渠道上没有该模型',
      exc: null,
    },
    {
      phase: 'response',
      status: 405,
      code: null,
      message: '上游网关返回 405，响应体是一段 HTML 而不是 JSON，原文已记进 errors journal',
      exc: null,
    },
    {
      phase: 'response',
      status: 500,
      code: 'api_error',
      message: '上游返回 500：上游内部错误，未给出更多细节',
      exc: null,
    },
    {
      phase: 'response',
      status: 502,
      code: null,
      message: '上游网关返回 502，中转层没有拿到后端响应',
      exc: null,
    },
    {
      phase: 'response',
      status: 529,
      code: 'overloaded_error',
      message: '上游返回 529：服务过载，建议切到备用渠道',
      exc: null,
    },
    {
      phase: 'stream',
      status: null,
      code: null,
      message: '流在 message_delta 之后断开，没有收到终态事件；不补 message_stop，本轮按失败记',
      exc: 'IncompleteRead',
    },
    {
      phase: 'connect',
      status: null,
      code: null,
      message: '连接上游超时：15 秒内没有完成 TLS 握手',
      exc: 'TimeoutError',
    },
    {
      phase: 'connect',
      status: null,
      code: null,
      message: '连接被拒：本地代理 127.0.0.1:7890 没有在监听',
      exc: 'ConnectionRefusedError',
    },
    {
      phase: 'request',
      status: null,
      code: null,
      message: '请求体里的 tool_result 找不到对应的 tool_use，按因果校验拒绝转发',
      exc: 'ValueError',
    },
  ];

  const random = makeRandom(77281);
  const rows: ErrorRow[] = [];
  for (let i = 0; i < 30; i += 1) {
    const shape = shapes[i % shapes.length] as Shape;
    const traffic = pickOne(random, MOCK_TRAFFIC);
    rows.push({
      ts: TODAY_START - Math.floor((i / 30) * 6 * DAY) - pickInt(random, 0, 4 * HOUR),
      phase: shape.phase,
      channel: traffic.channel,
      model: traffic.model,
      format: traffic.format,
      status: shape.status,
      code: shape.code,
      message: shape.message,
      exc: shape.exc,
      route: random() < 0.4 ? `${traffic.channel},${traffic.model}` : null,
      deg: random() < 0.3 ? [pickOne(random, MOCK_DEGRADE_CODES)] : [],
    });
  }
  return rows.sort((a, b) => b.ts - a.ts);
})();

/** 缓存命中率 = cr / (in + cr)，无输入时为 null（CONTRACT.md 第 2 节） */
function hitRate(inTokens: number, cacheRead: number): number | null {
  const base = inTokens + cacheRead;
  return base === 0 ? null : cacheRead / base;
}

/** 按 key 聚合成桶，降序返回 */
function bucketBy(rows: readonly UsageRow[], key: (row: UsageRow) => string): UsageBucket[] {
  const acc = new Map<string, UsageBucket>();
  for (const row of rows) {
    const k = key(row);
    const bucket = acc.get(k) ?? {
      key: k,
      in: 0,
      out: 0,
      cr: 0,
      cw: 0,
      turns: 0,
      cacheHitRate: null,
      degradedTurns: 0,
    };
    bucket.in += row.in ?? 0;
    bucket.out += row.out ?? 0;
    bucket.cr += row.cr ?? 0;
    bucket.cw += row.cw ?? 0;
    bucket.turns += 1;
    if (row.deg.length > 0) bucket.degradedTurns += 1;
    acc.set(k, bucket);
  }
  const out = [...acc.values()];
  for (const bucket of out) bucket.cacheHitRate = hitRate(bucket.in, bucket.cr);
  return out.sort((a, b) => b.in + b.out - (a.in + a.out));
}

/** 离线示例的定价表，单位美元 / 百万 token。所有示例模型都有价，保证 cost 线可预览。 */
const MOCK_PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-opus-4-1-20250805': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4-5-20250929': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-fable-1-20260710': { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite: 1.875 },
  'grok-4.5': { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
  'grok-4.5-fast': { input: 3, output: 10, cacheRead: 0, cacheWrite: 0 },
  'qwen3-flash': { input: 0.5, output: 1, cacheRead: 0, cacheWrite: 0 },
  'gpt-5.4': { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
};

function rowCostUsd(row: UsageRow): number | null {
  const price = MOCK_PRICES[row.model];
  if (!price) return null;
  return (
    ((row.in ?? 0) * price.input +
      (row.out ?? 0) * price.output +
      (row.cr ?? 0) * price.cacheRead +
      (row.cw ?? 0) * price.cacheWrite) /
    1_000_000
  );
}

/**
 * 用示例行现算聚合，和 Rust 侧同一套口径。
 * 现算而不是写死，是为了让「改时间窗 → 数字跟着变」在离线模式下也成立。
 */
export function mockUsageSummary(fromTs: number, toTs: number, granularity: Granularity): UsageSummary {
  const rows = MOCK_USAGE.filter((row) => row.ts >= fromTs && row.ts <= toTs);
  const step = granularity === 'hour' ? HOUR : DAY;

  const totals = { in: 0, out: 0, cr: 0, cw: 0, turns: 0 };
  const seriesAcc = new Map<number, { t: number; in: number; out: number; cr: number; turns: number; cost: number | null }>();
  const degradeAcc = new Map<string, number>();
  let totalCost: number | null = 0;

  for (const row of rows) {
    totals.in += row.in ?? 0;
    totals.out += row.out ?? 0;
    totals.cr += row.cr ?? 0;
    totals.cw += row.cw ?? 0;
    totals.turns += 1;

    const rowCost = rowCostUsd(row);
    if (rowCost === null) {
      totalCost = null;
    } else if (totalCost !== null) {
      totalCost += rowCost;
    }

    // 按天聚合时对齐本地零点，不是 UTC 零点——用户看的是自己的日历
    const t = granularity === 'day' ? TODAY_START - Math.ceil((TODAY_START - row.ts) / DAY) * DAY : Math.floor(row.ts / step) * step;
    const point = seriesAcc.get(t) ?? { t, in: 0, out: 0, cr: 0, turns: 0, cost: 0 };
    point.in += row.in ?? 0;
    point.out += row.out ?? 0;
    point.cr += row.cr ?? 0;
    point.turns += 1;
    if (rowCost === null) {
      point.cost = null;
    } else if (point.cost !== null) {
      point.cost += rowCost;
    }
    seriesAcc.set(t, point);

    for (const code of row.deg) degradeAcc.set(code, (degradeAcc.get(code) ?? 0) + 1);
  }

  return {
    windowFrom: fromTs,
    windowTo: toTs,
    totals,
    cacheHitRate: hitRate(totals.in, totals.cr),
    byChannel: bucketBy(rows, (row) => row.channel),
    byModel: bucketBy(rows, (row) => row.model),
    series: [...seriesAcc.values()].sort((a, b) => a.t - b.t),
    granularity,
    degradeCounts: [...degradeAcc.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    estimatedCostUsd: totalCost,
    costSource: 'cc-switch-db',
  };
}

// ---------------------------------------------------------------------------
// 账号池
// ---------------------------------------------------------------------------

export const MOCK_POOLS: AccountPool[] = [
  {
    providerRef: 'id:ch-anthropic-official',
    resolvedChannelId: 'ch-anthropic-official',
    strategy: 'weighted',
    cooldownSeconds: 60,
    maxCooldownSeconds: 900,
    members: [
      {
        providerRef: 'id:ch-anthropic-official#main',
        resolvedChannelId: 'ch-anthropic-official',
        displayName: 'ant-main',
        weight: 3,
        priority: 0,
        enabled: true,
        lastUsedAt: NOW - 40 * 60,
        turns: 128,
      },
      {
        providerRef: 'id:ch-anthropic-official#backup',
        resolvedChannelId: 'ch-anthropic-official',
        displayName: 'ant-backup',
        weight: 1,
        priority: 0,
        enabled: true,
        lastUsedAt: NOW - 5 * HOUR,
        turns: 41,
      },
      {
        providerRef: 'id:ch-anthropic-official#cold',
        resolvedChannelId: 'ch-anthropic-official',
        displayName: 'ant-cold',
        weight: 1,
        priority: 1,
        enabled: false,
        lastUsedAt: null,
        turns: 0,
      },
    ],
  },
  {
    providerRef: 'Grok',
    resolvedChannelId: 'ch-grok-chat',
    strategy: 'priority',
    cooldownSeconds: 30,
    maxCooldownSeconds: null,
    members: [
      {
        providerRef: 'Grok#a',
        resolvedChannelId: 'ch-grok-chat',
        displayName: 'grok-a',
        weight: 1,
        priority: 0,
        enabled: true,
        lastUsedAt: TODAY_START - DAY,
        turns: 63,
      },
      {
        providerRef: 'Grok#b',
        resolvedChannelId: null,
        displayName: 'grok-b',
        weight: 1,
        priority: 1,
        enabled: true,
        lastUsedAt: TODAY_START - 3 * DAY,
        turns: 12,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// 体检
// ---------------------------------------------------------------------------

export const MOCK_DOCTOR: DoctorCheck[] = [
  {
    id: 'db-readable',
    level: 'ok',
    title: 'CC Switch 数据库可只读打开',
    detail: '~\\.cc-switch\\cc-switch.db 以 mode=ro 打开成功，providers 表里有 8 个 claude 渠道。',
    fixAction: null,
  },
  {
    id: 'config-writable',
    level: 'ok',
    title: 'Agent Hub 本地配置可写',
    detail: '~\\.cc-switch\\claude1-config.json 存在，可写。',
    fixAction: null,
  },
  {
    id: 'hub-config',
    level: 'ok',
    title: '默认 hub 配置完整',
    detail: '四个槽位都绑定了渠道与模型，端口 15721。',
    fixAction: null,
  },
  {
    id: 'claude-bin',
    level: 'ok',
    title: '找到 Claude Code 可执行文件',
    detail: '~\\AppData\\Roaming\\npm\\claude.cmd',
    fixAction: null,
  },
  {
    id: 'python-version',
    level: 'ok',
    title: 'python3 版本满足要求',
    detail: 'Python 3.13.2',
    fixAction: null,
  },
  {
    id: 'subagent-pinned',
    level: 'fail',
    title: '有渠道固定了子代理模型',
    detail:
      '「国内中转」的 settings_config 里有 CLAUDE_CODE_SUBAGENT_MODEL，子代理会绕过槽位设置一直用这个模型。',
    fixAction: 'doctor_fix_subagent_pins',
  },
  {
    id: 'incompatible-channel',
    level: 'fail',
    title: '有渠道不满足 Claude Code 语义要求',
    detail: '「本地 Llama」不支持并行 tool_use 与 cache_control，用它跑会话会在第一次编辑工具调用时失败。',
    fixAction: null,
  },
  {
    id: 'pricing-missing',
    level: 'info',
    title: '缺少定价表，成本不做估算',
    detail: 'model-pricing.json 里 models 为空数组，用量视图只显示 token，不显示金额。',
    fixAction: null,
  },
  {
    id: 'unresolved-hub-channel',
    level: 'info',
    title: 'hub 里有解析不到的渠道',
    detail: '默认 hub 的 channels 里「ghost」指向 id:ch-deleted-in-cc-switch，CC Switch 里已经没有这个 id。',
    fixAction: null,
  },
  {
    id: 'journal-rotation',
    level: 'info',
    title: '用量 journal 已经轮转过',
    detail: 'logs/ 下有 2 个 .bak-* 备份，聚合会把它们一起读进来。',
    fixAction: null,
  },
];

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------

export const MOCK_ENV: AppEnv = {
  platform: 'windows',
  appVersion: '0.1.0',
  tauriVersion: '2',
  dbPath: '~\\.cc-switch\\cc-switch.db',
  configPath: '~\\.cc-switch\\claude1-config.json',
  logsDir: '~\\.cc-switch\\logs',
  hasClaudeBin: true,
  pythonVersion: 'Python 3.13.2',
};
