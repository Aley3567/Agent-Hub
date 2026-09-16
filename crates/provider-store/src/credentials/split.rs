//! Separate known secrets without changing the runtime overlay contract.
use super::{CredentialError, Envelope, VERSION};
use crate::model::ImportProvider;
use serde_json::{Map, Value};

fn secret_key(key: &str) -> bool {
    let key = key.to_lowercase().replace('-', "_");
    [
        "auth",
        "authorization",
        "proxy_authorization",
        "apikey",
        "api_key",
        "token",
        "tokens",
        "password",
        "secret",
        "experimental_bearer_token",
    ]
    .contains(&key.as_str())
        || [
            "_api_key",
            "_auth_token",
            "_access_token",
            "_refresh_token",
            "_id_token",
            "_password",
        ]
        .iter()
        .any(|suffix| key.ends_with(suffix))
}
fn authenticated_url(value: &str) -> bool {
    value.split_once("://").is_some_and(|(_, tail)| {
        tail.split(['/', '?', '#'])
            .next()
            .is_some_and(|authority| authority.contains('@'))
    })
}
fn has_secret(value: &Value) -> bool {
    match value {
        Value::Object(object) => object
            .iter()
            .any(|(key, value)| secret_key(key) || has_secret(value)),
        Value::Array(items) => items.iter().any(has_secret),
        Value::String(value) => authenticated_url(value),
        _ => false,
    }
}
fn split(value: &Value) -> Result<(Value, Value), CredentialError> {
    let object = value.as_object().ok_or(CredentialError::Corrupt)?;
    let (mut public, mut secret) = (Map::new(), Map::new());
    for (key, value) in object {
        if secret_key(key) {
            secret.insert(key.clone(), value.clone());
        } else if key == "config" && value.is_string() {
            let parsed: toml::Table =
                toml::from_str(value.as_str().unwrap()).map_err(|_| CredentialError::Corrupt)?;
            let json = serde_json::to_value(parsed).map_err(|_| CredentialError::Corrupt)?;
            if has_secret(&json) {
                let (clean, _) = split(&json)?;
                let clean: toml::Table =
                    serde_json::from_value(clean).map_err(|_| CredentialError::Corrupt)?;
                public.insert(
                    key.clone(),
                    Value::String(toml::to_string(&clean).map_err(|_| CredentialError::Corrupt)?),
                );
                secret.insert(key.clone(), value.clone());
            } else {
                public.insert(key.clone(), value.clone());
            }
        } else if value.is_object() {
            let (clean, private) = split(value)?;
            public.insert(key.clone(), clean);
            if !private.as_object().unwrap().is_empty() {
                secret.insert(key.clone(), private);
            }
        } else if has_secret(value) {
            secret.insert(key.clone(), value.clone());
        } else {
            public.insert(key.clone(), value.clone());
        }
    }
    Ok((Value::Object(public), Value::Object(secret)))
}

pub fn separate(
    record: &ImportProvider,
    revision: i64,
) -> Result<(ImportProvider, Envelope), CredentialError> {
    let (settings, secret_settings) = split(&record.settings_config)?;
    let (meta, secret_meta) = split(&record.meta)?;
    let mut public = record.clone();
    public.settings_config = settings;
    public.meta = meta;
    Ok((
        public,
        Envelope {
            version: VERSION,
            app_type: record.app_type.clone(),
            provider_id: record.id.clone(),
            revision,
            settings: secret_settings,
            meta: secret_meta,
        },
    ))
}
pub fn contains_secrets(record: &ImportProvider) -> Result<bool, CredentialError> {
    let (_, payload) = separate(record, 1)?;
    Ok(!payload.settings.as_object().unwrap().is_empty()
        || !payload.meta.as_object().unwrap().is_empty())
}
