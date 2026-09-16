//! Claude-only association checks shared by terminal and desktop delete commands.
use anyhow::{bail, Result};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub struct References {
    pub hub: PathBuf,
    pub catalog: PathBuf,
    pub pools: PathBuf,
    pub config: PathBuf,
}
fn env_path(name: &str, default: PathBuf) -> PathBuf {
    std::env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or(default)
}
fn read(path: &Path) -> Result<Option<Value>> {
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| anyhow::anyhow!("invalid_reference_config")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => bail!("reference_config_unavailable"),
    }
}
impl References {
    pub fn from_env() -> Result<Self> {
        let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("home_unavailable"))?;
        let base = home.join(".cc-switch");
        Ok(Self {
            hub: env_path("CLAUDE1_HUB_CONFIG", base.join("claude-hub.json")),
            catalog: env_path("CLAUDE1_HUB_CATALOG", base.join("claude-hubs.json")),
            config: env_path("CLAUDE1_CONFIG_PATH", base.join("claude1-config.json")),
            pools: env_path(
                "CLAUDE1_ACCOUNT_POOL_CONFIG",
                base.join("claude1-account-pools.json"),
            ),
        })
    }
    pub fn blockers(
        &self,
        app: &str,
        id: &str,
        providers: &[crate::model::Provider],
    ) -> Result<Vec<String>> {
        if app != "claude" {
            return Ok(vec![]);
        }
        let config = read(&self.config)?.unwrap_or(Value::Null);
        let terms: Vec<_> = providers
            .iter()
            .map(|provider| {
                let mut terms = vec![
                    provider.name.to_lowercase(),
                    format!("id:{}", provider.id).to_lowercase(),
                ];
                if let Some(alias) = config["providers"][&provider.id]["alias"]
                    .as_str()
                    .filter(|v| !v.trim().is_empty())
                {
                    terms.push(alias.trim().to_lowercase());
                }
                (&provider.id, terms)
            })
            .collect();
        let matches = |selector: &str| {
            let needle = selector.trim().to_lowercase();
            if needle.is_empty() {
                return false;
            }
            let exact: Vec<_> = terms
                .iter()
                .filter(|(_, terms)| terms.contains(&needle))
                .collect();
            if !exact.is_empty() {
                return exact.iter().any(|(candidate, _)| candidate.as_str() == id);
            }
            terms.iter().any(|(candidate, terms)| {
                candidate.as_str() == id
                    && terms
                        .iter()
                        .enumerate()
                        .any(|(index, term)| index != 1 && term.contains(&needle))
            })
        };
        let mut paths = vec![self.hub.clone()];
        if let Some(catalog) = read(&self.catalog)? {
            let base = self.catalog.parent().unwrap_or(Path::new("."));
            if let Some(hubs) = catalog["hubs"].as_object() {
                let default = catalog["default_hub"].as_str().unwrap_or("claude-hub");
                for (id, value) in hubs {
                    let fallback = if id == default {
                        "claude-hub.json".into()
                    } else {
                        format!("hubs/{id}.json")
                    };
                    paths.push(base.join(value["config"].as_str().unwrap_or(&fallback)));
                }
            }
        }
        paths.sort();
        paths.dedup();
        let mut blockers = vec![];
        for path in paths {
            if let Some(root) = read(&path)? {
                if let Some(channels) = root["channels"].as_object() {
                    for (channel, value) in channels {
                        if value["provider"].as_str().is_some_and(&matches) {
                            blockers.push(format!("{}#channels.{channel}", path.display()));
                        }
                    }
                }
            }
        }
        if let Some(root) = read(&self.pools)? {
            if let Some(pools) = root["providers"].as_object() {
                for (primary, value) in pools {
                    let mut used = matches(primary);
                    if let Some(members) = value["members"].as_array() {
                        used |= members
                            .iter()
                            .any(|m| m.as_str().or(m["provider"].as_str()).is_some_and(&matches));
                    }
                    if used {
                        blockers.push(format!("{}#providers.{primary}", self.pools.display()));
                    }
                }
            }
        }
        Ok(blockers)
    }
}
