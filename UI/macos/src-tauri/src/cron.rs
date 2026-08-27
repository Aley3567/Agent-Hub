//! 标准五字段 cron（分 时 日 月 周）的下一触发时刻计算器。
//!
//! Cargo.toml 里没有 cron 库，也不引（与 journal.rs 一样直接走 libSystem 的
//! `localtime_r` / `mktime`，不引第三方时间库）。覆盖范围刻意收窄：
//! `*`、`,`、`-`、`*/n`（含 `a-b/n`）四种写法；周字段 0 与 7 都表示周日；
//! 「日」与「周」同时受限时按 Vixie cron 惯例取「或」。
//! 不支持英文名（JAN/MON）、`@daily` 这类宏、`L`/`W`/`#` 扩展。

// macOS libSystem 的 struct tm 布局（与 journal.rs 里的是同一份）。
#[allow(dead_code)]
#[repr(C)]
#[derive(Clone)]
struct CTm {
    sec: i32,
    min: i32,
    hour: i32,
    mday: i32,
    mon: i32,
    year: i32,
    wday: i32,
    yday: i32,
    isdst: i32,
    gmtoff: i64,
    zone: *const std::os::raw::c_char,
}

impl CTm {
    fn zeroed() -> Self {
        CTm {
            sec: 0,
            min: 0,
            hour: 0,
            mday: 0,
            mon: 0,
            year: 0,
            wday: 0,
            yday: 0,
            isdst: 0,
            gmtoff: 0,
            zone: std::ptr::null(),
        }
    }
}

extern "C" {
    fn localtime_r(clock: *const i64, result: *mut CTm) -> *mut CTm;
    fn mktime(tm: *mut CTm) -> i64;
}

/// 取某个 unix 秒的本地分解时间。
fn local_breakdown(ts: i64) -> Option<CTm> {
    let clock: i64 = ts;
    let mut out = CTm::zeroed();
    let result = unsafe { localtime_r(&clock as *const i64, &mut out) };
    if result.is_null() {
        return None;
    }
    Some(out)
}

/// 把本地分解时间换回 unix 秒。`isdst = -1` 让 mktime 自己判断夏令时。
fn local_mktime(year: i32, mon0: i32, mday: i32, hour: i32, min: i32) -> Option<i64> {
    let mut tm = CTm {
        sec: 0,
        min,
        hour,
        mday,
        mon: mon0,
        year,
        wday: 0,
        yday: 0,
        isdst: -1,
        gmtoff: 0,
        zone: std::ptr::null(),
    };
    let ts = unsafe { mktime(&mut tm) };
    if ts == -1 {
        return None;
    }
    Some(ts)
}

/// 解析后的五字段 cron。每个字段一个位图，第 i 位置位表示「i 命中」。
#[derive(Debug, Clone)]
pub struct Schedule {
    /// 分，位 0..=59
    minutes: u64,
    /// 时，位 0..=23
    hours: u32,
    /// 日，位 1..=31
    month_days: u32,
    /// 月，位 1..=12
    months: u16,
    /// 周，位 0..=6（0 = 周日，7 在解析时折叠到 0）
    weekdays: u8,
    /// 「日」字段是否受限（不是 `*`）
    dom_restricted: bool,
    /// 「周」字段是否受限
    dow_restricted: bool,
}

struct FieldSpec {
    label: &'static str,
    min: u32,
    max: u32,
    /// 周字段专用：把 7 折叠成 0
    fold_sunday: bool,
}

