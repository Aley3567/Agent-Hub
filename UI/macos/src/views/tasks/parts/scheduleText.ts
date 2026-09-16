/**
 * `ScheduleSpec` → 人话。纯计算：只依赖入参里的 locale，不读 store、不 import api，
 * 所以测试 harness 可以直接喂一个 spec 断言输出，不用先把 i18n 的当前语言拨到某一档。
 *
 * 后端不再给 `scheduleText`，文案归前端；认不出的结构（unknown）原样回显 cron 串，
 * 让用户看得见后端到底收到了什么，而不是给一句含糊的「时间表达式无效」。
 * `notes` 是后端附的说明，原样透传——这里不翻译、不裁剪。
 */
import type { ScheduleSpec } from '../../../types/contract';

/** 中文只写一次「周」，后面的日子用顿号带过（每周一、三、五）；英文同理用缩写 */
const ZH_DAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'] as const;
const EN_DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const EN_DAY_FULL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** 工作日：周一种周五。周日的 0 不在里面，所以 `[1,2,3,4,5]` 正好是工作日 */
const WORKDAYS = [1, 2, 3, 4, 5];

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** 时间一律两位补零，中文与英文同形 */
function clock(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

/** 契约保证升序去重，这里再压一道：展示逻辑不该依赖上游的字段顺序 */
function normalizeDays(days: readonly number[]): number[] {
  return [...new Set(days.map((day) => (day === 7 ? 0 : day)))].sort((a, b) => a - b);
}

function isWorkdays(days: readonly number[]): boolean {
  return days.length === WORKDAYS.length && WORKDAYS.every((day) => days.includes(day));
}

function describe(spec: ScheduleSpec, locale: 'zh' | 'en'): string {
  const zh = locale === 'zh';
  switch (spec.kind) {
    case 'hourly':
      return zh ? `每小时第 ${spec.minute} 分` : `Every hour at :${pad(spec.minute)}`;
    case 'daily':
      return zh ? `每天 ${clock(spec.hour, spec.minute)}` : `Daily at ${clock(spec.hour, spec.minute)}`;
    case 'weekly': {
      const days = normalizeDays(spec.days);
      const time = clock(spec.hour, spec.minute);
      if (isWorkdays(days)) return zh ? `每工作日 ${time}` : `Weekdays at ${time}`;
      if (days.length === 1) {
        const day = days[0] ?? 0;
        return zh ? `每周${ZH_DAY_SHORT[day]} ${time}` : `Every ${EN_DAY_FULL[day]} at ${time}`;
      }
      const zhDays = days.map((day, index) => (index === 0 ? `周${ZH_DAY_SHORT[day]}` : ZH_DAY_SHORT[day])).join('、');
      const enDays = days.map((day) => EN_DAY_SHORT[day]).join(', ');
      return zh ? `每${zhDays} ${time}` : `${enDays} at ${time}`;
    }
    case 'monthly':
      return zh
        ? `每月 ${spec.day} 日 ${clock(spec.hour, spec.minute)}`
        : `Monthly on day ${spec.day} at ${clock(spec.hour, spec.minute)}`;
    case 'everyMinutes':
      return zh ? `每 ${spec.period} 分钟` : `Every ${spec.period} minutes`;
    case 'unknown':
      return zh ? `按 cron「${spec.raw}」` : `Cron “${spec.raw}”`;
  }
}

/** 一行人话 + 后端附的 notes。notes 原样透传，不改写、不拼接。 */
export function formatSchedule(
  spec: ScheduleSpec,
  notes: string[],
  locale: 'zh' | 'en',
): { text: string; notes: string[] } {
  return { text: describe(spec, locale), notes };
}
