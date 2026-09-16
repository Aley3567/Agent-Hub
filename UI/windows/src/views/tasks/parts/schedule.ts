/**
 * cron 串与可视化选择器草稿之间的纯转换。纯计算，不碰 React、store 与 api。
 *
 * 这一层只回答两件事：「这个 cron 串能不能用选择器表达」（detectDraft）、
 * 「选择器里的草稿对应哪个 cron 串」（toCron）。cron 是否合法、下次运行时间是多少
 * 仍由后端裁定（DESIGN.md 4.7 分工），这里不推算、不校验语义。
 *
 * 关键不变量：detectDraft 认不出的原串一律原样回显为 custom，不静默改写。
 * 「用户没动过控件就不写回」由调用方的脏标记保证（见 SchedulePicker）。
 */

export type Tier = 'hourly' | 'daily' | 'weekly' | 'custom';

export type Draft =
  | { tier: 'hourly'; minute: number }
  | { tier: 'daily'; minute: number; hour: number }
  | { tier: 'weekly'; minute: number; hour: number; days: number[] }
  | { tier: 'custom'; raw: string };

/** 值域内的一到两位十进制数；星号、星号加步长、负号一律不认 */
function parseNumber(raw: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= min && value <= max ? value : null;
}

/**
 * 周字段展开成 0（周日）… 6（周六）。只认逗号分隔的 `d` 与 `a-b`，
 * 7 折成 0、去重、升序；带步长的写法、越界、倒序区间都返回 null 交给 custom。
 */
function parseWeekdays(raw: string): number[] | null {
  const days = new Set<number>();
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (item === '') return null;
    const match = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(item);
    if (match === null) return null;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from > 7 || to > 7 || from > to) return null;
    for (let day = from; day <= to; day += 1) days.add(day === 7 ? 0 : day);
  }
  return [...days].sort((a, b) => a - b);
}

/**
 * 判断一个 cron 串该用哪一档选择器展示；认不出就是 custom 并保留原串。
 *
 * 日 / 月字段不是 `*` 时直接放弃（选择器没有这两个维度，硬塞会丢信息）；
 * 带步长的写法、多值分钟这类结构化不了的写法同样回落到 custom。
 */
export function detectDraft(raw: string): Draft {
  const fields = raw.trim().split(/\s+/);
  if (fields.length !== 5) return { tier: 'custom', raw };
  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekdayRaw] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (dayRaw !== '*' || monthRaw !== '*') return { tier: 'custom', raw };
  const minute = parseNumber(minuteRaw, 0, 59);
  if (minute === null) return { tier: 'custom', raw };
  // 「时」为 `*` 且周字段不受限，才是「每小时第 N 分」这一档。
  // 少了后半句时 `0 * * * 1-5` 会被读成 hourly，toCron 吐出 `0 * * * *`
  // ——用户只调一下分钟就把「工作日」静默改成了「每天」。这种表达式选择器
  // 表达不了（没有「时全量 + 限定星期」这一档），落 custom 原样保留。
  if (hourRaw === '*' && weekdayRaw === '*') return { tier: 'hourly', minute };
  const hour = parseNumber(hourRaw, 0, 23);
  if (hour === null) return { tier: 'custom', raw };
  if (weekdayRaw === '*') return { tier: 'daily', minute, hour };
  const days = parseWeekdays(weekdayRaw);
  if (days === null) return { tier: 'custom', raw };
  return { tier: 'weekly', minute, hour, days };
}

/**
 * 周字段的紧凑写法：连续区间压成 `a-b`，不连续的用逗号列表。
 * 周日恒写 0，永不写 7。空集合返回空串——validate 会按「五个字段」拦下，
 * 这里不替用户编一个「每天都跑」出来。
 */
function formatDays(days: readonly number[]): string {
  const sorted = [...new Set(days.map((day) => (day === 7 ? 0 : day)))].sort((a, b) => a - b);
  const runs: number[][] = [];
  for (const day of sorted) {
    const last = runs.length === 0 ? null : runs[runs.length - 1];
    const tail = last === null ? null : last[last.length - 1];
    if (last !== null && tail !== null && day === tail + 1) last.push(day);
    else runs.push([day]);
  }
  return runs
    .map((run) => (run.length === 1 ? String(run[0]) : `${run[0]}-${run[run.length - 1]}`))
    .join(',');
}

/** 草稿对应的 cron 串。周与日同时受限时「日」字段硬写 `*`（Vixie 惯例取「或」）。 */
export function toCron(draft: Draft): string {
  switch (draft.tier) {
    case 'hourly':
      return `${draft.minute} * * * *`;
    case 'daily':
      return `${draft.minute} ${draft.hour} * * *`;
    case 'weekly':
      return `${draft.minute} ${draft.hour} * * ${formatDays(draft.days)}`;
    case 'custom':
      return draft.raw.trim();
  }
}
