/**
 * 降级记录的聚合。纯函数，不碰 React。
 *
 * 数据来自两份 journal 的 deg 字段：用量流水（一个正常回合也可能带降级码）与错误流水
 * （失败的那一轮同样会记降级）。两边都收，并保留 origin，让人看得出这条降级是从哪儿来的
 * ——不合并、不去重：同一回合两边都记了就是两条证据，替用户猜哪条是"真的"才是伪装。
 *
 * 文案一律走 lookupDegrade，本文件不产出任何人话句子。
 */
import type { StatusToneInput } from '../../../components';
import { SEVERITY_ORDER, compareDegrade, lookupDegrade } from '../../../data/degradeCatalog';
import type { DegradeEntry, DegradeSeverity } from '../../../data/degradeCatalog';
import type { ErrorRow, UsageRow } from '../../../types/contract';

/**
 * 严重度 → StatusDot 语义色（DESIGN.md 第 4.4 节写死）：
 * info 灰点、notice 青点、degraded 琥珀点、lossy 琥珀点（标题另外加粗）。
 */
export const SEVERITY_TONE: Record<DegradeSeverity, StatusToneInput> = {
  info: 'off',
  notice: 'current',
  degraded: 'degraded',
  lossy: 'degraded',
};

/** 由严重到轻，供汇总条与筛选按固定顺序渲染 */
export const SEVERITY_KEYS: DegradeSeverity[] = (['lossy', 'degraded', 'notice', 'info'] as DegradeSeverity[]).sort(
  (left, right) => SEVERITY_ORDER[left] - SEVERITY_ORDER[right],
);

export type DegradeOrigin = 'usage' | 'error';

export const ORIGIN_LABEL: Record<DegradeOrigin, string> = {
  usage: '用量流水',
  error: '错误流水',
};

/** 一条降级记录 = 一个回合在某份 journal 里留下的那一组降级码 */
export interface DegradeOccurrence {
  /** 列表 key，不参与展示 */
  id: string;
  ts: number;
  origin: DegradeOrigin;
  channel: string | null;
  model: string | null;
  format: string | null;
  /** 只有错误流水才有阶段 */
  phase: string | null;
  /** 该回合的全部降级码，已按严重度排序（lossy 在前） */
  codes: string[];
  /** 与 codes 一一对应的人话条目 */
  entries: DegradeEntry[];
  /** 这一组里最严重的一档 */
  severity: DegradeSeverity;
}

/** 按降级码聚合后的一组 */
export interface DegradeGroup {
  code: string;
  entry: DegradeEntry;
  severity: DegradeSeverity;
  /** 出现次数 */
  count: number;
  /** 出现记录，按时间倒序 */
  occurrences: DegradeOccurrence[];
  /** 最近一次出现的时间 */
  lastTs: number;
}

export type SeverityTally = Record<DegradeSeverity, number>;

function blankTally(): SeverityTally {
  return { lossy: 0, degraded: 0, notice: 0, info: 0 };
}

/** 去重并按严重度排序：同一回合里重复写了同一个码时只留一份 */
function normalizeCodes(codes: readonly string[]): string[] {
  return Array.from(new Set(codes.filter((code) => code !== ''))).sort(compareDegrade);
}

function toOccurrence(
  id: string,
  ts: number,
  origin: DegradeOrigin,
  channel: string | null,
  model: string | null,
  format: string | null,
  phase: string | null,
  rawCodes: readonly string[],
): DegradeOccurrence | null {
  const codes = normalizeCodes(rawCodes);
  if (codes.length === 0) return null;
  const entries = codes.map(lookupDegrade);
  return { id, ts, origin, channel, model, format, phase, codes, entries, severity: entries[0].severity };
}

/**
 * 从用量流水与错误流水里收集全部带降级码的回合，按时间倒序。
 * 注意范围：两个入参都是 store 里的"最近 N 条"，不是全量 journal，调用方必须把范围说出来。
 */
export function collectDegradeOccurrences(
  usage: readonly UsageRow[],
  errors: readonly ErrorRow[],
): DegradeOccurrence[] {
  const out: DegradeOccurrence[] = [];
  usage.forEach((row, index) => {
    const item = toOccurrence(`deg-usage-${index}`, row.ts, 'usage', row.channel, row.model, row.format, null, row.deg);
    if (item !== null) out.push(item);
  });
  errors.forEach((row, index) => {
    const item = toOccurrence(`deg-error-${index}`, row.ts, 'error', row.channel, row.model, row.format, row.phase, row.deg);
    if (item !== null) out.push(item);
  });
  out.sort((left, right) => right.ts - left.ts);
  return out;
}

/**
 * 按降级码聚合。排序把 lossy 排最前（compareDegrade），同档再按出现次数降序
 * ——会让人损失钱、可复现性或原始证据的那些必须先被看到。
 */
export function groupDegradeByCode(occurrences: readonly DegradeOccurrence[]): DegradeGroup[] {
  const buckets = new Map<string, DegradeGroup>();
  for (const occurrence of occurrences) {
    occurrence.codes.forEach((code, index) => {
      const existing = buckets.get(code);
      if (existing === undefined) {
        const entry = occurrence.entries[index];
        buckets.set(code, {
          code,
          entry,
          severity: entry.severity,
          count: 1,
          occurrences: [occurrence],
          lastTs: occurrence.ts,
        });
        return;
      }
      existing.count += 1;
      existing.occurrences.push(occurrence);
      if (occurrence.ts > existing.lastTs) existing.lastTs = occurrence.ts;
    });
  }
  return Array.from(buckets.values()).sort(
    (left, right) =>
      compareDegrade(left.code, right.code) || right.count - left.count || left.code.localeCompare(right.code),
  );
}

/**
 * 按严重度统计**降级码出现次数**（一个回合带三个码就记三次）。
 * 口径必须和汇总条上的说明一致，否则数字和列表长度对不上会让人以为界面在骗人。
 */
export function tallySeverity(occurrences: readonly DegradeOccurrence[]): SeverityTally {
  const tally = blankTally();
  for (const occurrence of occurrences) {
    for (const entry of occurrence.entries) {
      tally[entry.severity] += 1;
    }
  }
  return tally;
}

/** 这一回合是否含有该档的降级码。汇总条的筛选按这个口径，和计数口径对齐 */
export function occurrenceHasSeverity(occurrence: DegradeOccurrence, severity: DegradeSeverity): boolean {
  return occurrence.entries.some((entry) => entry.severity === severity);
}

/** 搜索用的干草堆：码、人话标题、渠道、模型、格式、时间都能搜到 */
export function degradeHaystack(occurrence: DegradeOccurrence): string {
  return [
    occurrence.channel ?? '',
    occurrence.model ?? '',
    occurrence.format ?? '',
    occurrence.phase ?? '',
    ORIGIN_LABEL[occurrence.origin],
    ...occurrence.codes,
    ...occurrence.entries.map((entry) => entry.title),
  ]
    .join(' ')
    .toLowerCase();
}
