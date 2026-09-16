//! Backend-owned forms: IPC responses contain only the safe preview projection.
use crate::{
    commit,
    credentials::{overlay, Envelope, SecretStore},
    migration,
    model::ImportProvider,
    plan,
};
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Input {
    pub app_type: String,
    pub id: String,
    pub name: String,
    pub expected_revision: Option<i64>,
    pub endpoint: Option<String>,
    pub model: Option<String>,
    pub protocol: Option<String>,
    pub secret: Option<String>,
    #[serde(default)]
    pub clear_secret: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub provider: plan::Candidate,
    pub revision: i64,
    pub model: Option<String>,
}
pub fn view(path: &Path, app: &str, id: &str) -> Result<View> {
    let conn = crate::snapshot::open(path)?;
    let row = migration::records(&conn)?
        .into_iter()
        .find(|r| r.record.app_type == app && r.record.id == id)
        .ok_or_else(|| anyhow::anyhow!("provider_not_found"))?;
    let mut provider = plan::project(0, &row.record, true);
    if row.reference.is_some() {
        provider.credential = "referenced";
        provider.blocked_reason = None;
    }
    let model = if app == "claude" {
        row.record.settings_config["env"]["ANTHROPIC_MODEL"]
            .as_str()
            .map(str::to_owned)
    } else {
        row.record.settings_config["config"]
            .as_str()
            .and_then(|s| toml::from_str::<toml::Table>(s).ok())
            .and_then(|v| {
                v.get("model")
                    .and_then(toml::Value::as_str)
                    .map(str::to_owned)
            })
    };
    Ok(View {
        provider,
        revision: row.revision,
        model,
    })
}
fn update(record: &mut ImportProvider, input: &Input) -> Result<()> {
    record.name = input.name.clone();
    if input.app_type == "claude" {
        if !record.settings_config["env"].is_object() {
            record.settings_config["env"] = json!({});
        }
        let env = record.settings_config["env"].as_object_mut().unwrap();
        if let Some(url) = &input.endpoint {
            env.insert("ANTHROPIC_BASE_URL".into(), json!(url));
        }
        if let Some(model) = &input.model {
            env.insert("ANTHROPIC_MODEL".into(), json!(model));
        }
        if input.secret.is_some() || input.clear_secret {
            env.remove("ANTHROPIC_AUTH_TOKEN");
            env.remove("ANTHROPIC_API_KEY");
            if let Some(key) = &input.secret {
                env.insert("ANTHROPIC_AUTH_TOKEN".into(), json!(key));
            }
        }
        if let Some(protocol) = &input.protocol {
            record.meta["apiFormat"] = json!(protocol);
            record.settings_config["apiFormat"] = json!(protocol);
        }
    } else if input.model.is_some()
        || input.endpoint.is_some()
        || input.secret.is_some()
        || input.clear_secret
    {
        let mut config =
            toml::from_str::<toml::Table>(record.settings_config["config"].as_str().unwrap_or(""))
                .map_err(|_| anyhow::anyhow!("invalid_provider_config"))?;
        let key = config
            .get("model_provider")
            .and_then(toml::Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("invalid_provider_config"))?
            .to_owned();
        if let Some(model) = &input.model {
            config.insert("model".into(), toml::Value::String(model.clone()));
        }
        let section = config
            .get_mut("model_providers")
            .and_then(toml::Value::as_table_mut)
            .and_then(|v| v.get_mut(&key))
            .and_then(toml::Value::as_table_mut)
            .ok_or_else(|| anyhow::anyhow!("invalid_provider_config"))?;
        if let Some(url) = &input.endpoint {
            section.insert("base_url".into(), toml::Value::String(url.clone()));
        }
        if input.secret.is_some() || input.clear_secret {
            section.remove("experimental_bearer_token");
            section.remove("env_key");
            record.settings_config["auth"] = input
                .secret
                .as_ref()
                .map(|key| json!({"OPENAI_API_KEY":key}))
                .unwrap_or(json!({}));
        }
        record.settings_config["config"] = json!(
            toml::to_string(&config).map_err(|_| anyhow::anyhow!("invalid_provider_config"))?
        );
    }
    Ok(())
}
pub fn save(path: &Path, input: Input, secrets: &dyn SecretStore) -> Result<commit::Outcome> {
    if !["claude", "codex"].contains(&input.app_type.as_str())
        || input.name.trim().is_empty()
        || input.id.trim().is_empty()
    {
        bail!("invalid_provider_identity");
    }
    if input.secret.is_some() && input.clear_secret {
        bail!("invalid_secret_action");
    }
    if input.secret.as_ref().is_some_and(|v| v.trim().is_empty()) {
        bail!("invalid_secret");
    }
    if input
        .endpoint
        .as_ref()
        .is_some_and(|v| !(v.starts_with("https://") || v.starts_with("http://")))
    {
        bail!("invalid_endpoint");
    }
    if input.protocol.as_ref().is_some_and(|v| {
        !["anthropic", "openai_chat", "openai_responses"].contains(&v.as_str())
            || (input.app_type == "codex" && v != "openai_responses")
    }) {
        bail!("unsupported_protocol");
    }
    let before = if path.exists() {
        Some(crate::snapshot::open(path)?)
    } else {
        None
    };
    let baseline = before
        .as_ref()
        .map(commit::revision)
        .transpose()?
        .unwrap_or_default();
    let old = before
        .as_ref()
        .map(migration::records)
        .transpose()?
        .unwrap_or_default()
        .into_iter()
        .find(|r| r.record.app_type == input.app_type && r.record.id == input.id);
    if old.as_ref().map(|r| r.revision) != input.expected_revision {
        bail!("provider_revision_conflict");
    }
    let exists = old.is_some();
    let mut record = if let Some(row) = old {
        let mut probe = row.record.clone();
        update(&mut probe, &input)?;
        if input.secret.is_none()
            && !input.clear_secret
            && probe.name == row.record.name
            && probe.settings_config == row.record.settings_config
            && probe.meta == row.record.meta
        {
            return Ok(commit::Outcome {
                skipped: 1,
                ..Default::default()
            });
        }
        let mut record = row.record;
        if let Some(reference) = row.reference {
            record = crate::credentials::split::separate(&record, row.revision)?.0;
            if row.version != Some(1) {
                bail!("credential_corrupt");
            }
            let payload = Envelope::decode(
                &secrets.read(&reference)?,
                &record.app_type,
                &record.id,
                row.revision,
            )?;
            overlay(&mut record.settings_config, &payload.settings);
            overlay(&mut record.meta, &payload.meta);
        }
        record
    } else {
        crate::custom(
            input.id.clone(),
            input.app_type.clone(),
            input.name.clone(),
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
            input
                .protocol
                .as_deref()
                .unwrap_or(if input.app_type == "codex" {
                    "openai_responses"
                } else {
                    "anthropic"
                }),
        )?
    };
    update(&mut record, &input)?;
    commit::apply_checked(
        path,
        &[record],
        "manual",
        exists,
        secrets,
        || {
            let now = if path.exists() {
                commit::revision(&crate::snapshot::open(path)?)?
            } else {
                Vec::new()
            };
            if now != baseline {
                bail!("provider_revision_conflict");
            }
            Ok(())
        },
        || Ok(()),
    )
}
