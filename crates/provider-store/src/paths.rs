//! Distinct Hub write targets, runtime read overrides, and explicit import sources.
use anyhow::{bail, Context, Result};
use std::path::{Component, Path, PathBuf};

#[derive(Debug, PartialEq, Eq)]
pub struct ProviderPaths {
    pub write_db: PathBuf,
    pub read_db: PathBuf,
    pub cc_source: PathBuf,
}

impl ProviderPaths {
    /// Pure path policy; neither reads nor creates a provider database.
    pub fn resolve(home: &Path, hub: Option<&Path>, legacy_read: Option<&Path>) -> Self {
        let write_db = hub
            .filter(|p| !p.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| home.join(".agent-hub/providers.db"));
        let read_db = legacy_read
            .filter(|p| !p.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| write_db.clone());
        Self {
            write_db,
            read_db,
            cc_source: home.join(".cc-switch/cc-switch.db"),
        }
    }

    pub fn from_env() -> Result<Self> {
        let home = dirs::home_dir().context("cannot find home directory")?;
        let hub = std::env::var_os("AGENT_HUB_PROVIDER_DB").map(PathBuf::from);
        let legacy = std::env::var_os("CLAUDE1_DB_PATH").map(PathBuf::from);
        Ok(Self::resolve(&home, hub.as_deref(), legacy.as_deref()))
    }
}

pub fn default_db_path() -> Result<PathBuf> {
    Ok(ProviderPaths::from_env()?.write_db)
}
pub fn runtime_db_path() -> Result<PathBuf> {
    Ok(ProviderPaths::from_env()?.read_db)
}
pub fn cc_source_path() -> Result<PathBuf> {
    Ok(ProviderPaths::from_env()?.cc_source)
}

// Resolve existing parents before comparing missing destinations, preserving symlink/.. semantics.
fn resolved(path: &Path) -> Result<PathBuf> {
    resolve_path(path, 0)
}

fn resolve_path(path: &Path, depth: usize) -> Result<PathBuf> {
    if depth > 64 {
        bail!("provider path contains too many symbolic links or components");
    }
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    if absolute.is_symlink() {
        let link = std::fs::read_link(&absolute)?;
        let destination = if link.is_absolute() {
            link
        } else {
            absolute
                .parent()
                .context("cannot resolve provider symbolic link")?
                .join(link)
        };
        return resolve_path(&destination, depth + 1);
    }
    if absolute.try_exists()? {
        return Ok(absolute.canonicalize()?);
    }
    let parent = absolute.parent().context("cannot resolve provider path")?;
    let mut base = resolve_path(parent, depth + 1)?;
    match absolute.components().next_back() {
        Some(Component::ParentDir) => {
            base.pop();
        }
        Some(Component::Normal(name)) => base.push(name),
        Some(Component::CurDir) => {}
        _ => bail!("cannot resolve provider path"),
    }
    Ok(base)
}

pub fn ensure_distinct(target: &Path, source: &Path) -> Result<()> {
    let target_path = resolved(target)?;
    let source_path = resolved(source)?;
    #[cfg(windows)]
    let equal = target_path
        .to_string_lossy()
        .eq_ignore_ascii_case(&source_path.to_string_lossy());
    #[cfg(not(windows))]
    let equal = target_path == source_path;
    if equal
        || (target.try_exists()?
            && source.try_exists()?
            && same_file::is_same_file(target, source)?)
    {
        bail!("provider source and Hub write target must be different files");
    }
    Ok(())
}

pub fn validate_write_path(target: &Path, cc_source: &Path) -> Result<()> {
    if target.is_symlink() {
        bail!("provider database must not be a symbolic link");
    }
    ensure_distinct(target, cc_source)
}
