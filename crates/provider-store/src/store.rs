//! Hub schema and provider operations. Frontends do not own SQL writes.
use crate::model::{validate, ImportProvider, Provider};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags};
use std::{fs, path::Path};

pub const SCHEMA: &str = include_str!("../../../provider-schema.sql");

pub fn open(path: &Path) -> Result<Connection> {
    crate::paths::validate_write_path(path, &crate::paths::cc_source_path()?)?;
    if path.try_exists()? && fs::metadata(path)?.len() > 0 {
        validate_hub_database(&open_readonly(path)?)?;
    }
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
    let mut conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    validate_hub_database(&tx)?;
    tx.execute_batch(SCHEMA)?;
    let columns = tx
        .prepare("PRAGMA table_info(providers)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (name, definition) in [
        ("credential_ref", "TEXT"),
        ("credential_version", "INTEGER"),
        ("revision", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        if !columns.iter().any(|column| column == name) {
            tx.execute_batch(&format!(
                "ALTER TABLE providers ADD COLUMN {name} {definition}"
            ))?;
        }
    }
    tx.commit()?;
    Ok(conn)
}

// Legacy Hub databases have provider_sources but no application_id. Never adopt an
// external database merely because it happens to contain a providers table.
pub(crate) fn validate_hub_database(conn: &Connection) -> Result<()> {
    let application: u32 = conn.pragma_query_value(None, "application_id", |row| row.get(0))?;
    if application != 0 && application != 1095259458 {
        bail!("database belongs to another application; import it into a Hub database instead");
    }
    let tables = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    if tables.is_empty() {
        return Ok(());
    }
    if !tables.iter().any(|name| name == "providers")
        || !tables.iter().any(|name| name == "provider_sources")
        || tables.iter().any(|name| {
            [
                "settings",
                "provider_endpoints",
                "proxy_config",
                "mcp_servers",
            ]
            .contains(&name.as_str())
        })
    {
        bail!("database is not a Hub provider store; use explicit import for external sources");
    }
    for (table, required) in [
        (
            "providers",
            &[
                "id",
                "app_type",
                "name",
                "settings_config",
                "meta",
                "category",
                "provider_type",
                "is_current",
                "in_failover_queue",
                "sort_index",
            ][..],
        ),
        (
            "provider_sources",
            &["id", "app_type", "source", "imported_at"][..],
        ),
    ] {
        let columns = conn
            .prepare(&format!("PRAGMA table_info({table})"))?
            .query_map([], |row| row.get::<_, String>(1))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        for column in required {
            if !columns.iter().any(|name| name == column) {
                bail!("Hub {table} table is missing required column: {column}");
            }
        }
    }
    Ok(())
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
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let result = import_in_transaction(&tx, providers, source, replace, preview)?;
    if !preview { tx.commit()?; }
    Ok(result)
}

pub(crate) fn import_in_transaction(
    tx: &Connection, providers: &[ImportProvider], source: &str, replace: bool, preview: bool,
) -> Result<(usize, usize)> {
    let mut seen = std::collections::HashSet::new();
    for p in providers {
        validate(p)?;
        if !seen.insert((&p.id, &p.app_type)) {
            bail!("duplicate provider identity in import");
        }
    }
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
        if exists && !preview {
            let referenced: bool = tx.query_row(
                "SELECT credential_ref IS NOT NULL FROM providers WHERE id=?1 AND app_type=?2",
                params![p.id, p.app_type], |r| r.get(0),
            )?;
            if referenced { bail!("credential_store_required"); }
        }
        changed += 1;
        if preview {
            continue;
        }
        tx.execute("INSERT INTO providers(id,app_type,name,settings_config,meta,category,provider_type,sort_index,is_current,revision) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,1) ON CONFLICT(id,app_type) DO UPDATE SET name=excluded.name, settings_config=excluded.settings_config, meta=excluded.meta, category=excluded.category, provider_type=excluded.provider_type, sort_index=excluded.sort_index, revision=providers.revision+1", params![p.id,p.app_type,p.name,p.settings_config.to_string(),p.meta.to_string(),p.category,p.provider_type,p.sort_index,p.is_current])?;
        tx.execute("INSERT INTO provider_sources(id,app_type,source,imported_at) VALUES(?1,?2,?3,strftime('%s','now')) ON CONFLICT(id,app_type) DO UPDATE SET source=excluded.source, imported_at=excluded.imported_at", params![p.id,p.app_type,source])?;
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
    let referenced: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM providers WHERE id=?1 AND app_type=?2 AND credential_ref IS NOT NULL)",
        params![id, app_type], |r| r.get(0),
    )?;
    if referenced { bail!("credential_store_required"); }
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
