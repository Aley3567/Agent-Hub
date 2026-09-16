//! Pure scanners: never execute a credential helper or inspect ambient config.
use crate::model::ImportProvider;
use serde_json::{json, Map, Value};

pub enum Scan {
    Ready(ImportProvider),
    Blocked(&'static str),
}
fn provider(app: &str, settings: Value) -> ImportProvider {
    ImportProvider {
        id: format!("imported-{app}-user"),
        app_type: app.into(),
        name: format!(
            "{} user configuration",
            if app == "claude" { "Claude" } else { "Codex" }
        ),
        settings_config: settings,
        category: None,
        provider_type: None,
        sort_index: None,
        is_current: false,
        meta: json!({}),
    }
}
fn nonempty(value: Option<&Value>) -> Option<&str> {
    value
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
}

pub fn claude(bytes: &[u8]) -> Scan {
    let Ok(Value::Object(root)) = serde_json::from_slice(bytes) else {
        return Scan::Blocked("invalid_claude_settings");
    };
    let Some(env) = root.get("env").and_then(Value::as_object) else {
        return Scan::Blocked(if root.contains_key("apiKeyHelper") {
            "credential_helper_unsupported"
        } else {
            "missing_environment"
        });
    };
    if nonempty(env.get("ANTHROPIC_BASE_URL")).is_none() {
        return Scan::Blocked("missing_endpoint");
    }
    let credential = if nonempty(env.get("ANTHROPIC_AUTH_TOKEN")).is_some() {
        "ANTHROPIC_AUTH_TOKEN"
    } else if nonempty(env.get("ANTHROPIC_API_KEY")).is_some() {
        "ANTHROPIC_API_KEY"
    } else {
        return Scan::Blocked(if root.contains_key("apiKeyHelper") {
            "credential_helper_unsupported"
        } else {
            "missing_credential"
        });
    };
    let mut clean = Map::new();
    for (key, value) in env {
        let upper = key.to_ascii_uppercase();
        let slot = ["OPUS", "SONNET", "HAIKU", "FABLE"].iter().any(|tier| {
            ["", "_NAME", "_DESCRIPTION", "_SUPPORTED_CAPABILITIES"]
                .iter()
                .any(|suffix| upper == format!("ANTHROPIC_DEFAULT_{tier}_MODEL{suffix}"))
        });
        if key == credential
            || slot
            || [
                "ANTHROPIC_BASE_URL",
                "ANTHROPIC_MODEL",
                "HTTP_PROXY",
                "HTTPS_PROXY",
                "ALL_PROXY",
                "NO_PROXY",
            ]
            .contains(&upper.as_str())
        {
            if !value.is_string() {
                return Scan::Blocked("invalid_claude_environment");
            }
            clean.insert(key.clone(), value.clone());
        }
    }
    let mut settings = json!({"env": clean});
    for key in [
        "api_format",
        "apiFormat",
        "effortLevel",
        "transport",
        "claude1_capabilities",
    ] {
        if let Some(value) = root.get(key) {
            settings[key] = value.clone();
        }
    }
    let mut result = provider("claude", settings);
    if let Some(format) = root.get("api_format").or_else(|| root.get("apiFormat")) {
        if !["anthropic", "openai_chat", "openai_responses"]
            .contains(&format.as_str().unwrap_or(""))
        {
            return Scan::Blocked("unsupported_protocol");
        }
        result.meta["apiFormat"] = format.clone();
    }
    Scan::Ready(result)
}

pub fn codex(
    config: &[u8],
    auth: Option<&[u8]>,
    profile: Option<&str>,
    mut env: impl FnMut(&str) -> Option<String>,
) -> Scan {
    let Ok(text) = std::str::from_utf8(config) else {
        return Scan::Blocked("invalid_codex_config");
    };
    let Ok(mut root) = toml::from_str::<toml::Table>(text) else {
        return Scan::Blocked("invalid_codex_config");
    };
    let selected = profile.map(str::to_owned).or_else(|| {
        root.get("profile")
            .and_then(toml::Value::as_str)
            .map(str::to_owned)
    });
    if let Some(name) = selected {
        let Some(selected) = root
            .get("profiles")
            .and_then(toml::Value::as_table)
            .and_then(|p| p.get(&name))
            .and_then(toml::Value::as_table)
            .cloned()
        else {
            return Scan::Blocked("missing_profile");
        };
        for (key, value) in selected {
            root.insert(key, value);
        }
    }
    let Some(key) = root
        .get("model_provider")
        .and_then(toml::Value::as_str)
        .map(str::to_owned)
    else {
        return Scan::Blocked("missing_model_provider");
    };
    let Some(mut section) = root
        .get("model_providers")
        .and_then(toml::Value::as_table)
        .and_then(|p| p.get(&key))
        .and_then(toml::Value::as_table)
        .cloned()
    else {
        return Scan::Blocked("missing_provider_section");
    };
    if section.values().any(toml::Value::is_table) {
        return Scan::Blocked("unsupported_provider_fields");
    }
    if section
        .get("wire_api")
        .and_then(toml::Value::as_str)
        .is_some_and(|v| v != "responses")
    {
        return Scan::Blocked("unsupported_protocol");
    }
    if section
        .get("base_url")
        .and_then(toml::Value::as_str)
        .is_none_or(|v| v.trim().is_empty())
    {
        return Scan::Blocked("missing_endpoint");
    }
    let auth = match auth {
        Some(bytes) => match serde_json::from_slice::<Value>(bytes) {
            Ok(Value::Object(object)) => object,
            _ => return Scan::Blocked("invalid_codex_auth"),
        },
        None => Map::new(),
    };
    if auth.get("auth_mode").and_then(Value::as_str) == Some("chatgpt")
        || auth.contains_key("tokens")
    {
        return Scan::Blocked("oauth_import_unsupported");
    }
    let credential = if let Some(value) = section.remove("env_key") {
        let Some(name) = value
            .as_str()
            .filter(|n| !n.is_empty() && !n.contains(['\0', '=']))
        else {
            return Scan::Blocked("invalid_environment_reference");
        };
        match env(name).filter(|v| !v.trim().is_empty()) {
            Some(value) => value,
            None => return Scan::Blocked("missing_environment_credential"),
        }
    } else {
        let static_key = section
            .remove("experimental_bearer_token")
            .and_then(|v| v.as_str().map(str::to_owned))
            .filter(|v| !v.is_empty());
        let auth_key = nonempty(auth.get("OPENAI_API_KEY")).map(str::to_owned);
        if static_key.is_some() && auth_key.is_some() && static_key != auth_key {
            return Scan::Blocked("ambiguous_credential_sources");
        }
        match static_key.or(auth_key) {
            Some(key) => key,
            None if auth.get("auth_mode").and_then(Value::as_str) == Some("chatgpt")
                || auth.contains_key("tokens") =>
            {
                return Scan::Blocked("oauth_import_unsupported")
            }
            None => return Scan::Blocked("missing_credential"),
        }
    };
    section.remove("experimental_bearer_token");
    section.insert("requires_openai_auth".into(), toml::Value::Boolean(true));
    let mut config = toml::Table::new();
    for name in [
        "model",
        "model_reasoning_effort",
        "model_verbosity",
        "model_context_window",
        "model_auto_compact_token_limit",
    ] {
        if let Some(value) = root.get(name) {
            config.insert(name.into(), value.clone());
        }
    }
    config.insert("model_provider".into(), toml::Value::String(key.clone()));
    config.insert(
        "model_providers".into(),
        toml::Value::Table([(key, toml::Value::Table(section))].into_iter().collect()),
    );
    let Ok(config) = toml::to_string(&config) else {
        return Scan::Blocked("invalid_codex_config");
    };
    let mut result = provider(
        "codex",
        json!({"config": config, "auth": {"OPENAI_API_KEY": credential}}),
    );
    result.meta = json!({"apiFormat": "openai_responses"});
    Scan::Ready(result)
}
