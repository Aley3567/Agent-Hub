//! Immutable secret versions and durable recovery. SQL commit is the visibility point.
use crate::{
    credentials::{self, CredentialError, SecretStore},
    model::{validate, ImportProvider},
    store,
};
use anyhow::{bail, Result};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    path::Path,
};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    pub pending_cleanup: usize,
}

pub(crate) struct WriterLock(File);
impl WriterLock {
    pub(crate) fn acquire(path: &Path) -> Result<Self> {
        crate::paths::validate_write_path(path, &crate::paths::cc_source_path()?)?;
        #[cfg(unix)]
        if path.exists() {
            use std::os::unix::fs::MetadataExt;
            if fs::metadata(path)?.nlink() > 1 {
                bail!("provider_write_alias");
            }
        }
        if path.exists() {
            store::validate_hub_database(&store::open_readonly(path)?)?;
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let mut lock_path = path.as_os_str().to_os_string();
        lock_path.push(".writer-lock");
        let lock_path = std::path::PathBuf::from(lock_path);
        if lock_path.is_symlink() {
            bail!("invalid_writer_lock");
        }
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let file = options.open(lock_path)?;
        file.try_lock()
            .map_err(|_| anyhow::anyhow!("provider_store_busy"))?;
        Ok(Self(file))
    }
}
impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

// Compare full provider/provenance state: legacy writers may not increment revisions.
pub(crate) fn revision(conn: &Connection) -> Result<Vec<Vec<rusqlite::types::Value>>> {
    let mut result = Vec::new();
    for sql in [
        "SELECT * FROM providers ORDER BY app_type,id",
        "SELECT * FROM provider_sources ORDER BY app_type,id",
    ] {
        let mut stmt = conn.prepare(sql)?;
        let columns = stmt.column_count();
        let rows = stmt.query_map([], |r| {
            (0..columns)
                .map(|i| r.get(i))
                .collect::<rusqlite::Result<Vec<_>>>()
        })?;
        for row in rows {
            result.push(row?);
        }
    }
    Ok(result)
}

fn cleanup(conn: &Connection, secrets: &dyn SecretStore) -> Result<usize> {
    let rows = conn
        .prepare("SELECT op_id,credential_ref FROM credential_operations")?
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (op, reference) in rows {
        let used: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM providers WHERE credential_ref=?1)",
            [&reference],
            |r| r.get(0),
        )?;
        if used {
            continue;
        }
        if !credentials::valid_reference(&reference) {
            conn.execute("UPDATE credential_operations SET last_error_code='credential_corrupt' WHERE op_id=?1 AND credential_ref=?2", params![op,reference])?;
            continue;
        }
        match secrets.delete(&reference) {
            Ok(()) | Err(CredentialError::NotFound) => {
                conn.execute(
                    "DELETE FROM credential_operations WHERE op_id=?1 AND credential_ref=?2",
                    params![op, reference],
                )?;
            }
            Err(error) => {
                conn.execute("UPDATE credential_operations SET last_error_code=?3 WHERE op_id=?1 AND credential_ref=?2", params![op,reference,error.code()])?;
            }
        }
    }
    Ok(
        conn.query_row("SELECT count(*) FROM credential_operations", [], |r| {
            r.get(0)
        })?,
    )
}
pub fn recover(path: &Path, secrets: &dyn SecretStore) -> Result<usize> {
    (|| {
        let _lock = WriterLock::acquire(path)?;
        cleanup(&store::open(path)?, secrets)
    })()
    .map_err(|_: anyhow::Error| anyhow::anyhow!("provider_recovery_failed"))
}

pub fn apply(
    path: &Path,
    records: &[ImportProvider],
    source: &str,
    replace: bool,
    secrets: &dyn SecretStore,
) -> Result<Outcome> {
    apply_checked(
        path,
        records,
        source,
        replace,
        secrets,
        || Ok(()),
        || Ok(()),
    )
}

/// preflight runs under the writer lock before open/schema/intent writes;
/// recheck runs just before SQL commit and only checks source/environment changes.
pub fn apply_checked(
    path: &Path,
    records: &[ImportProvider],
    source: &str,
    replace: bool,
    secrets: &dyn SecretStore,
    preflight: impl FnOnce() -> Result<()>,
    recheck: impl FnOnce() -> Result<()>,
) -> Result<Outcome> {
    apply_inner(path, records, source, replace, secrets, preflight, recheck).map_err(|error| {
        if let Some(code) = error.downcast_ref::<CredentialError>() {
            return anyhow::anyhow!(code.code());
        }
        if error.downcast_ref::<rusqlite::Error>().is_some() {
            return anyhow::anyhow!("provider_commit_failed");
        }
        let message = error.to_string();
        let code = message.split(':').next().unwrap_or("");
        if [
            "provider_revision_conflict",
            "provider_store_busy",
            "provider_write_alias",
            "invalid_writer_lock",
            "invalid_revision",
            "duplicate_provider_identity",
            "plan_stale",
            "plan_expired",
            "credential_corrupt",
            "credential_missing",
            "credential_denied",
            "credential_locked",
            "credential_unavailable",
            "credential_timeout",
            "credential_too_large",
            "provider_commit_failed",
            "provider_change_failed",
        ]
        .contains(&code)
        {
            anyhow::anyhow!(message)
        } else {
            anyhow::anyhow!("provider_change_failed")
        }
    })
}

