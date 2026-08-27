//! 用量 / 错误流水的流式读取与聚合。
//!
//! 三条硬约束：
//! 1. 逐行读，绝不把 jsonl 整体载入内存；
//! 2. 单行解析失败只跳过并计数，一行坏数据不能毁掉整个视图（AGENTS.md：默认放行）；
//! 3. 聚合在 Rust 侧算完再给前端，避免在 JS 里遍历十万行。
//!
//! 成本：优先读 `model-pricing.json` 的 `models`；为空则回退到 CC Switch DB 的
//! `model_pricing` 表；都没有才不给 `estimatedCostUsd`。绝不用估算值冒充真实成本。

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::error;
use crate::paths;
use crate::redact;

/// 从文件末尾往前读时一次读多少字节。
const TAIL_CHUNK: u64 = 64 * 1024;

/// 分桶数量上限，超了就让调用方收窄时间范围而不是硬算。
const MAX_BUCKETS: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Granularity {
    Hour,
    Day,
}

impl Granularity {
    pub fn parse(raw: &str) -> Result<Self, String> {
        match raw.trim() {
            "hour" => Ok(Self::Hour),
            "day" => Ok(Self::Day),
            other => Err(format!("granularity 只能是 hour 或 day，收到：{other}")),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hour => "hour",
            Self::Day => "day",
        }
    }

