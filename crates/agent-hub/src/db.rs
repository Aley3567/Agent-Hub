//! cc-switch 共享 DB 的只读访问。
//!
//! 共存纪律（`docs/agent-hub-design.md` Q4）：
//! - 共享 `~/.cc-switch/cc-switch.db`，schema 版本与上游锁步；
//!   `user_version` 高于 [`KNOWN_SCHEMA_VERSION`] 说明 DB 由更新版本创建，拒绝访问。
//! - 上游 schema 一行不加；Agent-Hub 自有数据一律 sidecar（`agent-hub.db`，M2 才出现）。
//! - `settings_config` 列含 API 凭证，本层的 SELECT 刻意不取它。

use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// 已验证的上游 schema 版本上限。cc-switch-cli `database/mod.rs` 为 17，
/// 本机实测 16；低于等于放行，高于拒绝并提示升级。
pub const KNOWN_SCHEMA_VERSION: u32 = 17;

/// 渠道清单条目。注意没有 `settings_config` 字段——凭证不出库。
#[derive(Debug, Clone, Serialize)]
pub struct Provider {
    pub id: String,
    pub app_type: String,
    pub name: String,
    pub category: Option<String>,
    pub provider_type: Option<String>,
    pub is_current: bool,
    pub in_failover_queue: bool,
    pub sort_index: Option<i64>,
}

/// 默认 DB 路径：`~/.cc-switch/cc-switch.db`。
pub fn default_db_path() -> Result<PathBuf> {
    let home = dirs::home_dir().context("找不到 HOME 目录")?;
    Ok(home.join(".cc-switch").join("cc-switch.db"))
}

/// 以只读方式打开共享 DB，并校验 schema 版本。
pub fn open_readonly(path: &Path) -> Result<Connection> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("无法只读打开 {}", path.display()))?;
    check_schema_version(&conn)?;
    Ok(conn)
}

/// 版本闸：高于已知上限 = DB 被更新版本的 cc-switch 写过，我们的读法可能已失真。
pub fn check_schema_version(conn: &Connection) -> Result<()> {
    let version: u32 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if version > KNOWN_SCHEMA_VERSION {
        bail!(
            "cc-switch DB schema 版本 {} 高于已知上限 {}（由更新版本的 cc-switch 创建），\
             请升级 agent-hub 后再访问",
            version,
            KNOWN_SCHEMA_VERSION
        );
    }
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE providers (
                id TEXT NOT NULL,
                app_type TEXT NOT NULL,
                name TEXT NOT NULL,
                settings_config TEXT NOT NULL,
                category TEXT,
                provider_type TEXT,
                is_current BOOLEAN NOT NULL DEFAULT 0,
                in_failover_queue BOOLEAN NOT NULL DEFAULT 0,
                sort_index INTEGER,
                PRIMARY KEY (id, app_type)
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO providers (id, app_type, name, settings_config, category, \
             is_current, sort_index) VALUES ('p1', 'claude', '甲渠道', '{\"apiKey\":\"sk-secret\"}', \
             'relay', 1, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO providers (id, app_type, name, settings_config, is_current, sort_index) \
             VALUES ('p2', 'codex', '乙渠道', '{}', 0, 1)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn list_all_and_filter_by_app() {
        let conn = fixture();
        assert_eq!(list_providers(&conn, None).unwrap().len(), 2);
        let claude = list_providers(&conn, Some("claude")).unwrap();
        assert_eq!(claude.len(), 1);
        assert_eq!(claude[0].name, "甲渠道");
        assert!(claude[0].is_current);
    }

    #[test]
    fn current_only_returns_activated() {
        let conn = fixture();
        let current = current_providers(&conn).unwrap();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].id, "p1");
    }

    #[test]
    fn serialized_output_never_contains_credentials() {
        let conn = fixture();
        let json = serde_json::to_string(&list_providers(&conn, None).unwrap()).unwrap();
        assert!(!json.contains("sk-secret"));
        assert!(!json.contains("settings_config"));
    }

    #[test]
    fn schema_version_gate() {
        let conn = fixture();
        check_schema_version(&conn).unwrap();
        conn.execute_batch(&format!(
            "PRAGMA user_version = {}",
            KNOWN_SCHEMA_VERSION + 1
        ))
        .unwrap();
        assert!(check_schema_version(&conn).is_err());
    }
}
