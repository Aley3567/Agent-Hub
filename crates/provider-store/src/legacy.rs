//! Linux compatibility writer. Never converts referenced credentials back to plaintext.
use crate::{commit, model::ImportProvider, store};
#[cfg(any(target_os = "linux", test))]
use crate::references::References;
use anyhow::{bail, Result};
use rusqlite::{params, TransactionBehavior};
#[cfg(any(target_os = "linux", test))]
use rusqlite::OptionalExtension;
use std::path::Path;

pub(crate) fn apply_checked(
    path: &Path, records: &[ImportProvider], source: &str, replace: bool,
    preflight: impl FnOnce() -> Result<()>, recheck: impl FnOnce() -> Result<()>,
) -> Result<commit::Outcome> {
    (|| {
    let _lock = commit::WriterLock::acquire(path)?;
    let baseline = if path.exists() { commit::revision(&crate::snapshot::open(path)?)? } else { vec![] };
    preflight()?;
    let mut conn = store::open(path)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if commit::revision(&tx)? != baseline { bail!("provider_revision_conflict"); }
    let mut updated = 0;
    if replace {
        for record in records {
            updated += tx.query_row("SELECT EXISTS(SELECT 1 FROM providers WHERE app_type=?1 AND id=?2)",
                params![record.app_type, record.id], |r| r.get::<_, usize>(0))?;
        }
    }
    let (changed, skipped) = store::import_in_transaction(&tx, records, source, replace, false)?;
    recheck()?;
    tx.commit()?;
    Ok(commit::Outcome { added: changed - updated, updated, skipped, pending_cleanup: 0 })
    })().map_err(commit::safe_error)
}

#[cfg(any(target_os = "linux", test))]
pub(crate) fn remove(path: &Path, app: &str, id: &str, references: &References) -> Result<commit::DeleteOutcome> {
    (|| {
    if !["claude", "codex"].contains(&app) { bail!("invalid_application"); }
    let _lock = commit::WriterLock::acquire(path)?;
    let mut conn = store::open(path)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let reference: Option<Option<String>> = tx.query_row(
        "SELECT credential_ref FROM providers WHERE app_type=?1 AND id=?2", params![app, id], |r| r.get(0),
    ).optional()?;
    if reference.flatten().is_some() { bail!("credential_store_required"); }
    let blockers = references.blockers(app, id, &store::list_providers(&tx, Some("claude"))?)?;
    if !blockers.is_empty() { return Ok(commit::DeleteOutcome { removed: 0, blockers, pending_cleanup: 0 }); }
    let removed = tx.execute("DELETE FROM providers WHERE app_type=?1 AND id=?2", params![app, id])?;
    tx.execute("DELETE FROM provider_sources WHERE app_type=?1 AND id=?2", params![app, id])?;
    tx.commit()?;
    Ok(commit::DeleteOutcome { removed, blockers, pending_cleanup: 0 })
    })().map_err(commit::safe_error)
}
