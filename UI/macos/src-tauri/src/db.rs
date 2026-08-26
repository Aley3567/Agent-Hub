//! CC Switch 数据库的只读访问。
//!
//! 两条不容协商的边界（README.md 安全边界）：
//! 1. 连接一律 `SQLITE_OPEN_READ_ONLY` 再叠一道 `PRAGMA query_only`，本模块不存在任何写入路径；
//! 2. 先 `PRAGMA table_info(providers)` 探测列，缺列降级为 `None` 而不是报错——
//!    CC Switch 升级 schema 时界面不能白屏（沿用 claude-provider-once.py 的 db_claude_rows 范式）。

use std::collections::BTreeSet;
use std::path::Path;

use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, Row};

use crate::error;
use crate::paths;

/// `providers` 表里一行 claude 渠道的原始值。缺列的字段为 `None`。
#[derive(Debug, Clone)]
pub struct ProviderRow {
    pub id: String,
    pub name: String,
    pub settings_config: Option<String>,
    pub meta: Option<String>,
    pub is_current: bool,
    pub in_failover_queue: bool,
    pub category: Option<String>,
    pub notes: Option<String>,
    pub icon_color: Option<String>,
    pub provider_type: Option<String>,
    pub sort_index: Option<i64>,
}

/// 只读打开数据库。文件不存在时给 CONTRACT.md 指定的那句中文。
pub fn open_readonly(path: &Path) -> Result<Connection, String> {
    if !path.is_file() {
        return Err(error::missing_db(path));
    }
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let conn = Connection::open_with_flags(path, flags)
        .map_err(|err| format!("打不开 CC Switch 数据库 {}：{}", error::tilde(path), err))?;
    // 只读连接之外再上一道保险：即使以后有人误加了 execute，也会被 SQLite 直接拒绝。
    conn.pragma_update(None, "query_only", 1)
        .map_err(|err| format!("无法把 CC Switch 数据库置为只读模式：{err}"))?;
    Ok(conn)
}

