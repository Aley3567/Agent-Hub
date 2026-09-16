//! Hub schema and provider operations. Frontends do not own SQL writes.
use crate::model::{validate, ImportProvider, Provider};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags};
use std::{fs, path::Path};

pub const SCHEMA: &str = include_str!("../../../provider-schema.sql");

pub fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if path.is_symlink() {
        bail!("provider database must not be a symbolic link");
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(path)?.permissions().mode() & 0o077 != 0 {
            bail!("provider database requires 0600 permissions");
        }
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

/// Open an existing provider database without creating or migrating it.
pub fn open_readonly(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .context("cannot open provider database read-only")?;
    conn.pragma_update(None, "query_only", true)?;
    Ok(conn)
}

/// Existing IDs are preserved by default. Explicit replace is required to update them.
pub fn import(
    conn: &mut Connection,
    providers: &[ImportProvider],
    source: &str,
    replace: bool,
    preview: bool,
) -> Result<(usize, usize)> {
    let mut seen = std::collections::HashSet::new();
    for p in providers {
        validate(p)?;
        if !seen.insert((&p.id, &p.app_type)) {
            bail!("duplicate provider identity in import");
        }
    }
    let tx = conn.transaction()?;
    let (mut changed, mut skipped) = (0, 0);
    for p in providers {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM providers WHERE id=?1 AND app_type=?2)",
            params![p.id, p.app_type],
            |r| r.get(0),
        )?;
        if exists && !replace {
            skipped += 1;
            continue;
        }
        changed += 1;
        if preview {
            continue;
        }
        tx.execute("INSERT INTO providers(id,app_type,name,settings_config,meta,category,provider_type,sort_index,is_current) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id,app_type) DO UPDATE SET name=excluded.name, settings_config=excluded.settings_config, meta=excluded.meta, category=excluded.category, provider_type=excluded.provider_type, sort_index=excluded.sort_index", params![p.id,p.app_type,p.name,p.settings_config.to_string(),p.meta.to_string(),p.category,p.provider_type,p.sort_index,p.is_current])?;
        tx.execute("INSERT INTO provider_sources(id,app_type,source,imported_at) VALUES(?1,?2,?3,strftime('%s','now')) ON CONFLICT(id,app_type) DO UPDATE SET source=excluded.source, imported_at=excluded.imported_at", params![p.id,p.app_type,source])?;
    }
    if !preview {
        tx.commit()?;
    }
    Ok((changed, skipped))
}

/// 列出渠道，可选按 app 过滤（如 `claude` / `codex`）。按 app + 排序索引排列。
pub fn list_providers(conn: &Connection, app: Option<&str>) -> Result<Vec<Provider>> {
    // 刻意不 SELECT settings_config：凭证不出库。
    let sql = "SELECT id, app_type, name, category, provider_type, is_current, \
               in_failover_queue, sort_index FROM providers \
               WHERE (?1 IS NULL OR app_type = ?1) \
               ORDER BY app_type, sort_index, name";
    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([app], |row| {
        Ok(Provider {
            id: row.get(0)?,
            app_type: row.get(1)?,
            name: row.get(2)?,
            category: row.get(3)?,
            provider_type: row.get(4)?,
            is_current: row.get(5)?,
            in_failover_queue: row.get(6)?,
            sort_index: row.get(7)?,
        })
    })?;
    rows.collect::<std::result::Result<Vec<_>, _>>()
        .context("读取 providers 表失败")
}

/// 每个 app 的当前激活渠道。
pub fn current_providers(conn: &Connection) -> Result<Vec<Provider>> {
    let all = list_providers(conn, None)?;
    Ok(all.into_iter().filter(|p| p.is_current).collect())
}

/// Remove only the selected application identity and its import provenance.
/// Reference blocking and credential cleanup are added by S25 E0 before desktop writes.
pub fn remove(conn: &mut Connection, id: &str, app_type: &str) -> Result<usize> {
    let tx = conn.transaction()?;
    let count = tx.execute(
        "DELETE FROM providers WHERE id=?1 AND app_type=?2",
        params![id, app_type],
    )?;
    tx.execute(
        "DELETE FROM provider_sources WHERE id=?1 AND app_type=?2",
        params![id, app_type],
    )?;
    tx.commit()?;
    Ok(count)
}
