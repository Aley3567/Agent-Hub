/**
 * 时间范围预设。纯计算，不碰 React，也不写 store——写回 store 由视图统一做。
 *
 * 三个预设都按本地时区的整天对齐（与 store 的默认时间窗口径一致），
 * 所以「7 天」= 今天零点往前推 6 天，含今天共 7 个自然日，而不是往前推 168 小时。
 */
import { startOfTodaySeconds } from '../../../store';

export type RangePreset = 'today' | 'week' | 'month';

/** 预设值加一个「自定义」态：跨过零点后实际窗口会与任何预设都不相等，那时如实显示 */
export type RangeChoice = RangePreset | 'custom';

const SECONDS_PER_DAY = 86400;

/** 每个预设覆盖的自然日数（含今天） */
export const PRESET_DAYS: Record<RangePreset, number> = {
  today: 1,
  week: 7,
  month: 30,
};

export const PRESET_LABEL: Record<RangePreset, string> = {
  today: '今天',
  week: '7 天',
  month: '30 天',
};

/** 预设对应的默认粒度：一天只有一个日桶，画不出走势，所以「今天」按小时看 */
export const PRESET_GRANULARITY: Record<RangePreset, 'hour' | 'day'> = {
  today: 'hour',
  week: 'day',
  month: 'day',
};

export function presetFrom(preset: RangePreset): number {
  return startOfTodaySeconds() - (PRESET_DAYS[preset] - 1) * SECONDS_PER_DAY;
}

/** 预设对应的时间窗。终点取当下，不取当天 24:00，免得图上多出一段永远为 0 的未来 */
export function rangeFor(preset: RangePreset): { fromTs: number; toTs: number } {
  return { fromTs: presetFrom(preset), toTs: Math.floor(Date.now() / 1000) };
}

/**
 * 反查当前时间窗属于哪个预设。三个预设的起点各不相同且都按整天对齐，
 * 所以起点相等即可判定；一个都不等时返回 null，由视图显示为「自定义」。
 */
export function matchPreset(fromTs: number): RangePreset | null {
  const presets: RangePreset[] = ['today', 'week', 'month'];
  for (const preset of presets) {
    if (presetFrom(preset) === fromTs) return preset;
  }
  return null;
}
