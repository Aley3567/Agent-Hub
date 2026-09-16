//! Provider data contracts. Import records contain secrets and stay backend-only.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

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

#[derive(Deserialize)]
pub struct ImportDocument {
    pub version: u32,
    pub providers: Vec<ImportProvider>,
}
#[derive(Clone, Deserialize)]
pub struct ImportProvider {
    pub id: String,
    pub app_type: String,
    pub name: String,
    pub settings_config: Value,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub provider_type: Option<String>,
    #[serde(default)]
    pub sort_index: Option<i64>,
    #[serde(default)]
    pub is_current: bool,
    #[serde(default = "empty_object")]
    pub meta: Value,
}
fn empty_object() -> Value {
    json!({})
}

pub(crate) fn validate(p: &ImportProvider) -> Result<()> {
    if p.id.trim().is_empty()
        || p.name.trim().is_empty()
        || !["claude", "codex"].contains(&p.app_type.as_str())
    {
        bail!("provider requires id, name and app_type (claude/codex)");
    }
    if !p.settings_config.is_object() || !p.meta.is_object() {
        bail!("provider configuration must be an object");
    }
    Ok(())
}

pub fn custom(
    id: String,
    app: String,
    name: String,
    url: &str,
    key: &str,
    model: &str,
    protocol: &str,
) -> Result<ImportProvider> {
    if !(url.starts_with("https://") || url.starts_with("http://"))
        || key.trim().is_empty()
        || model.trim().is_empty()
    {
        bail!("URL, API key and model are required");
    }
    if !["anthropic", "openai_chat", "openai_responses"].contains(&protocol) {
        bail!("unsupported protocol");
    }
    let settings_config = if app == "codex" {
        if protocol != "openai_responses" {
            bail!("Codex providers require openai_responses");
        }
        json!({"auth":{"OPENAI_API_KEY":key}, "config":format!("model = {}\nmodel_provider = \"agent_hub\"\n[model_providers.agent_hub]\nname = \"Agent Hub\"\nbase_url = {}\nwire_api = \"responses\"\nrequires_openai_auth = true\n",serde_json::to_string(model)?,serde_json::to_string(url)?)})
    } else {
        json!({"env":{"ANTHROPIC_BASE_URL":url,"ANTHROPIC_AUTH_TOKEN":key,"ANTHROPIC_MODEL":model,"ANTHROPIC_DEFAULT_OPUS_MODEL":model,"ANTHROPIC_DEFAULT_SONNET_MODEL":model,"ANTHROPIC_DEFAULT_HAIKU_MODEL":model},"apiFormat":protocol})
    };
    let p = ImportProvider {
        id,
        app_type: app,
        name,
        settings_config,
        category: None,
        provider_type: None,
        sort_index: None,
        is_current: false,
        meta: json!({"apiFormat":protocol}),
    };
    validate(&p)?;
    Ok(p)
}
