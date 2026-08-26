/**
 * 渠道视图的派生模型与文案。
 *
 * 这里只放纯函数与常量：组件负责渲染，判断口径集中在本文件，免得同一句判断在
 * 主表、详情、编辑器里各写一遍然后慢慢走形。
 *
 * 三条口径值得先说清：
 *   1. 协议格式决定会不会降级——anthropic 原生直通，openai_* 要翻译，翻译就会丢字段。
 *      这是本项目的核心事实，所以它在界面上是一枚有颜色的徽章，不是一行小字。
 *   2. 语义兼容性只呈现真实结论。`unassessed` 且没有 reason 是「没人验过」的默认值，
 *      每行重复这句默认值会淹掉真正带信息的结论（仓库有一次提交专门修的就是这个），
 *      所以默认值在行内只留一个灰点，解释放在表尾汇总与详情里各说一次。
 *   3. 凭证只表达「已配置 / 未配置」。任何可能夹带凭证的自由文本（端点、备注）
 *      在渲染前再过一遍 redactSecrets，这是 fail-closed 的第二道闸。
 */
import type { BadgeTone, StatusTone } from '../../components';
import type { DegradeSeverity } from '../../data/degradeCatalog';
import { compareDegrade } from '../../data/degradeCatalog';
import { redactSecrets } from '../../lib';
import type {
  ApiFormat,
  Channel,
  Compatibility,
  Effort,
  LaunchResult,
  SlotName,
  UsageRow,
} from '../../types/contract';

// ---------------------------------------------------------------------------
// 视图动作：由 index.tsx 从 store 取来往下传，parts 不各自订阅 store
// ---------------------------------------------------------------------------

export interface ChannelActions {
  setHidden(id: string, hidden: boolean): Promise<void>;
  setAlias(id: string, alias: string | null): Promise<void>;
  setOverride(id: string, model: string | null, effort: Effort | null): Promise<void>;
  launch(id: string): Promise<LaunchResult>;
}

// ---------------------------------------------------------------------------
// 协议格式
// ---------------------------------------------------------------------------

/**
 * 协议格式徽章统一用中性灰底：它只回答「说什么协议」，不表达状态。
 * 语义色留给状态列与兼容性结论（DESIGN.md 第 1 节：颜色只用来表达语义）。
 */
export const API_FORMAT_TONE: Record<ApiFormat, BadgeTone> = {
  anthropic: 'neutral',
  openai_chat: 'neutral',
  openai_responses: 'neutral',
  unknown: 'neutral',
};

export const API_FORMAT_NOTE: Record<ApiFormat, string> = {
  anthropic: 'Anthropic 原生格式：请求与响应直通，不需要协议转换，不会因为翻译丢字段。',
  openai_chat:
    '跨协议：请求要翻成 OpenAI Chat Completions 再翻回来。提示缓存标记、思考签名这类字段在目标协议里没有等价物，会记 HUB_DEGRADE_* 降级。',
  openai_responses:
    '跨协议：请求要翻成 OpenAI Responses 再翻回来。提示缓存标记、思考签名这类字段在目标协议里没有等价物，会记 HUB_DEGRADE_* 降级。',
  unknown: '读不出协议格式：settings_config 没能解析，也没有 meta.apiFormat，无法判断这次会不会跨协议降级。',
};

export function isCrossProtocol(format: ApiFormat): boolean {
  return format === 'openai_chat' || format === 'openai_responses';
}

export type FormatFilter = ApiFormat | 'all';

export const FORMAT_FILTER_OPTIONS: ReadonlyArray<{ value: FormatFilter; label: string }> = [
  { value: 'all', label: '全部协议' },
  { value: 'anthropic', label: 'anthropic（原生）' },
  { value: 'openai_chat', label: 'openai_chat（跨协议）' },
  { value: 'openai_responses', label: 'openai_responses（跨协议）' },
  { value: 'unknown', label: 'unknown（读不出）' },
];

/** 把 <select> 的字符串收回联合类型；不认识的值回落到「全部」而不是抛错 */
export function asFormatFilter(raw: string): FormatFilter {
  switch (raw) {
    case 'anthropic':
    case 'openai_chat':
    case 'openai_responses':
    case 'unknown':
      return raw;
    default:
      return 'all';
  }
}

// ---------------------------------------------------------------------------
// 语义兼容性
// ---------------------------------------------------------------------------

export const COMPATIBILITY_LABEL: Record<Compatibility, string> = {
  compatible: '已验收',
  incompatible: '不兼容',
  unassessed: '未评估',
};

export const COMPATIBILITY_TONE: Record<Compatibility, StatusTone> = {
  compatible: 'ok',
  incompatible: 'fail',
  unassessed: 'off',
};

