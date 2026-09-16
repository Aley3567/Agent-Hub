//! Activation boundary: Windows/Linux migration is withheld until native acceptance.
use crate::{commit, credentials::SecretStore, model::ImportProvider, plan::Plan};
use anyhow::Result;
use std::path::Path;

pub fn backend() -> Result<Box<dyn SecretStore>> {
    #[cfg(target_os = "macos")]
    {
        Ok(Box::new(crate::credentials::macos::MacOsStore))
    }
    #[cfg(not(target_os = "macos"))]
    {
        anyhow::bail!("credential_backend_unverified")
    }
}
pub fn apply(
    path: &Path,
    records: &[ImportProvider],
    source: &str,
    replace: bool,
) -> Result<commit::Outcome> {
    // Linux retains its existing legacy writer until an OS backend is accepted.
    #[cfg(target_os = "linux")]
    {
        let mut conn = crate::open(path)?;
        let (added, skipped) = crate::import(&mut conn, records, source, replace, false)?;
        Ok(commit::Outcome {
            added,
            skipped,
            ..Default::default()
        })
    }
    #[cfg(not(target_os = "linux"))]
    {
        commit::apply(path, records, source, replace, backend()?.as_ref())
    }
}
pub fn apply_plan(plan: &Plan, selected: &[String], replace: bool) -> Result<commit::Outcome> {
    #[cfg(target_os = "linux")]
    {
        let records = plan.selected_records(selected, replace, |name| std::env::var(name).ok())?;
        apply(plan.target(), &records, plan.source_label(), replace)
    }
    #[cfg(not(target_os = "linux"))]
    {
        plan.apply(selected, replace, backend()?.as_ref(), |name| {
            std::env::var(name).ok()
        })
    }
}
pub fn migrate(path: &Path) -> Result<crate::migration::MigrationOutcome> {
    crate::migration::migrate(path, backend()?.as_ref())
}
pub fn remove(path: &Path, app: &str, id: &str) -> Result<commit::DeleteOutcome> {
    commit::remove(
        path,
        app,
        id,
        &crate::references::References::from_env()?,
        backend()?.as_ref(),
    )
}
pub fn recover(path: &Path) -> Result<usize> {
    commit::recover(path, backend()?.as_ref())
}

pub fn save(path: &Path, input: crate::edit::Input) -> Result<commit::Outcome> {
    #[cfg(not(target_os = "linux"))]
    {
        crate::edit::save(path, input, backend()?.as_ref())
    }
    #[cfg(target_os = "linux")]
    {
        let record = crate::custom(
            input.id,
            input.app_type,
            input.name,
            input
                .endpoint
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("endpoint_required"))?,
            input
                .secret
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("credential_required"))?,
            input
                .model
                .as_deref()
                .ok_or_else(|| anyhow::anyhow!("model_required"))?,
            input.protocol.as_deref().unwrap_or("anthropic"),
        )?;
        apply(path, &[record], "manual", input.expected_revision.is_some())
    }
}