fn apply_inner(
    path: &Path,
    records: &[ImportProvider],
    source: &str,
    replace: bool,
    secrets: &dyn SecretStore,
    preflight: impl FnOnce() -> Result<()>,
    recheck: impl FnOnce() -> Result<()>,
) -> Result<Outcome> {
    let mut seen = BTreeSet::new();
    for record in records {
        validate(record)?;
        if !seen.insert((&record.app_type, &record.id)) {
            bail!("duplicate_provider_identity");
        }
    }
    let _lock = WriterLock::acquire(path)?;
    preflight()?;
    let mut conn = store::open(path)?;
    conn.pragma_update(None, "secure_delete", true)?;
    let baseline = revision(&conn)?;
    let mut outcome = Outcome::default();
    let op = uuid::Uuid::new_v4().to_string();
    let mut pending = Vec::new();
    for record in records {
        let old: Option<(i64, Option<String>)> = conn
            .query_row(
                "SELECT revision,credential_ref FROM providers WHERE app_type=?1 AND id=?2",
                params![record.app_type, record.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if old.is_some() && !replace {
            outcome.skipped += 1;
            continue;
        }
        let next_revision = old
            .as_ref()
            .map_or(0, |r| r.0)
            .checked_add(1)
            .ok_or_else(|| anyhow::anyhow!("invalid_revision"))?;
        if next_revision < 1 {
            bail!("invalid_revision");
        }
        let (public, envelope) = credentials::split::separate(record, next_revision)?;
        let payload = envelope.encode()?;
        let reference = format!("provider/v1/{}", uuid::Uuid::new_v4());
        if old.is_some() {
            outcome.updated += 1;
        } else {
            outcome.added += 1;
        }
        pending.push((
            public,
            reference,
            payload,
            next_revision,
            old.and_then(|r| r.1),
        ));
    }
    if pending.is_empty() {
        return Ok(outcome);
    }
    // Durable intent precedes every OS create, even if the process dies inside it.
    {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if revision(&tx)? != baseline {
            bail!("provider_revision_conflict");
        }
        for (_, reference, _, _, _) in &pending {
            tx.execute("INSERT INTO credential_operations(op_id,credential_ref,state) VALUES(?1,?2,'create')", params![op,reference])?;
        }
        tx.commit()?;
    }
    let work = (|| -> Result<()> {
        for (_, reference, payload, _, _) in &pending {
            secrets.create(reference, payload)?;
            if secrets.read(reference)? != *payload {
                bail!("credential_corrupt");
            }
        }
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if revision(&tx)? != baseline {
            bail!("provider_revision_conflict");
        }
        recheck()?;
        for (record, reference, _, rev, old) in &pending {
            tx.execute("INSERT INTO providers(id,app_type,name,settings_config,meta,category,provider_type,sort_index,is_current,credential_ref,credential_version,revision) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,1,?11) ON CONFLICT(id,app_type) DO UPDATE SET name=excluded.name,settings_config=excluded.settings_config,meta=excluded.meta,category=excluded.category,provider_type=excluded.provider_type,sort_index=excluded.sort_index,credential_ref=excluded.credential_ref,credential_version=1,revision=excluded.revision",
                params![record.id,record.app_type,record.name,record.settings_config.to_string(),record.meta.to_string(),record.category,record.provider_type,record.sort_index,record.is_current,reference,rev])?;
            tx.execute("INSERT INTO provider_sources(id,app_type,source,imported_at) VALUES(?1,?2,?3,strftime('%s','now')) ON CONFLICT(id,app_type) DO UPDATE SET source=excluded.source,imported_at=excluded.imported_at", params![record.id,record.app_type,source])?;
            if let Some(old) = old {
                tx.execute("INSERT INTO credential_operations(op_id,credential_ref,state) VALUES(?1,?2,'cleanup')", params![op,old])?;
            }
            tx.execute(
                "DELETE FROM credential_operations WHERE op_id=?1 AND credential_ref=?2",
                params![op, reference],
            )?;
        }
        tx.commit()?;
        Ok(())
    })();
    let remaining = cleanup(&conn, secrets);
    match work {
        Ok(()) => {
            outcome.pending_cleanup = remaining.unwrap_or(pending.len());
            Ok(outcome)
        }
        Err(error) => {
            // Preserve the root error code while distinguishing unapplied cleanup debt.
            let code = error
                .downcast_ref::<CredentialError>()
                .map(|e| e.code())
                .unwrap_or_else(|| {
                    if error.downcast_ref::<rusqlite::Error>().is_some() {
                        "provider_commit_failed"
                    } else {
                        "provider_change_failed"
                    }
                });
            let safe = if [
                "provider_revision_conflict",
                "plan_stale",
                "plan_expired",
                "credential_corrupt",
            ]
            .contains(&error.to_string().as_str())
            {
                error.to_string()
            } else {
                code.into()
            };
            if remaining.unwrap_or(1) != 0 {
                bail!("{safe}: not_applied_cleanup_pending");
            }
            bail!("{safe}")
        }
    }
}
