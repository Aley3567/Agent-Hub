//! Hub write target is independent of runtime read overrides.
use anyhow::{Context, Result};
use std::path::PathBuf;

pub fn default_db_path() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("AGENT_HUB_PROVIDER_DB").filter(|p| !p.is_empty()) {
        return Ok(PathBuf::from(path));
    }
    Ok(dirs::home_dir()
        .context("找不到 HOME 目录")?
        .join(".agent-hub/providers.db"))
}