/// 解析一个字段：`*`、`,`、`-`、`*/n`、`a-b/n`。
/// 返回 (位图, 是否受限)。
fn parse_field(raw: &str, spec: &FieldSpec) -> Result<(u64, bool), String> {
    let mut bits: u64 = 0;
    let mut restricted = false;
    for part in raw.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(format!("cron 的{}字段里有空片段：{raw}", spec.label));
        }
        let (base, step) = match part.split_once('/') {
            Some((base, step)) => {
                let step: u32 = step
                    .trim()
                    .parse()
                    .ok()
                    .filter(|n| *n >= 1)
                    .ok_or_else(|| format!("cron 的{}字段步长无效：{part}", spec.label))?;
                (base.trim(), step)
            }
            None => (part, 1),
        };
        let (lo, hi) = if base == "*" {
            (spec.min, spec.max)
        } else if let Some((a, b)) = base.split_once('-') {
            let lo = parse_bound(a, spec, part)?;
            let hi = parse_bound(b, spec, part)?;
            if lo > hi {
                return Err(format!("cron 的{}字段范围颠倒：{part}", spec.label));
            }
            (lo, hi)
        } else {
            let value = parse_bound(base, spec, part)?;
            (value, value)
        };
        if lo != spec.min || hi != spec.max || step != 1 {
            restricted = true;
        }
        let mut value = lo;
        while value <= hi {
            let folded = if spec.fold_sunday && value == 7 {
                0
            } else {
                value
            };
            bits |= 1u64 << folded;
            // checked_add 而不是 +=：step 只校验了 >=1 没设上限（u32::MAX 是合法步长），
            // 溢出在 debug 构建 panic 会卡死 IPC 线程，release 回绕成错误位图
            //（`5/4294967295` 会把 00-05 分全部置位）。溢出即到达 hi 上限，直接停。
            value = match value.checked_add(step) {
                Some(next) => next,
                None => break,
            };
        }
    }
    Ok((bits, restricted))
}

fn parse_bound(raw: &str, spec: &FieldSpec, part: &str) -> Result<u32, String> {
    let value: u32 = raw
        .trim()
        .parse()
        .map_err(|_| format!("cron 的{}字段不是数字：{part}", spec.label))?;
    if value < spec.min || value > spec.max {
        return Err(format!(
            "cron 的{}字段超出范围（{}..={}）：{part}",
            spec.label, spec.min, spec.max
        ));
    }
    Ok(value)
}

/// 解析五字段 cron 表达式。错误是给人看的中文。
pub fn parse(expr: &str) -> Result<Schedule, String> {
    let fields: Vec<&str> = expr.split_whitespace().collect();
    if fields.len() != 5 {
        return Err(format!(
            "cron 表达式必须是五字段（分 时 日 月 周），收到 {} 段：{expr}",
            fields.len()
        ));
    }
    let specs = [
        FieldSpec { label: "分钟", min: 0, max: 59, fold_sunday: false },
        FieldSpec { label: "小时", min: 0, max: 23, fold_sunday: false },
        FieldSpec { label: "日", min: 1, max: 31, fold_sunday: false },
        FieldSpec { label: "月", min: 1, max: 12, fold_sunday: false },
        FieldSpec { label: "周", min: 0, max: 7, fold_sunday: true },
    ];
    let (minutes, _) = parse_field(fields[0], &specs[0])?;
    let (hours, _) = parse_field(fields[1], &specs[1])?;
    let (month_days, dom_restricted) = parse_field(fields[2], &specs[2])?;
    let (months, _) = parse_field(fields[3], &specs[3])?;
    let (weekdays, dow_restricted) = parse_field(fields[4], &specs[4])?;
    Ok(Schedule {
        minutes,
        hours: hours as u32,
        month_days: month_days as u32,
        months: months as u16,
        weekdays: weekdays as u8,
        dom_restricted,
        dow_restricted,
    })
}