/** 「未评估」的含义只在详情与表尾解释，不在每行重复 */
export const UNASSESSED_EXPLAINER =
  '尚未做 Claude Code 语义验收：长 system prompt、工具调用、多轮终态这三项还没跑过用例。含义是「没人验过」，不是「不能用」。';

export function unassessedSummary(count: number): string {
  return `列出的渠道里有 ${count} 个尚未做 Claude Code 语义验收（长 system prompt、工具调用、多轮终态），它们在「语义兼容性」列显示灰点「未评估」。`;
}

export const INCOMPATIBLE_LAUNCH_NOTE =
  '判为不兼容的渠道仍然可以启动：claude1 只接受按 id 的显式选择，那条路径只用于诊断。';

// ---------------------------------------------------------------------------
// 行状态点
// ---------------------------------------------------------------------------

export interface ChannelStatus {
  tone: StatusTone;
  text: string;
  title: string;
}

/**
 * 一行最多两枚状态点：当前渠道的青点，以及真正影响可用性的那一条。
 * 没有问题且不是当前渠道时只显示一枚绿点。
 */
export function channelStatuses(channel: Channel): ChannelStatus[] {
  const out: ChannelStatus[] = [];
  if (channel.isCurrent) {
    out.push({
      tone: 'current',
      text: '当前',
      title: 'CC Switch 的当前渠道：不指定选择器时 claude1 用它',
    });
  }
  const problem = channelProblem(channel);
  if (problem !== null) {
    out.push(problem);
  } else if (!channel.isCurrent) {
    out.push({
      tone: 'ok',
      text: '可用',
      title: '凭证已配置，没有被隐藏，也没有被语义闸门判为不兼容',
    });
  }
  return out;
}

function channelProblem(channel: Channel): ChannelStatus | null {
  if (channel.credential === 'missing') {
    return {
      tone: 'fail',
      text: '凭证未配置',
      title: 'settings_config 的 env 里没有可用的 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN，启动后会被上游拒绝',
    };
  }
  if (channel.compatibility === 'incompatible') {
    return {
      tone: 'fail',
      text: '不建议使用',
      title: 'Claude Code 语义闸门判为不兼容，原因见「语义兼容性」列',
    };
  }
  if (channel.hidden) {
    return {
      tone: 'off',
      text: '已隐藏',
      title: '已隐藏：claude1 的普通选择器不列出它，别名与 id 仍然能启动',
    };
  }
  return null;
}

/** 「只看可用」的口径：没隐藏、凭证有、没被判不兼容 */
export function isUsable(channel: Channel): boolean {
  return !channel.hidden && channel.credential === 'configured' && channel.compatibility !== 'incompatible';
}

// ---------------------------------------------------------------------------
// 模型 / 上下文窗口 / effort
// ---------------------------------------------------------------------------

export interface ModelCell {
  /** 要显示的文本；没有模型时是一句中文说明而不是空字符串 */
  text: string;
  /** text 是不是模型 id（决定要不要 mono） */
  isIdentifier: boolean;
  overridden: boolean;
  title: string;
}

export function channelModel(channel: Channel): ModelCell {
  if (channel.modelOverride !== null) {
    const declared =
      channel.declaredModel === null ? '渠道自己没声明模型' : `渠道声明的是 ${channel.declaredModel}`;
    return {
      text: channel.modelOverride,
      isIdentifier: true,
      overridden: true,
      title: `本地覆盖：claude1-config.json 把模型改成了 ${channel.modelOverride}（${declared}）`,
    };
  }
  if (channel.declaredModel !== null) {
    return {
      text: channel.declaredModel,
      isIdentifier: true,
      overridden: false,
      title: '渠道 settings_config 里的 env.ANTHROPIC_MODEL',
    };
  }
  return {
    text: '未指定',
    isIdentifier: false,
    overridden: false,
    title: '渠道没声明 env.ANTHROPIC_MODEL，也没有本地覆盖：启动后用 Claude Code 自己的默认模型',
  };
}

export const CONTEXT_WINDOW_UNKNOWN_TITLE =
  '渠道没声明 claude1_capabilities.context_window，这里不猜一个数字充数';

export function contextWindowTitle(tokens: number): string {
  return `${tokens} token，来自 settings_config 的 claude1_capabilities.context_window`;
}

export type EffortChoice = Effort | 'none';

export const EFFORT_CHOICES: ReadonlyArray<{ value: EffortChoice; label: string; title: string }> = [
  { value: 'none', label: '未设置', title: '不写 effort：由渠道 settings_config 的 effortLevel 决定' },
  { value: 'low', label: 'low', title: '本地覆盖 effortLevel 为 low' },
  { value: 'medium', label: 'medium', title: '本地覆盖 effortLevel 为 medium' },
  { value: 'high', label: 'high', title: '本地覆盖 effortLevel 为 high' },
  { value: 'xhigh', label: 'xhigh', title: '本地覆盖 effortLevel 为 xhigh' },
];

