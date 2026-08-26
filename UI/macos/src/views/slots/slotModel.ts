/**
 * 槽位视图的纯逻辑层：槽位元数据、绑定可选项、fallback 去向、24 小时调用量分桶、
 * 一键填充计划。全部是纯函数，不碰 store、不碰 DOM，便于在别处直接推演结论。
 *
 * 这里的每一句面向用户的文案都对着真实实现写，不是猜的：
 *   - 未绑定槽位的 fallback 去向 = default_channel 的第一个声明模型
 *     （claude-provider-once.py 的 normalize_hub_config 在启动前就把它补齐）；
 *   - 未设置 effort 时落到的内置默认档 = HUB_DEFAULT_EFFORTS；
 *   - 绑定必须落在本 hub 声明的 channels 与它声明的 models 之内
 *     （set_hub_slot 会校验，claude-hub.py 读配置时也会校验）。
 */
import type {
  ApiFormat,
  Channel,
  Effort,
  HubChannel,
  HubConfig,
  SlotName,
  UsageRow,
} from '../../types/contract';

/** 四个原生槽位的固定顺序，与 claude-hub.py 的 HUB_SLOT_ORDER 一致 */
export const SLOT_ORDER = ['fable', 'opus', 'sonnet', 'haiku'] as const satisfies readonly SlotName[];

/**
 * 槽位没写 effort 时 claude1 落到的内置默认档。
 * 数值取自 claude-provider-once.py 的 HUB_DEFAULT_EFFORTS，界面据此告诉用户「未设置」到底等于什么。
 */
export const SLOT_DEFAULT_EFFORT: Record<SlotName, Effort> = {
  fable: 'xhigh',
  opus: 'high',
  sonnet: 'high',
  haiku: 'high',
};

/** 这一行会被什么请求命中。规则来自 claude-hub.py 的 route_model：裸槽位名与官方风格 id 都走这里 */
export function slotHitText(slot: SlotName): string {
  return `下游把模型写成 ${slot} 或 claude-${slot}-* 时命中这一行`;
}

/** effort 五档里的「未设置」用这个值表示，落到 IPC 时转成 null */
export const EFFORT_UNSET = 'none';

export type EffortChoice = 'none' | Effort;

export interface EffortChoiceOption {
  value: EffortChoice;
  label: string;
  title: string;
}

/** effort 五档（未设置 / low / medium / high / xhigh），「未设置」的提示按槽位给出真实默认档 */
export function effortChoices(slot: SlotName): EffortChoiceOption[] {
  return [
    {
      value: EFFORT_UNSET,
      label: '未设置',
      title: `不写 effort_by_slot.${slot}；claude1 启动这个槽位时落到内置默认档 ${SLOT_DEFAULT_EFFORT[slot]}`,
    },
    { value: 'low', label: 'low', title: `把 effort_by_slot.${slot} 写成 low` },
    { value: 'medium', label: 'medium', title: `把 effort_by_slot.${slot} 写成 medium` },
    { value: 'high', label: 'high', title: `把 effort_by_slot.${slot} 写成 high` },
    { value: 'xhigh', label: 'xhigh', title: `把 effort_by_slot.${slot} 写成 xhigh` },
  ];
}

export function toEffortChoice(effort: Effort | null | undefined): EffortChoice {
  return effort === null || effort === undefined ? EFFORT_UNSET : effort;
}

export function fromEffortChoice(choice: EffortChoice): Effort | null {
  return choice === EFFORT_UNSET ? null : choice;
}

export const PROTOCOL_LABEL: Record<ApiFormat, string> = {
  anthropic: 'Anthropic 原生',
  openai_chat: 'OpenAI Chat',
  openai_responses: 'OpenAI Responses',
  unknown: '协议未识别',
};

export function protocolLabel(format: ApiFormat | null): string {
  return format === null ? 'hub 未声明协议' : PROTOCOL_LABEL[format];
}

/**
 * 跨协议提示。anthropic 返回 null（无需提示）；其余一律给琥珀提示。
 * 只说「会产生降级、具体码去诊断视图看」——具体丢了什么由 HUB_DEGRADE_* 决定，这里不替它编。
 */
export function protocolWarning(format: ApiFormat | null): string | null {
  if (format === 'anthropic') return null;
  if (format === null) {
    return 'hub 配置没有声明这个渠道说什么协议。若它不是 Anthropic 原生，claude1 会做协议转换并记 HUB_DEGRADE_* 降级。';
  }
  if (format === 'unknown') {
    return '这个渠道的协议没能识别出来。只要不是 Anthropic 原生，转换过程就会记 HUB_DEGRADE_* 降级。';
  }
  return `这个渠道说的是 ${PROTOCOL_LABEL[format]}，与 Anthropic 之间要做协议转换，会记 HUB_DEGRADE_* 降级。`;
}