/// 探测 `providers` 表实际有哪些列。表不存在时返回空集合。
fn provider_columns(conn: &Connection) -> Result<BTreeSet<String>, String> {
    let mut stmt = conn
        .prepare("PRAGMA table_info(providers)")
        .map_err(|err| format!("无法探测 providers 表结构：{err}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|err| format!("无法探测 providers 表结构：{err}"))?;
    let mut names = BTreeSet::new();
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("无法探测 providers 表结构：{err}"))?
    {
        if let Some(name) = read_text(row, 1)? {
            names.insert(name);
        }
    }
    Ok(names)
}

/// CONTRACT.md 1.1 节的固定查询：只取 `app_type='claude'`，按 `sort_index` 排。
pub fn claude_provider_rows() -> Result<Vec<ProviderRow>, String> {
    let path = paths::db_path()?;
    let conn = open_readonly(&path)?;
    let available = provider_columns(&conn)?;
    if available.is_empty() {
        return Err(format!(
            "{} 里没有 providers 表，这不像 CC Switch 的数据库",
            error::tilde(&path)
        ));
    }
    for required in ["id", "name"] {
        if !available.contains(required) {
            return Err(format!(
                "CC Switch 数据库的 providers 表缺少 {required} 列，渠道无法标识；请升级 CC Switch"
            ));
        }
    }

    let optional = [
        "settings_config",
        "meta",
        "is_current",
        "in_failover_queue",
        "category",
        "notes",
        "icon_color",
        "provider_type",
        "sort_index",
    ];
    let mut selected: Vec<&str> = vec!["id", "name"];
    selected.extend(
        optional
            .iter()
            .copied()
            .filter(|column| available.contains(*column)),
    );
    let mut sql = format!("SELECT {} FROM providers", selected.join(", "));
    if available.contains("app_type") {
        sql.push_str(" WHERE app_type='claude'");
    }
    if available.contains("sort_index") {
        sql.push_str(" ORDER BY sort_index");
    }

    let index = |name: &str| selected.iter().position(|column| *column == name);
    let idx_settings = index("settings_config");
    let idx_meta = index("meta");
    let idx_current = index("is_current");
    let idx_failover = index("in_failover_queue");
    let idx_category = index("category");
    let idx_notes = index("notes");
    let idx_icon_color = index("icon_color");
    let idx_provider_type = index("provider_type");
    let idx_sort = index("sort_index");

    let mut stmt = conn
        .prepare(&sql)
        .map_err(|err| format!("无法查询 CC Switch 渠道：{err}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|err| format!("无法查询 CC Switch 渠道：{err}"))?;
    let mut out: Vec<ProviderRow> = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("读取 CC Switch 渠道时出错：{err}"))?
    {
        let id = read_text(row, 0)?.unwrap_or_default();
        if id.trim().is_empty() {
            // 没有稳定 id 的行无法被界面引用，也无法写本地覆盖，跳过。
            continue;
        }
        let name = read_text(row, 1)?.unwrap_or_else(|| id.clone());
        out.push(ProviderRow {
            id,
            name,
            settings_config: read_opt_text(row, idx_settings)?,
            meta: read_opt_text(row, idx_meta)?,
            is_current: read_opt_bool(row, idx_current)?,
            in_failover_queue: read_opt_bool(row, idx_failover)?,
            category: read_opt_text(row, idx_category)?,
            notes: read_opt_text(row, idx_notes)?,
            icon_color: read_opt_text(row, idx_icon_color)?,
            provider_type: read_opt_text(row, idx_provider_type)?,
            sort_index: read_opt_int(row, idx_sort)?,
        });
    }
    Ok(out)
}

/// 全表扫描：哪些 provider 的 `settings_config` 固定了子代理模型。
///
/// 体检要跨 `app_type` 报这件事，所以这里不加 `app_type` 过滤。
/// 返回 (固定了子代理模型的 (id, name)，settings_config 无效的 name)。
pub type SubagentPins = (Vec<(String, String)>, Vec<String>);

pub fn subagent_pinned_providers() -> Result<SubagentPins, String> {
    let path = paths::db_path()?;
    let conn = open_readonly(&path)?;
    let available = provider_columns(&conn)?;
    if !available.contains("settings_config") {
        return Ok((Vec::new(), Vec::new()));
    }
    let mut stmt = conn
        .prepare("SELECT id, name, settings_config FROM providers")
        .map_err(|err| format!("无法查询 providers 的 settings_config：{err}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|err| format!("无法查询 providers 的 settings_config：{err}"))?;
    let mut pinned = Vec::new();
    let mut invalid = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|err| format!("读取 providers 的 settings_config 时出错：{err}"))?
    {
        let id = read_text(row, 0)?.unwrap_or_default();
        let name = read_text(row, 1)?.unwrap_or_else(|| id.clone());
        let raw = read_text(row, 2)?.unwrap_or_default();
        if raw.trim().is_empty() {
            continue;
        }
        let parsed: Result<serde_json::Value, _> = serde_json::from_str(&raw);
        let Ok(serde_json::Value::Object(settings)) = parsed else {
            invalid.push(name);
            continue;
        };
        let has_pin = settings
            .get("env")
            .and_then(|env| env.as_object())
            .map(|env| env.contains_key(crate::channels::SUBAGENT_MODEL_KEY))
            .unwrap_or(false);
        if has_pin {
            pinned.push((id, name));
        }
    }
    Ok((pinned, invalid))
}

/// 探测某张表是否存在。表不存在不算错误——老版本 CC Switch 没有这张表。
fn table_exists(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1",
        [name],
        |_row| Ok(()),
    )
    .is_ok()
}

/// 把 pricing 表里的 TEXT 价格解析成 f64；解析失败返回 None。
fn parse_price_text(text: &str) -> Option<f64> {
    text.trim().parse::<f64>().ok()
}

/// 只读加载 CC Switch DB 的 `model_pricing` 表。
/// 表不存在或读失败时返回空表，不阻断用量视图（老版本 DB 没有这个表）。
pub fn load_model_pricing(conn: &Connection) -> crate::journal::PriceTable {
    use crate::journal::{ModelPrice, PriceTable};

    if !table_exists(conn, "model_pricing") {
        return PriceTable::new();
    }

    let sql = "\
        SELECT model_id, input_cost_per_million, output_cost_per_million, \
               cache_read_cost_per_million, cache_creation_cost_per_million \
        FROM model_pricing";
    let mut stmt = match conn.prepare(sql) {
        Ok(stmt) => stmt,
        Err(_) => return PriceTable::new(),
    };
    let rows = match stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<String>>(4)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return PriceTable::new(),
    };

    let mut table = PriceTable::new();
    for row in rows {
        let Ok((id, input, output, cache_read, cache_creation)) = row else {
            continue;
        };
        let (Some(input), Some(output)) = (parse_price_text(&input), parse_price_text(&output)) else {
            continue;
        };
        // cache 价老数据可能缺失或为 NULL，缺省按 0 处理，让有输入输出价的模型仍可估算。
        let cache_read = cache_read.as_deref().and_then(parse_price_text).unwrap_or(0.0);
        let cache_write = cache_creation.as_deref().and_then(parse_price_text).unwrap_or(0.0);
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
    table
}

fn read_text(row: &Row<'_>, idx: usize) -> Result<Option<String>, String> {
    let value = row
        .get_ref(idx)
        .map_err(|err| format!("读取 providers 第 {} 列失败：{}", idx + 1, err))?;
    Ok(match value {
        ValueRef::Null => None,
        ValueRef::Integer(number) => Some(number.to_string()),
        ValueRef::Real(number) => Some(number.to_string()),
        ValueRef::Text(bytes) => Some(String::from_utf8_lossy(bytes).into_owned()),
        ValueRef::Blob(_) => None,
    })
}

fn read_opt_text(row: &Row<'_>, idx: Option<usize>) -> Result<Option<String>, String> {
    match idx {
        Some(idx) => read_text(row, idx),
        None => Ok(None),
    }
}

fn read_opt_int(row: &Row<'_>, idx: Option<usize>) -> Result<Option<i64>, String> {
    let Some(idx) = idx else { return Ok(None) };
    let value = row
        .get_ref(idx)
        .map_err(|err| format!("读取 providers 第 {} 列失败：{}", idx + 1, err))?;
    Ok(match value {
        ValueRef::Integer(number) => Some(number),
        ValueRef::Real(number) => Some(number as i64),
        ValueRef::Text(bytes) => String::from_utf8_lossy(bytes).trim().parse::<i64>().ok(),
        _ => None,
    })
}

fn read_opt_bool(row: &Row<'_>, idx: Option<usize>) -> Result<bool, String> {
    let Some(idx) = idx else { return Ok(false) };
    let value = row
        .get_ref(idx)
        .map_err(|err| format!("读取 providers 第 {} 列失败：{}", idx + 1, err))?;
    Ok(match value {
        ValueRef::Integer(number) => number != 0,
        ValueRef::Real(number) => number != 0.0,
        ValueRef::Text(bytes) => {
            let text = String::from_utf8_lossy(bytes).trim().to_ascii_lowercase();
            matches!(text.as_str(), "1" | "true" | "yes")
        }
        _ => false,
    })
}