export const SLOT_ORDER: readonly SlotName[] = ['fable', 'opus', 'sonnet', 'haiku'];

// ---------------------------------------------------------------------------
// 端点：渲染层的凭证第二道闸
// ---------------------------------------------------------------------------

/**
 * 端点在 Rust 侧已经剥过 userinfo 与查询串，这里再剥一遍。
 * 顺序与 Rust 的 sanitize_endpoint 一致：先切 ?/#，再切 authority 里的 `@`。
 */
export function safeEndpoint(raw: string | null): string | null {
  if (raw === null) return null;
  const redacted = redactSecrets(raw).trim();
  if (redacted === '') return null;
  const beforeQuery = redacted.split(/[?#]/)[0];
  const schemeEnd = beforeQuery.indexOf('://');
  const scheme = schemeEnd === -1 ? '' : beforeQuery.slice(0, schemeEnd + 3);
  const rest = schemeEnd === -1 ? beforeQuery : beforeQuery.slice(schemeEnd + 3);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);
  const at = authority.lastIndexOf('@');
  const host = at === -1 ? authority : authority.slice(at + 1);
  if (host === '') return null;
  return `${scheme}${host}${path.replace(/\/+$/, '')}`;
}

// ---------------------------------------------------------------------------
// 搜索
// ---------------------------------------------------------------------------

/** 按渠道名、别名与模型名过滤。子串匹配，不做模糊匹配：筛选框要可预测 */
export function matchesQuery(channel: Channel, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const parts: Array<string | undefined> = [
    channel.name,
    channel.alias ?? undefined,
    channel.modelOverride ?? undefined,
    channel.declaredModel ?? undefined,
    ...SLOT_ORDER.map((slot) => channel.slotModels[slot]),
  ];
  return parts.join(' ').toLowerCase().includes(needle);
}

// ---------------------------------------------------------------------------
// 最近 24 小时的降级码
// ---------------------------------------------------------------------------

export const WINDOW_SECONDS = 24 * 60 * 60;

/** DESIGN.md 4.4 的严重度配色：info 灰、notice 青、degraded 与 lossy 琥珀 */
export const SEVERITY_TONE: Record<DegradeSeverity, StatusTone> = {
  info: 'off',
  notice: 'current',
  degraded: 'degraded',
  lossy: 'degraded',
};

export interface DegradeCount {
  code: string;
  count: number;
}

export interface ChannelWindow {
  /** recentUsage 里有没有任何记录：一条都没有是「还没读到用量」，不是「没有降级」 */
  hasAnyRows: boolean;
  /** recentUsage 覆盖到的最早时间，用来说明 24 小时窗口有没有被条数上限截断 */
  oldestTs: number | null;
  turns: number;
  degradedTurns: number;
  inTokens: number;
  outTokens: number;
  cacheReadTokens: number;
  /** 按次数降序、同次数按严重度排的降级码 */
  top: DegradeCount[];
}

/** journal 的 channel 字段可能写的是渠道名、别名或 id，三者都认 */
function channelKeys(channel: Channel): string[] {
  const raw = [channel.name, channel.id, channel.alias ?? ''];
  return raw.map((key) => key.trim().toLowerCase()).filter((key) => key !== '');
}

function codesOf(row: UsageRow): string[] {
  return Array.isArray(row.deg) ? row.deg : [];
}

export function channelWindow(
  rows: UsageRow[],
  channel: Channel,
  now: number,
  limit: number = 3,
): ChannelWindow {
  const keys = channelKeys(channel);
  const since = now - WINDOW_SECONDS;
  const counts = new Map<string, number>();
  let oldestTs: number | null = null;
  let turns = 0;
  let degradedTurns = 0;
  let inTokens = 0;
  let outTokens = 0;
  let cacheReadTokens = 0;

  for (const row of rows) {
    if (oldestTs === null || row.ts < oldestTs) oldestTs = row.ts;
    if (row.ts < since) continue;
    if (!keys.includes(row.channel.trim().toLowerCase())) continue;
    turns += 1;
    inTokens += row.in ?? 0;
    outTokens += row.out ?? 0;
    cacheReadTokens += row.cr ?? 0;
    const codes = codesOf(row);
    if (codes.length > 0) degradedTurns += 1;
    for (const code of codes) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }

  const top = Array.from(counts, ([code, count]) => ({ code, count }))
    .sort((a, b) => (b.count - a.count) || compareDegrade(a.code, b.code) || a.code.localeCompare(b.code))
    .slice(0, limit);

  return {
    hasAnyRows: rows.length > 0,
    oldestTs,
    turns,
    degradedTurns,
    inTokens,
    outTokens,
    cacheReadTokens,
    top,
  };
}