/** hub 渠道别名（大小写不敏感）→ hub 渠道声明。找不到返回 null */
export function findHubChannelByName(
  channels: HubChannel[],
  alias: string | null | undefined,
): HubChannel | null {
  if (alias === null || alias === undefined) return null;
  const folded = alias.trim().toLowerCase();
  if (folded === '') return null;
  return channels.find((item) => item.name.trim().toLowerCase() === folded) ?? null;
}

/** findHubChannelByName 的 hub 版本 */
export function findHubChannel(hub: HubConfig, alias: string | null | undefined): HubChannel | null {
  return findHubChannelByName(hub.channels, alias);
}

/** hub 渠道声明的第一个非空模型；一个都没有返回 null */
export function firstDeclaredModel(channel: HubChannel | null): string | null {
  if (channel === null) return null;
  const models = channel.models.map((model) => model.trim()).filter((model) => model !== '');
  return models.length === 0 ? null : models[0];
}

export interface FallbackInfo {
  /** fallback 去向是否成立。false 表示这个 hub 连 fallback 都没有，启动就会报错 */
  ok: boolean;
  text: string;
}

/**
 * 未绑定槽位的 fallback 去向。
 * claude1 启动 hub 前会把缺失的槽位补成 `default_channel,default_channel 的第一个声明模型`，
 * 所以这就是「走 fallback」的确切落点，而不是一句含糊的「走默认」。
 */
export function hubFallback(hub: HubConfig): FallbackInfo {
  const alias = hub.defaultChannel;
  if (alias === null || alias.trim() === '') {
    return {
      ok: false,
      text: '本 hub 没有配置 default_channel，未绑定的槽位没有去处，claude1 启动时会报「hub 配置缺少 default_channel」。',
    };
  }
  const channel = findHubChannel(hub, alias);
  const model = firstDeclaredModel(channel);
  if (channel === null || model === null) {
    return {
      ok: false,
      text: `default_channel 指向的 ${alias} 在本 hub 里没有声明模型，claude1 启动时会报「hub default_channel 必须引用有模型的渠道」。`,
    };
  }
  return {
    ok: true,
    text: `fallback 去向：默认渠道 ${alias} 的第一个声明模型 ${model}。claude1 启动 hub 时会把未绑定的槽位补成这一对。`,
  };
}

/** 本机可用但尚未写进这个 hub 的 channels 的渠道。它们不能直接绑定，只能先加入 hub */
export function undeclaredChannels(hub: HubConfig, channels: Channel[]): Channel[] {
  const declared = new Set<string>();
  for (const item of hub.channels) {
    if (item.resolvedChannelId !== null) declared.add(item.resolvedChannelId);
  }
  return channels.filter((channel) => !channel.hidden && !declared.has(channel.id));
}

/** 一个 hub 渠道背后的 CC Switch 渠道，解析不到返回 null */
export function resolvedChannel(
  channel: HubChannel | null,
  byId: Map<string, Channel>,
): Channel | null {
  if (channel === null || channel.resolvedChannelId === null) return null;
  return byId.get(channel.resolvedChannelId) ?? null;
}

export const USAGE_BUCKETS = 24;
export const SECONDS_PER_HOUR = 3600;

export interface SlotUsage {
  /** 24 个整点桶的回合数，末桶是当前小时 */
  buckets: number[];
  turns: number;
  /** in + out + cr + cw 的合计，只报 token 量，不折算金额 */
  tokens: number;
  /** 带 HUB_DEGRADE_* 的回合数 */
  degraded: number;
  from: number;
  to: number;
}

/**
 * 从用量流水里切出某个绑定最近 24 小时的调用量，按整点分 24 桶。
 * 匹配键是「渠道别名 + 模型 id」——流水的 channel 写的就是 hub 渠道别名，model 写的是解析后的
 * 上游模型 id，与槽位绑定同源，所以这两项相等即同一条路由。
 */
