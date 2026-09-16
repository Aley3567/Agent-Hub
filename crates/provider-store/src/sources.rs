//! Explicit, read-only import adapters. No runtime synchronization.
use crate::model::{ImportDocument, ImportProvider};
use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::{fs, path::Path};

pub fn read_file(path: &Path) -> Result<Vec<ImportProvider>> {
    let text = fs::read_to_string(path).context("cannot read provider import file")?;
    let doc: ImportDocument = serde_json::from_str(&text).map_err(|_| {
        anyhow::anyhow!("invalid provider document (expected version:1, providers:[])")
    })?;
    if doc.version != 1 {
        bail!("unsupported provider document version");
    }
    Ok(doc.providers)
}

pub fn read_cc(path: &Path) -> Result<Vec<ImportProvider>> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .context("cannot read CC Switch source")?;
    let columns = conn
        .prepare("PRAGMA table_info(providers)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for required in ["id", "app_type", "name", "settings_config"] {
        if !columns.iter().any(|column| column == required) {
            bail!("CC Switch source providers table is missing required column: {required}");
        }
    }
    let fields = [
        "id",
        "app_type",
        "name",
        "settings_config",
        "meta",
        "category",
        "provider_type",
        "sort_index",
        "is_current",
    ];
    let selected: Vec<&str> = fields
        .into_iter()
        .filter(|f| columns.iter().any(|c| c == f))
        .collect();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM providers WHERE app_type IN ('claude','codex')",
        selected.join(",")
    ))?;
    let rows = stmt
        .query_map([], |row| {
            let mut value = serde_json::Map::new();
            for (i, key) in selected.iter().enumerate() {
                use rusqlite::types::ValueRef;
                let v = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => {
                        if *key == "is_current" {
                            json!(n != 0)
                        } else {
                            json!(n)
                        }
                    }
                    ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into()),
                    _ => Value::Null,
                };
                value.insert((*key).into(), v);
            }
            Ok(value)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|mut row| {
            for key in ["settings_config", "meta"] {
                let value = match row.remove(key) {
                    Some(Value::String(text)) => serde_json::from_str(&text)
                        .map_err(|_| anyhow::anyhow!("invalid source provider JSON"))?,
                    Some(Value::Null) | None => json!({}),
                    Some(v) => v,
                };
                row.insert(key.into(), if value.is_null() { json!({}) } else { value });
            }
            serde_json::from_value(Value::Object(row))
                .map_err(|_| anyhow::anyhow!("invalid source provider fields"))
        })
        .collect()
}