    fn step_seconds(self) -> i64 {
        match self {
            Self::Hour => 3_600,
            Self::Day => 86_400,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRow {
    pub ts: i64,
    pub channel: String,
    pub model: String,
    pub format: String,
    pub source: String,
    #[serde(rename = "in")]
    pub input: Option<i64>,
    #[serde(rename = "out")]
    pub output: Option<i64>,
    pub cr: Option<i64>,
    pub cw: Option<i64>,
    pub hub: Option<String>,
    pub account: Option<String>,
    pub deg: Vec<String>,
    pub cache_creation: Option<BTreeMap<String, i64>>,
    pub server_tool_use: Option<BTreeMap<String, i64>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorRow {
    pub ts: i64,
    pub phase: String,
    pub channel: Option<String>,
    pub model: Option<String>,
    pub format: Option<String>,
    pub status: Option<i64>,
    pub code: Option<String>,
    pub message: Option<String>,
    pub exc: Option<String>,
    pub route: Option<String>,
    pub deg: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Totals {
    #[serde(rename = "in")]
    pub input: i64,
    #[serde(rename = "out")]
    pub output: i64,
    pub cr: i64,
    pub cw: i64,
    pub turns: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SeriesPoint {
    pub t: i64,
    #[serde(rename = "in")]
    pub input: i64,
    #[serde(rename = "out")]
    pub output: i64,
    pub cr: i64,
    pub turns: i64,
    /// 该桶的估算成本。桶内任一模型无价时断点，不补 0。
    pub cost: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBucket {
    pub key: String,
    #[serde(rename = "in")]
    pub input: i64,
    #[serde(rename = "out")]
    pub output: i64,
    pub cr: i64,
    pub cw: i64,
    pub turns: i64,
    pub cache_hit_rate: Option<f64>,
    pub degraded_turns: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct DegradeCount {
    pub code: String,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub window_from: i64,
    pub window_to: i64,
    pub totals: Totals,
    pub cache_hit_rate: Option<f64>,
    pub by_channel: Vec<UsageBucket>,
    pub by_model: Vec<UsageBucket>,
    pub series: Vec<SeriesPoint>,
    pub granularity: &'static str,
    pub degrade_counts: Vec<DegradeCount>,
    pub estimated_cost_usd: Option<f64>,
    /// 成本数据来源：`pricing-file` / `cc-switch-db` / None。前端据此写口径说明。
    pub cost_source: Option<String>,
}

// ---------------------------------------------------------------------------
// 本地时区分桶（本文件唯一的平台相关层）
//
// 与 cron.rs 同一套模式：Windows 用 UCRT 的 _localtime64_s（UCRT 没有 POSIX 的
// localtime_r，struct tm 也只有 9 个 int，没有 macOS libSystem 布局尾部的
// tm_gmtoff / tm_zone），其它平台（macOS / Linux）用 libc 的 localtime_r。
// 只读 hour/min/sec 三个字段，其余成员只为对上 struct tm 内存布局。
// ---------------------------------------------------------------------------

#[cfg(target_os = "windows")]
mod local_time {
    // UCRT 的 struct tm 布局：9 个 int（cron.rs 的 Windows 分支是同一份）。
    #[allow(dead_code)]
    #[repr(C)]
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
    }

    extern "C" {
        fn _localtime64_s(result: *mut CTm, clock: *const i64) -> i32;
    }

    /// 取某个时刻的本地 时/分/秒。errno_t：0 为成功，非 0 时 out 不可用。
    pub fn local_hms(ts: i64) -> Option<(i64, i64, i64)> {
        let clock: i64 = ts;
        let mut out = CTm {
            sec: 0,
            min: 0,
            hour: 0,
            mday: 0,
            mon: 0,
            year: 0,
            wday: 0,
            yday: 0,
            isdst: 0,
        };
        if unsafe { _localtime64_s(&mut out, &clock) } != 0 {
            return None;
        }
        Some((out.hour as i64, out.min as i64, out.sec as i64))
    }
}

#[cfg(not(target_os = "windows"))]
mod local_time {
    // libSystem / glibc 的 struct tm 布局。
    #[allow(dead_code)]
    #[repr(C)]
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

    extern "C" {
        fn localtime_r(clock: *const i64, result: *mut CTm) -> *mut CTm;
    }

    /// 取某个时刻的本地 时/分/秒。
    pub fn local_hms(ts: i64) -> Option<(i64, i64, i64)> {
        let clock: i64 = ts;
        let mut out = CTm {
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
        };
        let result = unsafe { localtime_r(&clock as *const i64, &mut out as *mut CTm) };
        if result.is_null() {
            return None;
        }
        Some((out.hour as i64, out.min as i64, out.sec as i64))
    }
}

use local_time::local_hms;

/// 桶起点：小时桶对齐到本地整点，天桶对齐到本地零点。
///
/// 用「减掉本地已经过去的秒数」这种算法，半小时时区与夏令时切换日都是对的。
pub fn bucket_start(ts: i64, granularity: Granularity) -> i64 {
    match local_hms(ts) {
        Some((hour, minute, second)) => match granularity {
            Granularity::Hour => ts - (minute * 60 + second),
            Granularity::Day => ts - (hour * 3_600 + minute * 60 + second),
        },
        // 拿不到本地时区只影响桶边界落在哪儿，数值一个都不变。
        None => match granularity {
            Granularity::Hour => ts - ts.rem_euclid(3_600),
            Granularity::Day => ts - ts.rem_euclid(86_400),
        },
    }
}

fn next_bucket(current: i64, granularity: Granularity) -> i64 {
    let step = granularity.step_seconds();
    let mut next = bucket_start(current + step, granularity);
    if next <= current {
        // 夏令时导致这一天有 25 小时时，加一步还落在同一个桶里。
        next = bucket_start(current + step + 7_200, granularity);
    }
    if next <= current {
        next = current + step;
    }
    next
}

// ---------------------------------------------------------------------------
// 逐行解析
// ---------------------------------------------------------------------------

/// 一次扫描的成绩单：解析成功多少行、跳过多少行坏数据。
#[derive(Debug, Clone, Copy, Default)]
pub struct ScanReport {
    pub parsed: u64,
    pub skipped: u64,
}

fn as_int(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    if let Some(number) = value.as_i64() {
        return Some(number);
    }
    value.as_f64().map(|number| number as i64)
}

fn as_text(value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

fn as_codes(value: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(items)) = value else {
        return Vec::new();
    };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        if let Some(code) = item.as_str() {
            let code = code.trim();
            if !code.is_empty() && !out.iter().any(|seen| seen == code) {
                out.push(code.to_string());
            }
        }
    }
    out
}

fn as_counter(value: Option<&Value>) -> Option<BTreeMap<String, i64>> {
    let Some(Value::Object(fields)) = value else {
        return None;
    };
    let mut out = BTreeMap::new();
    for (key, item) in fields {
        if let Some(number) = as_int(Some(item)) {
            out.insert(key.clone(), number);
        }
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

fn parse_object_line(line: &str) -> Option<Map<String, Value>> {
    let text = line.trim();
    if text.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// 解析一行用量流水。字段名照 journal 实际写法（`in`/`out`/`cr`/`cw`/`deg`）。
pub fn parse_usage_line(line: &str) -> Option<UsageRow> {
    let row = parse_object_line(line)?;
    let ts = as_int(row.get("ts"))?;
    Some(UsageRow {
        ts,
        channel: as_text(row.get("channel")).unwrap_or_default(),
        model: as_text(row.get("model")).unwrap_or_default(),
        format: as_text(row.get("format")).unwrap_or_default(),
        // hub 写 source 时可能是 null（本机现有流水里过半如此）。写空串表示「没记」，
        // 不编一个 "unknown" 之类的假来源。
        source: as_text(row.get("source")).unwrap_or_default(),
        input: as_int(row.get("in")),
        output: as_int(row.get("out")),
        cr: as_int(row.get("cr")),
        cw: as_int(row.get("cw")),
        hub: as_text(row.get("hub")),
        account: as_text(row.get("account")),
        deg: as_codes(row.get("deg")),
        cache_creation: as_counter(row.get("cache_creation")),
        server_tool_use: as_counter(row.get("server_tool_use")),
    })
}

/// 解析一行错误流水。字段名就是 `exc` 与 `format`，不是 exception / api_format。
pub fn parse_error_line(line: &str) -> Option<ErrorRow> {
    let row = parse_object_line(line)?;
    let ts = as_int(row.get("ts"))?;
    Some(ErrorRow {
        ts,
        phase: as_text(row.get("phase")).unwrap_or_default(),
        channel: as_text(row.get("channel")),
        model: as_text(row.get("model")),
        format: as_text(row.get("format")),
        status: as_int(row.get("status")),
        code: as_text(row.get("code")),
        // Python 侧已经脱敏过一次，这里再过一次，凭证边界只允许多剥不允许漏。
        message: redact::redact_opt(as_text(row.get("message")).as_deref()),
        exc: as_text(row.get("exc")),
        route: as_text(row.get("route")),
        deg: as_codes(row.get("deg")),
    })
}

// ---------------------------------------------------------------------------
// 文件枚举与读取
// ---------------------------------------------------------------------------

/// 一个 journal 的全部分片：主文件 + 同目录的 `.bak-*` 轮转文件（新的在前）。
pub fn journal_files(primary: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = Vec::new();
    if primary.is_file() {
        files.push(primary.to_path_buf());
    }
    let Some(dir) = primary.parent() else {
        return files;
    };
    let Some(stem) = primary.file_name().and_then(|name| name.to_str()) else {
        return files;
    };
    let prefix = format!("{stem}.bak-");
    let Ok(entries) = std::fs::read_dir(dir) else {
        return files;
    };
    let mut backups: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if name.starts_with(&prefix) {
            backups.push(path);
        }
    }
    // 名字里是时间戳，倒序即新的在前。
    backups.sort();
    backups.reverse();
    files.extend(backups);
    files
}

/// 顺序流式遍历一个文件的每一行。
fn for_each_line<F>(path: &Path, mut visit: F) -> Result<(), String>
where
    F: FnMut(&str),
{
    let file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(error::io_error("读取 ", path, &err)),
    };
    let mut reader = BufReader::new(file);
    let mut raw: Vec<u8> = Vec::new();
    loop {
        raw.clear();
        let read = reader
            .read_until(b'\n', &mut raw)
            .map_err(|err| error::io_error("读取 ", path, &err))?;
        if read == 0 {
            break;
        }
        // 用 lossy 解码：非 UTF-8 的一行也照样交给调用方，由 JSON 解析判它是坏行，
        // 而不是让整个文件读到一半就断掉。
        let line = String::from_utf8_lossy(&raw);
        visit(line.trim_end_matches(['\n', '\r']));
    }
    Ok(())
}

/// 从文件末尾往前取最多 `limit` 行非空文本，新的在前。
fn tail_lines(path: &Path, limit: usize) -> Result<Vec<String>, String> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(error::io_error("读取 ", path, &err)),
    };
    let total = file
        .metadata()
        .map_err(|err| error::io_error("读取 ", path, &err))?
        .len();
    let mut pos = total;
    let mut buf: Vec<u8> = Vec::new();
    while pos > 0 {
        let take = TAIL_CHUNK.min(pos);
        pos -= take;
        let mut chunk = vec![0u8; take as usize];
        file.seek(SeekFrom::Start(pos))
            .map_err(|err| error::io_error("定位 ", path, &err))?;
        file.read_exact(&mut chunk)
            .map_err(|err| error::io_error("读取 ", path, &err))?;
        chunk.extend_from_slice(&buf);
        buf = chunk;
        if complete_line_count(&buf, pos == 0) >= limit {
            break;
        }
    }
    let mut segments: Vec<&[u8]> = buf.split(|byte| *byte == b'\n').collect();
    if pos > 0 && !segments.is_empty() {
        // 第一段可能被 chunk 边界切断，丢掉它。
        segments.remove(0);
    }
    let mut out: Vec<String> = Vec::new();
    for segment in segments.iter().rev() {
        let text = String::from_utf8_lossy(segment).trim().to_string();
        if text.is_empty() {
            continue;
        }
        out.push(text);
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

fn complete_line_count(buf: &[u8], at_start: bool) -> usize {
    let mut segments: Vec<&[u8]> = buf.split(|byte| *byte == b'\n').collect();
    if !at_start && !segments.is_empty() {
        segments.remove(0);
    }
    segments
        .iter()
        .filter(|segment| !String::from_utf8_lossy(segment).trim().is_empty())
        .count()
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/// 扫描一个 journal 的全部行，返回解析成功的行与坏行计数。
pub fn scan_usage(files: &[PathBuf]) -> Result<(Vec<UsageRow>, ScanReport), String> {
    let mut rows: Vec<UsageRow> = Vec::new();
    let mut report = ScanReport::default();
    for file in files {
        for_each_line(file, |line| {
            if line.trim().is_empty() {
                return;
            }
            match parse_usage_line(line) {
                Some(row) => {
                    report.parsed += 1;
                    rows.push(row);
                }
                None => report.skipped += 1,
            }
        })?;
    }
    Ok((rows, report))
}

/// 只统计坏行数量，不保留行本身（体检用，避免为了计数把整个文件留在内存里）。
pub fn count_usage_lines(files: &[PathBuf]) -> Result<ScanReport, String> {
    let mut report = ScanReport::default();
    for file in files {
        for_each_line(file, |line| {
            if line.trim().is_empty() {
                return;
            }
            if parse_usage_line(line).is_some() {
                report.parsed += 1;
            } else {
                report.skipped += 1;
            }
        })?;
    }
    Ok(report)
}

/// 倒序最近 N 行用量。
pub fn recent_usage(files: &[PathBuf], limit: usize) -> Result<Vec<UsageRow>, String> {
    let mut out: Vec<UsageRow> = Vec::new();
    for file in files {
        if out.len() >= limit {
            break;
        }
        for line in tail_lines(file, limit - out.len())? {
            if let Some(row) = parse_usage_line(&line) {
                out.push(row);
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
    Ok(out)
}

/// 倒序最近 N 条错误。
pub fn recent_errors(limit: usize) -> Result<Vec<ErrorRow>, String> {
    let primary = paths::default_errors_journal()?;
    let files = journal_files(&primary);
    let mut out: Vec<ErrorRow> = Vec::new();
    for file in &files {
        if out.len() >= limit {
            break;
        }
        for line in tail_lines(file, limit - out.len())? {
            if let Some(row) = parse_error_line(&line) {
                out.push(row);
                if out.len() >= limit {
                    break;
                }
            }
        }
    }
    Ok(out)
}

struct Accumulator {
    input: i64,
    output: i64,
    cr: i64,
    cw: i64,
    turns: i64,
    degraded_turns: i64,
    /// 该聚合范围内的估算成本；任一模型无价时置为 None。
    cost: Option<f64>,
}

impl Accumulator {
    fn new() -> Self {
        Self {
            input: 0,
            output: 0,
            cr: 0,
            cw: 0,
            turns: 0,
            degraded_turns: 0,
            cost: Some(0.0),
        }
    }

    fn add(&mut self, row: &UsageRow, price_table: &PriceTable) {
        self.input += row.input.unwrap_or(0);
        self.output += row.output.unwrap_or(0);
        self.cr += row.cr.unwrap_or(0);
        self.cw += row.cw.unwrap_or(0);
        self.turns += 1;
        if !row.deg.is_empty() {
            self.degraded_turns += 1;
        }

        // 只要之前已经发现无价模型，这个桶的成本就永久断点。
        if self.cost.is_none() {
            return;
        }
        let Some(price) = price_table.get(&row.model.to_lowercase()) else {
            self.cost = None;
            return;
        };
        let mut add = 0.0f64;
        add += row.input.unwrap_or(0) as f64 * price.input / 1_000_000.0;
        add += row.output.unwrap_or(0) as f64 * price.output / 1_000_000.0;
        add += row.cr.unwrap_or(0) as f64 * price.cache_read / 1_000_000.0;
        add += row.cw.unwrap_or(0) as f64 * price.cache_write / 1_000_000.0;
        self.cost = Some(self.cost.unwrap_or(0.0) + add);
    }

    fn into_bucket(self, key: String) -> UsageBucket {
        UsageBucket {
            key,
            input: self.input,
            output: self.output,
            cr: self.cr,
            cw: self.cw,
            turns: self.turns,
            cache_hit_rate: cache_hit_rate(self.input, self.cr),
            degraded_turns: self.degraded_turns,
        }
    }

    fn weight(&self) -> i64 {
        self.input + self.output + self.cr + self.cw
    }
}

/// 缓存命中率 = cr / (in + cr)，无输入时为 `None`（绝不写 0 冒充「没命中」）。
pub fn cache_hit_rate(input: i64, cr: i64) -> Option<f64> {
    let denominator = input + cr;
    if denominator <= 0 {
        return None;
    }
    Some(cr as f64 / denominator as f64)
}

/// 把一批行聚合成 `UsageSummary`。成本按 `price_table` 逐桶累加；
/// 桶内任一模型无价时该桶 `cost` 为 `None`。总成本仍由 `apply_pricing` 决定。
pub fn summarize_rows(
    rows: &[UsageRow],
    from_ts: i64,
    to_ts: i64,
    granularity: Granularity,
    price_table: &PriceTable,
) -> Result<UsageSummary, String> {
    let (from_ts, to_ts) = if from_ts <= to_ts {
        (from_ts, to_ts)
    } else {
        (to_ts, from_ts)
    };
    let mut totals = Accumulator::new();
    let mut by_channel: BTreeMap<String, Accumulator> = BTreeMap::new();
    let mut by_model: BTreeMap<String, Accumulator> = BTreeMap::new();
    let mut buckets: BTreeMap<i64, Accumulator> = BTreeMap::new();
    let mut degrades: BTreeMap<String, i64> = BTreeMap::new();

    for row in rows {
        if row.ts < from_ts || row.ts > to_ts {
            continue;
        }
        totals.add(row, price_table);
        by_channel
            .entry(display_key(&row.channel))
            .or_insert_with(Accumulator::new)
            .add(row, price_table);
        by_model
            .entry(display_key(&row.model))
            .or_insert_with(Accumulator::new)
            .add(row, price_table);
        buckets
            .entry(bucket_start(row.ts, granularity))
            .or_insert_with(Accumulator::new)
            .add(row, price_table);
        for code in &row.deg {
            *degrades.entry(code.clone()).or_insert(0) += 1;
        }
    }

    let mut series: Vec<SeriesPoint> = Vec::new();
    let first = bucket_start(from_ts, granularity);
    let last = bucket_start(to_ts, granularity);
    let mut cursor = first;
    loop {
        let point = buckets.get(&cursor);
        series.push(SeriesPoint {
            t: cursor,
            input: point.map(|bucket| bucket.input).unwrap_or(0),
            output: point.map(|bucket| bucket.output).unwrap_or(0),
            cr: point.map(|bucket| bucket.cr).unwrap_or(0),
            turns: point.map(|bucket| bucket.turns).unwrap_or(0),
            cost: point.and_then(|bucket| bucket.cost),
        });
        if cursor >= last {
            break;
        }
        if series.len() >= MAX_BUCKETS {
            return Err(format!(
                "时间范围太大：按 {} 分桶会超过 {} 个桶，请把范围收窄",
                granularity.as_str(),
                MAX_BUCKETS
            ));
        }
        cursor = next_bucket(cursor, granularity);
    }

    let mut degrade_counts: Vec<DegradeCount> = degrades
        .into_iter()
        .map(|(code, count)| DegradeCount { code, count })
        .collect();
    degrade_counts.sort_by(|left, right| {
        right
            .count
            .cmp(&left.count)
            .then_with(|| left.code.cmp(&right.code))
    });

    Ok(UsageSummary {
        window_from: from_ts,
        window_to: to_ts,
        cache_hit_rate: cache_hit_rate(totals.input, totals.cr),
        by_channel: sorted_buckets(by_channel),
        by_model: sorted_buckets(by_model),
        series,
        granularity: granularity.as_str(),
        degrade_counts,
        estimated_cost_usd: None,
        cost_source: None,
        totals: Totals {
            input: totals.input,
            output: totals.output,
            cr: totals.cr,
            cw: totals.cw,
            turns: totals.turns,
        },
    })
}

/// 空的渠道名/模型名在界面上要能读，不留空白单元格。
fn display_key(raw: &str) -> String {
    if raw.trim().is_empty() {
        "（流水未记录）".to_string()
    } else {
        raw.to_string()
    }
}

fn sorted_buckets(map: BTreeMap<String, Accumulator>) -> Vec<UsageBucket> {
    let mut entries: Vec<(String, Accumulator)> = map.into_iter().collect();
    entries.sort_by(|left, right| {
        right
            .1
            .weight()
            .cmp(&left.1.weight())
            .then_with(|| left.0.cmp(&right.0))
    });
    entries
        .into_iter()
        .map(|(key, accumulator)| accumulator.into_bucket(key))
        .collect()
}

// ---------------------------------------------------------------------------
// 成本
// ---------------------------------------------------------------------------

/// 一个模型的单价，单位是「美元 / 百万 token」。
#[derive(Debug, Clone, Copy)]
pub struct ModelPrice {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

/// 价格表。键是模型 id，全部小写。
pub type PriceTable = BTreeMap<String, ModelPrice>;

/// 读价格表。
///
/// 只认这一种形状（cc-switch 的 model-pricing.json 结构）：
/// `{"models": [{"id": "<model>", "cost": {"input": 3, "output": 15,
///   "cache_read": 0.3, "cache_write": 3.75}}]}`。
/// 形状不符或缺字段的条目直接不收录——收录一半会让成本变成猜的。
pub fn load_price_table() -> Result<PriceTable, String> {
    let path = paths::pricing_path()?;
    let Some(root) = paths::read_json_object(&path)? else {
        return Ok(PriceTable::new());
    };
    let Some(Value::Array(models)) = root.get("models") else {
        return Ok(PriceTable::new());
    };
    let mut table = PriceTable::new();
    for model in models {
        let Value::Object(entry) = model else {
            continue;
        };
        let Some(id) = entry
            .get("id")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let Some(Value::Object(cost)) = entry.get("cost") else {
            continue;
        };
        let read = |key: &str| cost.get(key).and_then(|value| value.as_f64());
        let (Some(input), Some(output), Some(cache_read), Some(cache_write)) = (
            read("input"),
            read("output"),
            read("cache_read"),
            read("cache_write"),
        ) else {
            continue;
        };
        table.insert(
            id.to_lowercase(),
            ModelPrice {
                input,
                output,
                cache_read,
                cache_write,
            },
        );
    }
    Ok(table)
}

/// 按 `by_model` 逐个模型定价。任何一个模型定不出价，整体就返回 `null`。
pub fn apply_pricing(summary: &mut UsageSummary, table: &PriceTable) {
    if table.is_empty() || summary.by_model.is_empty() {
        summary.estimated_cost_usd = None;
        return;
    }
    let mut total = 0.0f64;
    for bucket in &summary.by_model {
        let Some(price) = table.get(&bucket.key.to_lowercase()) else {
            summary.estimated_cost_usd = None;
            return;
        };
        total += bucket.input as f64 * price.input / 1_000_000.0;
        total += bucket.output as f64 * price.output / 1_000_000.0;
        total += bucket.cr as f64 * price.cache_read / 1_000_000.0;
        total += bucket.cw as f64 * price.cache_write / 1_000_000.0;
    }
    summary.estimated_cost_usd = Some(total);
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE_A: &str = r#"{"ts": 1787102022, "channel": "direct", "model": "claude-opus-5", "format": "anthropic", "source": "upstream", "in": 100, "out": 10, "cr": 60, "cw": 5, "cache_creation": {"ephemeral_1h_input_tokens": 5}, "account": "id:abc", "deg": ["HUB_DEGRADE_SYSTEM_ROLE_PROMOTED"]}"#;
    const LINE_B: &str = r#"{"ts": 1787102122, "channel": "glm", "model": "glm-5.2", "format": "openai_chat", "source": null, "in": 200, "out": 20}"#;

    #[test]
    fn parses_the_real_field_names() {
        let row = parse_usage_line(LINE_A).unwrap();
        assert_eq!(row.channel, "direct");
        assert_eq!(row.input, Some(100));
        assert_eq!(row.cr, Some(60));
        assert_eq!(
            row.deg,
            vec!["HUB_DEGRADE_SYSTEM_ROLE_PROMOTED".to_string()]
        );
        assert_eq!(row.account.as_deref(), Some("id:abc"));
        assert_eq!(
            row.cache_creation.as_ref().unwrap()["ephemeral_1h_input_tokens"],
            5
        );
    }

    #[test]
    fn null_source_becomes_empty_not_a_fake_label() {
        let row = parse_usage_line(LINE_B).unwrap();
        assert_eq!(row.source, "");
        assert_eq!(row.cr, None);
    }

    #[test]
    fn broken_lines_are_skipped_without_killing_the_scan() {
        assert!(parse_usage_line("{ not json").is_none());
        assert!(parse_usage_line("[]").is_none());
        assert!(parse_usage_line(r#"{"channel":"x"}"#).is_none());
        assert!(parse_usage_line("").is_none());
    }

    #[test]
    fn error_message_is_redacted_again_before_leaving_rust() {
        let line = r#"{"ts": 1, "phase": "response", "status": 401, "exc": "HttpError", "message": "invalid key sk-abcdefghijklmnopqrstuvwxyz012345"}"#; // secret-guard: allow openai-key（字母表拼成的合成 key，仅用于测试脱敏）
        let row = parse_error_line(line).unwrap();
        let message = row.message.unwrap();
        assert!(!message.contains("sk-abcdefghijklmnopqrstuvwxyz012345")); // secret-guard: allow openai-key（同上，合成值）
        assert!(message.contains(redact::MASK));
        assert_eq!(row.status, Some(401));
        assert_eq!(row.exc.as_deref(), Some("HttpError"));
    }

    #[test]
    fn summary_totals_and_cache_rate() {
        let rows = vec![
            parse_usage_line(LINE_A).unwrap(),
            parse_usage_line(LINE_B).unwrap(),
        ];
        let summary = summarize_rows(&rows, 1787102000, 1787102200, Granularity::Hour, &PriceTable::new()).unwrap();
        assert_eq!(summary.totals.input, 300);
        assert_eq!(summary.totals.output, 30);
        assert_eq!(summary.totals.cr, 60);
        assert_eq!(summary.totals.turns, 2);
        assert_eq!(summary.granularity, "hour");
        // 60 / (300 + 60)
        let rate = summary.cache_hit_rate.unwrap();
        assert!((rate - 60.0 / 360.0).abs() < 1e-9);
        assert_eq!(summary.by_channel.len(), 2);
        // 权重大的排前面
        assert_eq!(summary.by_channel[0].key, "glm");
        assert_eq!(summary.degrade_counts.len(), 1);
        assert_eq!(summary.degrade_counts[0].count, 1);
        assert_eq!(summary.by_channel[1].degraded_turns, 1);
    }

    #[test]
    fn rows_outside_the_window_are_excluded() {
        let rows = vec![parse_usage_line(LINE_A).unwrap()];
        let summary = summarize_rows(&rows, 1, 100, Granularity::Day, &PriceTable::new()).unwrap();
        assert_eq!(summary.totals.turns, 0);
        assert!(summary.cache_hit_rate.is_none());
        assert!(summary.by_model.is_empty());
    }

    #[test]
    fn day_buckets_align_to_local_midnight() {
        let ts = 1787102022;
        let start = bucket_start(ts, Granularity::Day);
        assert!(start <= ts);
        assert!(ts - start < 86_400 + 3_600);
        let (hour, minute, second) = local_hms(start).unwrap();
        assert_eq!((hour, minute, second), (0, 0, 0));
    }

    #[test]
    fn series_is_zero_filled_across_the_window() {
        let rows = vec![parse_usage_line(LINE_A).unwrap()];
        let from = LINE_A_TS - 3 * 3_600;
        let summary = summarize_rows(&rows, from, LINE_A_TS, Granularity::Hour, &PriceTable::new()).unwrap();
        assert_eq!(summary.series.len(), 4);
        assert!(summary.series.windows(2).all(|pair| pair[0].t < pair[1].t));
        assert_eq!(summary.series.last().unwrap().input, 100);
        assert_eq!(summary.series[0].turns, 0);
    }

    const LINE_A_TS: i64 = 1787102022;

    #[test]
    fn cost_stays_null_when_any_model_has_no_price() {
        let rows = vec![
            parse_usage_line(LINE_A).unwrap(),
            parse_usage_line(LINE_B).unwrap(),
        ];
        let mut summary = summarize_rows(&rows, 1787102000, 1787102200, Granularity::Hour, &PriceTable::new()).unwrap();
        let mut table = PriceTable::new();
        table.insert(
            "claude-opus-5".into(),
            ModelPrice {
                input: 3.0,
                output: 15.0,
                cache_read: 0.3,
                cache_write: 3.75,
            },
        );
        apply_pricing(&mut summary, &table);
        assert!(
            summary.estimated_cost_usd.is_none(),
            "缺一个模型就不能给数字"
        );

        table.insert(
            "glm-5.2".into(),
            ModelPrice {
                input: 1.0,
                output: 2.0,
                cache_read: 0.1,
                cache_write: 1.0,
            },
        );
        apply_pricing(&mut summary, &table);
        let cost = summary.estimated_cost_usd.unwrap();
        let expected = (100.0 * 3.0 + 10.0 * 15.0 + 60.0 * 0.3 + 5.0 * 3.75) / 1e6
            + (200.0 * 1.0 + 20.0 * 2.0) / 1e6;
        assert!((cost - expected).abs() < 1e-12);
    }

    #[test]
    fn empty_price_table_means_no_cost() {
        let rows = vec![parse_usage_line(LINE_A).unwrap()];
        let mut summary = summarize_rows(&rows, 1787102000, 1787102200, Granularity::Hour, &PriceTable::new()).unwrap();
        apply_pricing(&mut summary, &PriceTable::new());
        assert!(summary.estimated_cost_usd.is_none());
    }

    #[test]
    fn series_cost_aggregates_per_bucket_and_breaks_on_missing_price() {
        let rows = vec![
            parse_usage_line(LINE_A).unwrap(),
            parse_usage_line(LINE_B).unwrap(),
        ];
        let mut table = PriceTable::new();
        table.insert(
            "claude-opus-5".into(),
            ModelPrice {
                input: 3.0,
                output: 15.0,
                cache_read: 0.3,
                cache_write: 3.75,
            },
        );
        // glm-5.2 无价，桶内任一模型无价 → 该桶 cost 断点。
        let summary = summarize_rows(&rows, 1787102000, 1787102200, Granularity::Hour, &table).unwrap();
        assert_eq!(summary.series.len(), 1);
        assert!(summary.series[0].cost.is_none());

        table.insert(
            "glm-5.2".into(),
            ModelPrice {
                input: 1.0,
                output: 2.0,
                cache_read: 0.1,
                cache_write: 1.0,
            },
        );
        let summary = summarize_rows(&rows, 1787102000, 1787102200, Granularity::Hour, &table).unwrap();
        let expected = (100.0 * 3.0 + 10.0 * 15.0 + 60.0 * 0.3 + 5.0 * 3.75) / 1e6
            + (200.0 * 1.0 + 20.0 * 2.0) / 1e6;
        assert!((summary.series[0].cost.unwrap() - expected).abs() < 1e-12);
    }

    #[test]
    fn tail_lines_returns_newest_first() {
        let dir = std::env::temp_dir().join("claude1-desktop-journal-tail");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("usage.jsonl");
        let body: String = (1..=500)
            .map(|n| format!("{{\"ts\": {n}, \"channel\": \"c\"}}\n"))
            .collect();
        std::fs::write(&path, body).unwrap();
        let rows = recent_usage(&[path], 3).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].ts, 500);
        assert_eq!(rows[2].ts, 498);
    }
}
