/**
 * 格式化工具：token 计数、成本、时间戳、百分比。
 *
 * 全部返回适合 `font-variant-numeric: tabular-nums` 的定宽形式——k / M 一律保留一位小数，
 * 避免表格里数字宽度跳动（DESIGN.md 第 2.3 节：大数字用 tabular-nums）。
 * 取不到值时统一返回破折号，绝不返回 0 冒充真实数据。
 */

/** 数值缺失时的占位符，界面上表示「没有这个数」而不是「零」 */
export const MISSING = '—';

function isMissing(value: number | null | undefined): value is null | undefined {
  return value === null || value === undefined || !Number.isFinite(value);
}

/** 千分位分组，deterministic，不依赖运行时 locale */
function groupThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * token 计数：万以下用千分位，万以上用 k，百万以上用 M，十亿以上用 B。
 * 例：999 → "999"、1234 → "1,234"、12345 → "12.3k"、1234567 → "1.2M"。
 */
export function formatTokens(n: number | null | undefined): string {
  if (isMissing(n)) return MISSING;
  const negative = n < 0;
  const abs = Math.abs(n);
  let text: string;
  // 先按一位小数定档再判断量级，免得 999999 被写成 "1000.0k" 这种越界形式
  const k = Math.round(abs / 100) / 10;
  const m = Math.round(abs / 100_000) / 10;
  const b = Math.round(abs / 100_000_000) / 10;
  if (abs < 10000) {
    text = groupThousands(Math.round(abs));
  } else if (k < 1000) {
    text = `${k.toFixed(1)}k`;
  } else if (m < 1000) {
    text = `${m.toFixed(1)}M`;
  } else {
    text = `${b.toFixed(1)}B`;
  }
  return negative ? `-${text}` : text;
}

/**
 * 中文短 token：≥1 亿用 X.XX 亿，≥1 万用 X.X 万，否则千分位。
 * 用于 hero 大数字的副行，继承 cc-switch 的口径（AGENTS.md：继承优先于发明）。
 */
export function formatTokensCn(n: number | null | undefined): string {
  if (isMissing(n)) return MISSING;
  const abs = Math.abs(n);
  if (abs >= 100_000_000) return `${(n / 100_000_000).toFixed(2)}亿`;
  if (abs >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return groupThousands(Math.round(n));
}

/**
 * 美元成本。≥1 两位小数，<1 四位小数，null 返回破折号。
 * 返回带 `$` 前缀，适合 KPI 与坐标轴。
 */
export function formatCostUsd(n: number | null | undefined): string {
  if (isMissing(n)) return MISSING;
  const value = Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(4);
  return `$${value}`;
}

/** 整数计数（请求数、条目数），只做千分位，不做缩写 */
export function formatCount(n: number | null | undefined): string {
  if (isMissing(n)) return MISSING;
  const rounded = Math.round(n);
  return rounded < 0 ? `-${groupThousands(Math.abs(rounded))}` : groupThousands(rounded);
}

/** journal 里的时间戳是 unix 秒；这里同时容忍毫秒，避免调用方踩坑 */
function toDate(ts: number): Date {
  return new Date(Math.abs(ts) > 1e11 ? ts : ts * 1000);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export interface FormatTimeOptions {
  /** 是否带年月日，默认 true */
  date?: boolean;
  /** 是否带秒，默认 true */
  seconds?: boolean;
}

/**
 * 绝对时间，本地时区，形如 "2026-08-19 14:03:22"。
 * 日志类表格默认带秒，便于和 journal 原文对照。
 */
export function formatTime(ts: number | null | undefined, options: FormatTimeOptions = {}): string {
  if (isMissing(ts)) return MISSING;
  const withDate = options.date !== false;
  const withSeconds = options.seconds !== false;
  const d = toDate(ts);
  const clock = withSeconds
    ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
    : `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (!withDate) return clock;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock}`;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * 中文相对时间，例如「3 分钟前」「2 小时前」「5 天前」。
 * 未来时间说「后」，10 秒内说「刚刚」。now 参数便于调用方对齐同一批数据的基准时刻。
 */
export function formatRelative(ts: number | null | undefined, now: number = Date.now() / 1000): string {
  if (isMissing(ts)) return MISSING;
  const target = Math.abs(ts) > 1e11 ? ts / 1000 : ts;
  const base = Math.abs(now) > 1e11 ? now / 1000 : now;
  const diff = base - target;
  const abs = Math.abs(diff);
  const suffix = diff >= 0 ? '前' : '后';
  if (abs < 10) return '刚刚';
  if (abs < MINUTE) return `${Math.floor(abs)} 秒${suffix}`;
  if (abs < HOUR) return `${Math.floor(abs / MINUTE)} 分钟${suffix}`;
  if (abs < DAY) return `${Math.floor(abs / HOUR)} 小时${suffix}`;
  if (abs < MONTH) return `${Math.floor(abs / DAY)} 天${suffix}`;
  if (abs < YEAR) return `${Math.floor(abs / MONTH)} 个月${suffix}`;
  return `${Math.floor(abs / YEAR)} 年${suffix}`;
}

/**
 * 比例转百分比。入参是 0–1 的比率（UsageSummary.cacheHitRate 就是这个口径）。
 * null 直接返回破折号——没有输入 token 时命中率不存在，不能显示成 0%。
 */
export function formatPercent(x: number | null | undefined, digits: number = 1): string {
  if (isMissing(x)) return MISSING;
  const safeDigits = Math.max(0, Math.min(3, Math.trunc(digits)));
  return `${(x * 100).toFixed(safeDigits)}%`;
}