/// 严格晚于 `after` 的下一触发时刻（unix 秒，秒位恒为 0）。
///
/// 逐天推进（最多往前探 5 年），命中天再按时→分升序找第一个候选。
/// 夏令时边界交给 mktime 归一化：春天拨快时不存在的时刻会被顺推到存在的时刻，
/// 秋天拨回时取第一次出现——这两个角落不做额外处理，是已知边界。
pub fn next_run(schedule: &Schedule, after: i64) -> Option<i64> {
    // 候选从下一分钟边界开始，保证严格晚于 after
    let start = after - after.rem_euclid(60) + 60;
    let mut day = local_breakdown(start)?;
    for _ in 0..(366 * 5) {
        if day_matches(schedule, &day) {
            for hour in 0..24u32 {
                if schedule.hours >> hour & 1 == 0 {
                    continue;
                }
                for minute in 0..60u32 {
                    if schedule.minutes >> minute & 1 == 0 {
                        continue;
                    }
                    let Some(ts) =
                        local_mktime(day.year, day.mon, day.mday, hour as i32, minute as i32)
                    else {
                        continue;
                    };
                    if ts >= start {
                        return Some(ts);
                    }
                }
            }
        }
        // 推进到下一个本地零点；mday+1 越界由 mktime 归一化
        day = local_breakdown(local_mktime(day.year, day.mon, day.mday + 1, 0, 0)?)?;
    }
    None
}

fn day_matches(schedule: &Schedule, day: &CTm) -> bool {
    if schedule.months >> (day.mon + 1) & 1 == 0 {
        return false;
    }
    let dom_ok = schedule.month_days >> day.mday & 1 == 1;
    let dow_ok = schedule.weekdays >> day.wday & 1 == 1;
    match (schedule.dom_restricted, schedule.dow_restricted) {
        // Vixie cron 惯例：日与周同限时取「或」
        (true, true) => dom_ok || dow_ok,
        (true, false) => dom_ok,
        (false, true) => dow_ok,
        (false, false) => true,
    }
}

/// schedule 的中文人话（CONTRACT.md §2 ScheduledTask.scheduleText）。
///
/// 只给常见模式起人话，认不出的模式原样回显表达式——不硬翻，翻错比不翻更糟。
pub fn schedule_text(schedule: &Schedule, raw: &str) -> String {
    if let Some(text) = fixed_time_text(schedule) {
        return text;
    }
    if schedule.hours == (1 << 24) - 1
        && schedule.month_days == u32::MAX - 1
        && schedule.months == (1 << 13) - 2
        && schedule.weekdays == 0x7f
    {
        if let Some(n) = step_period(schedule.minutes, 59) {
            return format!("每 {n} 分钟");
        }
    }
    format!("按 cron「{}」", raw.trim())
}

/// 「固定时刻」模式：分钟与小时各只有一个值。
fn fixed_time_text(schedule: &Schedule) -> Option<String> {
    let minute = single_bit(schedule.minutes)?;
    let hour = single_bit(schedule.hours as u64)?;
    let time = format!("{hour:02}:{minute:02}");
    let full_days = u32::MAX - 1; // 位 1..=31 全置
    let full_months = (1u16 << 13) - 2; // 位 1..=12 全置
    let full_weeks = 0x7f;
    if schedule.months != full_months {
        return None;
    }
    if schedule.month_days == full_days && schedule.weekdays == full_weeks {
        return Some(format!("每天 {time}"));
    }
    if schedule.month_days == full_days {
        // 只看周
        if schedule.weekdays == 0b0111110 {
            return Some(format!("每工作日 {time}"));
        }
        if let Some(day) = single_bit(schedule.weekdays as u64) {
            return Some(format!("每{} {time}", weekday_name(day as u32)));
        }
        return None;
    }
    if schedule.weekdays == full_weeks {
        if let Some(day) = single_bit(schedule.month_days as u64) {
            return Some(format!("每月 {day} 日 {time}"));
        }
    }
    None
}

fn weekday_name(day: u32) -> &'static str {
    match day {
        0 => "周日",
        1 => "周一",
        2 => "周二",
        3 => "周三",
        4 => "周四",
        5 => "周五",
        _ => "周六",
    }
}

/// 位图里只有一个置位时返回它的位置。
fn single_bit(bits: u64) -> Option<u32> {
    if bits != 0 && bits.is_power_of_two() {
        Some(bits.trailing_zeros())
    } else {
        None
    }
}

