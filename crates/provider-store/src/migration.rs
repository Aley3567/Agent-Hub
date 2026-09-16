//! Explicit legacy migration; status is metadata-only and never creates storage.
use crate::{
    commit,
    credentials::{split, SecretStore},
    model::ImportProvider,
    store,
};
use anyhow::{bail, Result};
use rusqlite::Connection;
use serde::Serialize;
use std::path::Path;

pub(crate) struct Stored {
    pub record: ImportProvider,
    pub reference: Option<String>,
    pub version: Option<i64>,
    pub revision: i64,
}
pub(crate) fn records(conn: &Connection) -> Result<Vec<Stored>> {
    let columns = conn
        .prepare("PRAGMA table_info(providers)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let ref_col = if columns.iter().any(|c| c == "credential_ref") {
        "credential_ref"
    } else {
        "NULL"
    };
    let ver_col = if columns.iter().any(|c| c == "credential_version") {
        "credential_version"
    } else {
        "NULL"
    };
    let rev_col = if columns.iter().any(|c| c == "revision") {
        "revision"
    } else {
        "0"
    };
    let sql=format!("SELECT id,app_type,name,settings_config,meta,category,provider_type,sort_index,is_current,{ref_col},{ver_col},{rev_col} FROM providers ORDER BY app_type,id");
    let raw = conn
        .prepare(&sql)?
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
                r.get::<_, Option<i64>>(7)?,
                r.get::<_, bool>(8)?,
                r.get::<_, Option<String>>(9)?,
                r.get::<_, Option<i64>>(10)?,
                r.get::<_, i64>(11)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    raw.into_iter()
        .map(
            |(
                id,
                app_type,
                name,
                settings,
                meta,
                category,
                provider_type,
                sort_index,
                is_current,
                reference,
                version,
                revision,
            )| {
                Ok(Stored {
                    record: ImportProvider {
                        id,
                        app_type,
                        name,
                        settings_config: serde_json::from_str(&settings)
                            .map_err(|_| anyhow::anyhow!("invalid_provider_config"))?,
                        meta: serde_json::from_str(&meta)
                            .map_err(|_| anyhow::anyhow!("invalid_provider_meta"))?,
                        category,
                        provider_type,
                        sort_index,
                        is_current,
                    },
                    reference,
                    version,
                    revision,
                })
            },
        )
        .collect()
}
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub legacy: usize,
    pub referenced: usize,
    pub pending_cleanup: usize,
}
pub fn status(path: &Path) -> Result<Status> {
    if !path.exists() {
        return Ok(Status::default());
    }
    let conn = crate::snapshot::open(path)?;
    let mut result = Status::default();
    for row in records(&conn)? {
        if row.reference.is_some() {
            result.referenced += 1;
        } else if split::contains_secrets(&row.record)? {
            result.legacy += 1;
        }
    }
    let has_operations: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='credential_operations')",
        [],
        |r| r.get(0),
    )?;
    if has_operations {
        result.pending_cleanup =
            conn.query_row("SELECT count(*) FROM credential_operations", [], |r| {
                r.get(0)
            })?;
    }
    Ok(result)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationOutcome {
    pub applied: commit::Outcome,
    pub storage_cleanup_pending: bool,
}
pub fn migrate(path: &Path, secrets: &dyn SecretStore) -> Result<MigrationOutcome> {
    if !path.exists() {
        return Ok(MigrationOutcome {
            applied: commit::Outcome::default(),
            storage_cleanup_pending: false,
        });
    }
    let conn = crate::snapshot::open(path)?;
    let baseline = commit::revision(&conn)?;
    let mut selected = Vec::new();
    let mut skipped = 0;
    for row in records(&conn)? {
        if row.reference.is_none() && split::contains_secrets(&row.record)? {
            selected.push(row.record);
        } else {
            skipped += 1;
        }
    }
    let mut applied = if selected.is_empty() {
        commit::Outcome::default()
    } else {
        commit::apply_checked(
            path,
            &selected,
            "credential-migration",
            true,
            secrets,
            || {
                if commit::revision(&crate::snapshot::open(path)?)? != baseline {
                    bail!("provider_revision_conflict");
                }
                Ok(())
            },
            || Ok(()),
        )?
    };
    applied.skipped += skipped;
    applied.pending_cleanup = status(path)?.pending_cleanup;
    // Logical migration is already committed. Maintenance failure must never
    // report that the old records are still active or destroy historical backups.
    let maintenance = (|| -> Result<()> {
        let _lock = commit::WriterLock::acquire(path)?;
        let conn = store::open(path)?;
        let pending: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM provider_maintenance WHERE name='storage_cleanup')",
            [],
            |r| r.get(0),
        )?;
        if !pending {
            return Ok(());
        }
        conn.execute_batch("PRAGMA secure_delete=ON; VACUUM;")?;
        let busy: i64 = conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(0))?;
        if busy != 0 {
            bail!("storage_cleanup_busy");
        }
        conn.execute(
            "DELETE FROM provider_maintenance WHERE name='storage_cleanup'",
            [],
        )?;
        Ok(())
    })();
    Ok(MigrationOutcome {
        applied,
        storage_cleanup_pending: maintenance.is_err(),
    })
}