export function slotUsage(
  rows: UsageRow[],
  binding: { channel: string; model: string } | null,
  now: number,
): SlotUsage {
  const to = Math.floor(now / SECONDS_PER_HOUR) * SECONDS_PER_HOUR + SECONDS_PER_HOUR;
  const from = to - USAGE_BUCKETS * SECONDS_PER_HOUR;
  const buckets = new Array<number>(USAGE_BUCKETS).fill(0);
  let turns = 0;
  let tokens = 0;
  let degraded = 0;
  if (binding !== null) {
    const channel = binding.channel.trim().toLowerCase();
    const model = binding.model.trim().toLowerCase();
    for (const row of rows) {
      if (row.ts < from || row.ts >= to) continue;
      if (row.channel.trim().toLowerCase() !== channel) continue;
      if (row.model.trim().toLowerCase() !== model) continue;
      const index = Math.floor((row.ts - from) / SECONDS_PER_HOUR);
      if (index < 0 || index >= USAGE_BUCKETS) continue;
      buckets[index] += 1;
      turns += 1;
      tokens += (row.in ?? 0) + (row.out ?? 0) + (row.cr ?? 0) + (row.cw ?? 0);
      if (row.deg.length > 0) degraded += 1;
    }
  }
  return { buckets, turns, tokens, degraded, from, to };
}

/**
 * 一个槽位的填充结论。用可辨识联合而不是「model 可能为 null」——调用方拿到 fill: true 就
 * 一定有 model，不必再写一遍不可能触发的空值分支。
 */
export type FillItem =
  | { slot: SlotName; fill: false; reason: string }
  | { slot: SlotName; fill: true; model: string; unchanged: boolean };

/** 一个 hub 的填充计划。ok 为 false 时整个 hub 都填不了，原因在 blocked 里 */
export type FillPlan =
  | { hubName: string; ok: false; blocked: string }
  | { hubName: string; ok: true; alias: string; items: FillItem[] };

/**
 * 「按当前渠道一键填充四槽」的计划。两条明确规则，谁都能复算：
 *   规则一：用该渠道 settings_config 声明的槽位默认模型（ANTHROPIC_DEFAULT_<SLOT>_MODEL），
 *           且它必须在 hub 渠道声明的 models 里；
 *   规则二：hub 渠道声明的 models 里，模型 id 含槽位名且**只有一个**候选时用它；
 * 两条都不满足就跳过并写清原因。绝不为了填满四槽而挑一个无关模型。
 */
export function buildFillPlan(hub: HubConfig, current: Channel | null): FillPlan {
  if (current === null) {
    return {
      hubName: hub.name,
      ok: false,
      blocked: 'CC Switch 没有标记当前渠道（is_current），没有可以照着填的渠道。',
    };
  }
  const target = hub.channels.find((item) => item.resolvedChannelId === current.id) ?? null;
  if (target === null) {
    return {
      hubName: hub.name,
      ok: false,
      blocked: `本 hub 的 channels 里没有指向渠道 ${current.name} 的声明，先把它写进 hub 配置的 channels 才能绑定。`,
    };
  }
  const declared = target.models.map((model) => model.trim()).filter((model) => model !== '');
  const alias = target.name;
  const items: FillItem[] = SLOT_ORDER.map((slot) => {
    const preferred = current.slotModels[slot];
    if (preferred !== undefined && declared.includes(preferred)) {
      return { slot, fill: true, model: preferred, unchanged: isBound(hub, slot, alias, preferred) };
    }
    const guesses = declared.filter((item) => item.toLowerCase().includes(slot));
    if (guesses.length === 1) {
      return { slot, fill: true, model: guesses[0], unchanged: isBound(hub, slot, alias, guesses[0]) };
    }
    if (guesses.length > 1) {
      return {
        slot,
        fill: false,
        reason: `hub 渠道 ${alias} 有 ${guesses.length} 个模型含 ${slot}（${guesses.join('、')}），不替你猜，请手动选。`,
      };
    }
    if (declared.length === 0) {
      return { slot, fill: false, reason: `hub 渠道 ${alias} 一个模型都没声明，先给它加模型。` };
    }
    return {
      slot,
      fill: false,
      reason: `渠道 ${current.name} 没声明 ${slot} 的默认模型，hub 渠道 ${alias} 声明的 ${declared.join('、')} 里也没有含 ${slot} 的，请手动选。`,
    };
  });
  return { hubName: hub.name, ok: true, alias, items };
}

/** 某个槽位当前是否已经绑在这一对上（渠道别名大小写不敏感，模型 id 严格相等） */
function isBound(hub: HubConfig, slot: SlotName, alias: string, model: string): boolean {
  const bound = hub.slots[slot] ?? null;
  if (bound === null) return false;
  return bound.channel.trim().toLowerCase() === alias.trim().toLowerCase() && bound.model === model;
}