/// 位图是否恰好是 `*/n`（从 0 开始、步长 n>1、铺满到 max）。是则返回 n。
fn step_period(bits: u64, max: u32) -> Option<u32> {
    for n in 2..=max {
        let mut expect: u64 = 0;
        let mut value = 0;
        while value <= max {
            expect |= 1u64 << value;
            value += n;
        }
        if bits == expect {
            return Some(n);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个本地时刻的 unix 秒。
    fn at(year: i32, mon: i32, mday: i32, hour: i32, min: i32) -> i64 {
        local_mktime(year - 1900, mon - 1, mday, hour, min).unwrap()
    }

    /// 取 unix 秒的本地分解字段（年, 月, 日, 时, 分, 周）。
    fn fields(ts: i64) -> (i32, i32, i32, i32, i32, i32) {
        let tm = local_breakdown(ts).unwrap();
        (tm.year + 1900, tm.mon + 1, tm.mday, tm.hour, tm.min, tm.wday)
    }

    #[test]
    fn rejects_malformed_expressions() {
        assert!(parse("* * * *").unwrap_err().contains("五字段"));
        assert!(parse("* * * * * *").unwrap_err().contains("五字段"));
        assert!(parse("60 * * * *").unwrap_err().contains("分钟"));
        assert!(parse("* 24 * * *").unwrap_err().contains("小时"));
        assert!(parse("* * 0 * *").unwrap_err().contains("日"));
        assert!(parse("* * * 13 *").unwrap_err().contains("月"));
        assert!(parse("* * * * 8").unwrap_err().contains("周"));
        assert!(parse("a * * * *").unwrap_err().contains("不是数字"));
        assert!(parse("*/0 * * * *").unwrap_err().contains("步长"));
        assert!(parse("5-1 * * * *").unwrap_err().contains("范围颠倒"));
        assert!(parse("JAN * * * *").unwrap_err().contains("不是数字"));
    }

    #[test]
    fn every_fifteen_minutes() {
        let schedule = parse("*/15 * * * *").unwrap();
        let next = next_run(&schedule, at(2026, 8, 26, 10, 7)).unwrap();
        assert_eq!(fields(next), (2026, 8, 26, 10, 15, fields(next).5));
        // 整点边界：10:45 之后是 11:00
        let next = next_run(&schedule, at(2026, 8, 26, 10, 45)).unwrap();
        let (y, mo, d, h, mi, _) = fields(next);
        assert_eq!((y, mo, d, h, mi), (2026, 8, 26, 11, 0));
    }

    #[test]
    fn fixed_time_is_strictly_after_and_crosses_midnight() {
        let schedule = parse("30 9 * * *").unwrap();
        // 恰好 09:30 不算，要下一天的 09:30
        let after = at(2026, 8, 26, 9, 30);
        let next = next_run(&schedule, after).unwrap();
        assert!(next > after);
        let (y, mo, d, h, mi, _) = fields(next);
        assert_eq!((y, mo, d, h, mi), (2026, 8, 27, 9, 30));
        // 跨日：23:59 之后是次日 09:30
        let next = next_run(&schedule, at(2026, 8, 26, 23, 59)).unwrap();
        let (y, mo, d, h, mi, _) = fields(next);
        assert_eq!((y, mo, d, h, mi), (2026, 8, 27, 9, 30));
        // 09:29 之后是当天 09:30
        let next = next_run(&schedule, at(2026, 8, 26, 9, 29)).unwrap();
        let (y, mo, d, h, mi, _) = fields(next);
        assert_eq!((y, mo, d, h, mi), (2026, 8, 26, 9, 30));
    }

    #[test]
    fn crosses_month_boundary() {
        let schedule = parse("0 0 1 * *").unwrap();
        let next = next_run(&schedule, at(2026, 1, 15, 12, 0)).unwrap();
        let (y, mo, d, h, mi, _) = fields(next);
        assert_eq!((y, mo, d, h, mi), (2026, 2, 1, 0, 0));
        // 已经在 2 月 1 日 00:00 时，下一个是 3 月 1 日
        let next = next_run(&schedule, at(2026, 2, 1, 0, 0)).unwrap();
        let (y, mo, d, h, mi, _) = fields(next);
        assert_eq!((y, mo, d, h, mi), (2026, 3, 1, 0, 0));
    }

    #[test]
    fn sunday_is_both_0_and_7() {
        let by_zero = parse("0 12 * * 0").unwrap();
        let by_seven = parse("0 12 * * 7").unwrap();
        let after = at(2026, 8, 26, 9, 0);
        let next_zero = next_run(&by_zero, after).unwrap();
        let next_seven = next_run(&by_seven, after).unwrap();
        assert_eq!(next_zero, next_seven);
        assert_eq!(fields(next_zero).5, 0, "下一次触发应该落在周日");
    }

    #[test]
    fn weekday_range_hits_monday_to_friday() {
        let schedule = parse("0 8 * * 1-5").unwrap();
        // 2026-08-28 是周五（26 日是周三，往后推两天）
        assert_eq!(fields(at(2026, 8, 28, 12, 0)).5, 5);
        let next = next_run(&schedule, at(2026, 8, 28, 12, 0)).unwrap();
        // 周五 12:00 之后，下一个工作日 08:00 是周一 8 月 31 日
        let (y, mo, d, h, mi, wday) = fields(next);
        assert_eq!((y, mo, d, h, mi), (2026, 8, 31, 8, 0));
        assert_eq!(wday, 1);
    }

    #[test]
    fn dom_and_dow_combine_with_or() {
        // 每月 13 日或逢周五都触发
        let schedule = parse("0 0 13 * 5").unwrap();
        // 2026-08-13 是周四，下一天 8-14 是周五
        assert_eq!(fields(at(2026, 8, 14, 0, 0)).5, 5);
        let next = next_run(&schedule, at(2026, 8, 13, 12, 0)).unwrap();
        let (y, mo, d, h, mi, _) = fields(next);
        assert_eq!((y, mo, d, h, mi), (2026, 8, 14, 0, 0));
    }

    #[test]
    fn range_with_step_is_accepted() {
        let schedule = parse("0 9-18/3 * * *").unwrap();
        let next = next_run(&schedule, at(2026, 8, 26, 10, 0)).unwrap();
        let (_, _, _, h, mi, _) = fields(next);
        assert_eq!((h, mi), (12, 0));
    }

    #[test]
    fn schedule_text_covers_common_patterns() {
        assert_eq!(schedule_text(&parse("30 9 * * *").unwrap(), "30 9 * * *"), "每天 09:30");
        assert_eq!(
            schedule_text(&parse("0 9 * * 1-5").unwrap(), "0 9 * * 1-5"),
            "每工作日 09:00"
        );
        assert_eq!(
            schedule_text(&parse("0 8 * * 0").unwrap(), "0 8 * * 0"),
            "每周日 08:00"
        );
        assert_eq!(
            schedule_text(&parse("0 0 1 * *").unwrap(), "0 0 1 * *"),
            "每月 1 日 00:00"
        );
        assert_eq!(
            schedule_text(&parse("*/15 * * * *").unwrap(), "*/15 * * * *"),
            "每 15 分钟"
        );
        // 认不出的模式回显原文
        assert_eq!(
            schedule_text(&parse("0 9 1 3 *").unwrap(), "0 9 1 3 *"),
            "按 cron「0 9 1 3 *」"
        );
    }

    #[test]
    fn huge_step_does_not_overflow_or_wrap() {
        // step 只校验 >=1，u32::MAX 是合法步长：溢出在 debug 构建 panic 卡死 IPC
        // 线程，release 回绕成错误位图。溢出即停：只置位起始值本身。
        let schedule = parse("5/4294967295 * * * *").unwrap();
        let next = next_run(&schedule, at(2026, 8, 26, 9, 0)).unwrap();
        let (_, _, _, _, mi, _) = fields(next);
        assert_eq!(mi, 5, "只在第 5 分触发，不得回绕出 00-05 的错误位图");
    }
}
