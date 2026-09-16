//! Read-only source snapshots and secret-free previews. Plans stay in backend memory.
use crate::{
    model::{validate, ImportProvider},
    sources::{self, user::Scan},
    store,
};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

#[derive(Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Source {
    CcSwitch {
        path: PathBuf,
    },
    Json {
        path: PathBuf,
    },
    Claude {
        path: PathBuf,
    },
    Codex {
        config: PathBuf,
        auth: PathBuf,
        profile: Option<String>,
    },
}
impl Source {
    fn paths(&self) -> Vec<&Path> {
        match self {
            Self::CcSwitch { path } | Self::Json { path } | Self::Claude { path } => vec![path],
            Self::Codex { config, auth, .. } => vec![config, auth],
        }
    }
    pub fn label(&self) -> &'static str {
        match self {
            Self::CcSwitch { .. } => "cc-switch",
            Self::Json { .. } => "file",
            Self::Claude { .. } => "claude-user",
            Self::Codex { .. } => "codex-user",
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    pub candidate_id: String,
    pub id: String,
    pub app_type: String,
    pub name: String,
    pub endpoint: Option<String>,
    pub protocol: String,
    pub credential: &'static str,
    pub conflict: bool,
    pub blocked_reason: Option<&'static str>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub plan_id: String,
    pub source: &'static str,
    pub candidates: Vec<Candidate>,
    pub blocked: Vec<&'static str>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    pub selected: Vec<String>,
    pub replace: bool,
}

pub struct Plan {
    pub id: String,
    source: Source,
    target: PathBuf,
    stamps: BTreeMap<PathBuf, Option<Vec<u8>>>,
    environment: BTreeMap<String, Option<Vec<u8>>>,
    created: Instant,
    records: Vec<ImportProvider>,
    candidates: Vec<Candidate>,
    blocked: Vec<&'static str>,
    selection: Option<Selection>,
}

fn digest(value: &[u8]) -> Vec<u8> {
    Sha256::digest(value).to_vec()
}
fn stamp(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(digest(&bytes))),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => bail!("source_read_failed"),
    }
}
fn endpoint(raw: Option<&str>) -> Option<String> {
    // Show only scheme + authority. Path/query/userinfo may contain secrets.
    let raw = raw?;
    let (scheme, rest) = raw.split_once("://")?;
    if !["http", "https"].contains(&scheme) {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?.rsplit('@').next()?;
    if authority.is_empty() || authority.chars().any(char::is_whitespace) {
        return None;
    }
    Some(format!("{scheme}://{authority}"))
}
pub(crate) fn project(index: usize, record: &ImportProvider, conflict: bool) -> Candidate {
    let (url, credential, protocol, blocked) = if record.app_type == "claude" {
        let env = &record.settings_config["env"];
        let present = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"]
            .iter()
            .any(|key| env[key].as_str().is_some_and(|v| !v.trim().is_empty()));
        (
            env["ANTHROPIC_BASE_URL"].as_str().map(str::to_owned),
            present,
            record.meta["apiFormat"]
                .as_str()
                .or(record.settings_config["api_format"].as_str())
                .or(record.settings_config["apiFormat"].as_str())
                .unwrap_or("anthropic")
                .to_string(),
            None,
        )
    } else {
        let config = record.settings_config["config"]
            .as_str()
            .and_then(|text| toml::from_str::<toml::Table>(text).ok());
        let url = config
            .as_ref()
            .and_then(|root| {
                root.get("model_provider")
                    .and_then(toml::Value::as_str)
                    .and_then(|key| {
                        root.get("model_providers")?
                            .get(key)?
                            .get("base_url")?
                            .as_str()
                    })
            })
            .map(str::to_owned);
        let oauth = record.settings_config["auth"].get("tokens").is_some()
            || record.settings_config["auth"]["auth_mode"] == "chatgpt";
        (
            url,
            record.settings_config["auth"]["OPENAI_API_KEY"]
                .as_str()
                .is_some_and(|v| !v.is_empty()),
            "openai_responses".into(),
            if oauth {
                Some("oauth_import_unsupported")
            } else {
                None
            },
        )
    };
    let protocol_valid = if record.app_type == "claude" {
        ["anthropic", "openai_chat", "openai_responses"].contains(&protocol.as_str())
    } else {
        record.settings_config["config"]
            .as_str()
            .and_then(|text| toml::from_str::<toml::Table>(text).ok())
            .is_some_and(|root| {
                root.get("model_provider")
                    .and_then(toml::Value::as_str)
                    .and_then(|key| root.get("model_providers")?.get(key))
                    .is_some_and(|section| {
                        section
                            .get("wire_api")
                            .and_then(toml::Value::as_str)
                            .is_none_or(|v| v == "responses")
                    })
            })
    };
    let blocked = if protocol_valid {
        blocked
    } else {
        Some("unsupported_protocol")
    };
    let protocol = if protocol_valid {
        protocol
    } else {
        "unsupported".into()
    };
    let safe_endpoint = endpoint(url.as_deref());
    let blocked = blocked.or(if !credential {
        Some("missing_credential")
    } else if safe_endpoint.is_none() {
        Some("invalid_endpoint")
    } else {
        None
    });
    Candidate {
        candidate_id: index.to_string(),
        id: record.id.clone(),
        app_type: record.app_type.clone(),
        name: record.name.clone(),
        endpoint: safe_endpoint,
        protocol,
        credential: if credential { "available" } else { "missing" },
        conflict,
        blocked_reason: blocked,
    }
}

impl Plan {
    pub fn prepare(
        source: Source,
        target: &Path,
        mut environment: impl FnMut(&str) -> Option<String>,
    ) -> Result<Self> {
        crate::paths::validate_write_path(target, &crate::paths::cc_source_path()?)?;
        let mut stamps = BTreeMap::new();
        for path in source.paths() {
            crate::paths::ensure_distinct(target, path)?;
            for path in crate::snapshot::paths(path) {
                stamps.insert(path.clone(), stamp(&path)?);
            }
        }
        for path in crate::snapshot::paths(target) {
            stamps.insert(path.clone(), stamp(&path)?);
        }
        let mut env_stamps = BTreeMap::new();
        let scans = match &source {
            Source::CcSwitch { path } => sources::read_cc(path)?
                .into_iter()
                .map(Scan::Ready)
                .collect(),
            Source::Json { path } => sources::read_file(path)?
                .into_iter()
                .map(Scan::Ready)
                .collect(),
            Source::Claude { path } => vec![sources::user::claude(
                &fs::read(path).map_err(|_| anyhow::anyhow!("source_read_failed"))?,
            )],
            Source::Codex {
                config,
                auth,
                profile,
            } => {
                let config = fs::read(config).map_err(|_| anyhow::anyhow!("source_read_failed"))?;
                let auth = match fs::read(auth) {
                    Ok(bytes) => Some(bytes),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
                    Err(_) => bail!("source_read_failed"),
                };
                vec![sources::user::codex(
                    &config,
                    auth.as_deref(),
                    profile.as_deref(),
                    |key| {
                        let value = environment(key);
                        env_stamps.insert(key.into(), value.as_ref().map(|v| digest(v.as_bytes())));
                        value
                    },
                )]
            }
        };
        let existing: BTreeSet<_> = if target.exists() {
            store::list_providers(&crate::snapshot::open(target)?, None)?
                .into_iter()
                .map(|p| (p.app_type, p.id))
                .collect()
        } else {
            BTreeSet::new()
        };
        let mut records = Vec::new();
        let mut candidates = Vec::new();
        let mut blocked = Vec::new();
        let mut seen = BTreeSet::new();
        for scan in scans {
            match scan {
                Scan::Blocked(reason) => blocked.push(reason),
                Scan::Ready(record) => {
                    validate(&record)?;
                    if !seen.insert((record.app_type.clone(), record.id.clone())) {
                        bail!("duplicate_provider_identity");
                    }
                    candidates.push(project(
                        records.len(),
                        &record,
                        existing.contains(&(record.app_type.clone(), record.id.clone())),
                    ));
                    records.push(record);
                }
            }
        }
        let plan = Self {
            id: uuid::Uuid::new_v4().to_string(),
            source,
            target: target.to_owned(),
            stamps,
            environment: env_stamps,
            created: Instant::now(),
            records,
            candidates,
            blocked,
            selection: None,
        };
        plan.validate(environment)?;
        Ok(plan)
    }
    pub fn preview(&self) -> Preview {
        Preview {
            plan_id: self.id.clone(),
            source: self.source.label(),
            candidates: self.candidates.clone(),
            blocked: self.blocked.clone(),
        }
    }
    pub fn validate(&self, mut environment: impl FnMut(&str) -> Option<String>) -> Result<()> {
        if self.created.elapsed() > Duration::from_secs(300) {
            bail!("plan_expired");
        }
        for (path, before) in &self.stamps {
            if &stamp(path)? != before {
                bail!("plan_stale");
            }
        }
        for (name, before) in &self.environment {
            if &environment(name).as_ref().map(|v| digest(v.as_bytes())) != before {
                bail!("plan_stale");
            }
        }
        Ok(())
    }
    pub fn select(&mut self, selected: &[String], replace: bool) -> Result<Selection> {
        let mut indices = BTreeSet::new();
        let mut selection = Selection {
            added: 0,
            updated: 0,
            skipped: 0,
            selected: selected.to_vec(),
            replace,
        };
        for id in selected {
            let Some(candidate) = self.candidates.iter().find(|c| &c.candidate_id == id) else {
                bail!("invalid_candidate");
            };
            if !indices.insert(id) || candidate.blocked_reason.is_some() {
                bail!("invalid_candidate");
            }
            if candidate.conflict {
                if replace {
                    selection.updated += 1;
                } else {
                    selection.skipped += 1;
                }
            } else {
                selection.added += 1;
            }
        }
        self.selection = Some(selection.clone());
        Ok(selection)
    }
    /// Confirmation uses only the prepared selection; UI never returns secrets.
    pub fn selected_records(
        &self,
        selected: &[String],
        replace: bool,
        environment: impl FnMut(&str) -> Option<String>,
    ) -> Result<Vec<ImportProvider>> {
        self.validate(environment)?;
        let Some(selection) = &self.selection else {
            bail!("selection_not_confirmed");
        };
        if selection.selected != selected || selection.replace != replace {
            bail!("selection_changed");
        }
        Ok(self
            .candidates
            .iter()
            .zip(&self.records)
            .filter(|(candidate, _)| selected.contains(&candidate.candidate_id))
            .map(|(_, record)| record.clone())
            .collect())
    }
    pub fn apply(
        &self,
        selected: &[String],
        replace: bool,
        secrets: &dyn crate::credentials::SecretStore,
        environment: impl Fn(&str) -> Option<String>,
    ) -> Result<crate::commit::Outcome> {
        let records = self.selected_records(selected, replace, &environment)?;
        crate::commit::apply_checked(
            &self.target,
            &records,
            self.source_label(),
            replace,
            secrets,
            || self.validate(&environment),
            || self.validate_sources(&environment),
        )
    }
    fn validate_sources(&self, environment: impl Fn(&str) -> Option<String>) -> Result<()> {
        if self.created.elapsed() > Duration::from_secs(300) {
            bail!("plan_expired");
        }
        for path in self.source.paths() {
            for path in crate::snapshot::paths(path) {
                if self.stamps.get(&path) != Some(&stamp(&path)?) {
                    bail!("plan_stale");
                }
            }
        }
        for (name, before) in &self.environment {
            if &environment(name).as_ref().map(|v| digest(v.as_bytes())) != before {
                bail!("plan_stale");
            }
        }
        Ok(())
    }
    pub fn target(&self) -> &Path {
        &self.target
    }
    pub fn source_label(&self) -> &'static str {
        self.source.label()
    }
}
