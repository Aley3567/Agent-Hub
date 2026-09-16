//! Private credential payloads. Only references and stable error codes leave this module.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

pub mod split;

pub const SERVICE: &str = "claude-hub";
pub const VERSION: u32 = 1;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CredentialError {
    NotFound,
    Denied,
    Locked,
    Unavailable,
    Timeout,
    Corrupt,
    TooLarge,
}
impl CredentialError {
    pub fn code(self) -> &'static str {
        match self {
            Self::NotFound => "credential_missing",
            Self::Denied => "credential_denied",
            Self::Locked => "credential_locked",
            Self::Unavailable => "credential_unavailable",
            Self::Timeout => "credential_timeout",
            Self::Corrupt => "credential_corrupt",
            Self::TooLarge => "credential_too_large",
        }
    }
}
impl fmt::Display for CredentialError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for CredentialError {}

/// Immutable account names never overlap standalone UUID accounts.
pub fn valid_reference(reference: &str) -> bool {
    let Some(uuid) = reference.strip_prefix("provider/v1/") else {
        return false;
    };
    uuid.len() == 36
        && uuid.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
}

/// Backend-only: deliberately no Debug or public Serialize implementation.
#[derive(Deserialize)]
pub struct Envelope {
    pub version: u32,
    pub app_type: String,
    pub provider_id: String,
    pub revision: i64,
    pub settings: Value,
    pub meta: Value,
}

impl Envelope {
    pub fn decode(raw: &[u8], app: &str, id: &str, revision: i64) -> Result<Self, CredentialError> {
        let payload: Self = serde_json::from_slice(raw).map_err(|_| CredentialError::Corrupt)?;
        if payload.version != VERSION
            || payload.app_type != app
            || payload.provider_id != id
            || !["claude", "codex"].contains(&app)
            || revision < 1
            || payload.revision != revision
            || !payload.settings.is_object()
            || !payload.meta.is_object()
        {
            return Err(CredentialError::Corrupt);
        }
        Ok(payload)
    }

    /// Explicit serialization for the OS store, never an IPC response.
    pub fn encode(&self) -> Result<Vec<u8>, CredentialError> {
        #[derive(Serialize)]
        struct Wire<'a> {
            version: u32,
            app_type: &'a str,
            provider_id: &'a str,
            revision: i64,
            settings: &'a Value,
            meta: &'a Value,
        }
        serde_json::to_vec(&Wire {
            version: self.version,
            app_type: &self.app_type,
            provider_id: &self.provider_id,
            revision: self.revision,
            settings: &self.settings,
            meta: &self.meta,
        })
        .map_err(|_| CredentialError::Corrupt)
    }
}

pub trait SecretStore {
    fn read(&self, reference: &str) -> Result<Vec<u8>, CredentialError>;
    /// Create only. Updating an existing reference is forbidden.
    fn create(&self, reference: &str, payload: &[u8]) -> Result<(), CredentialError>;
    fn delete(&self, reference: &str) -> Result<(), CredentialError>;
}

/// Merge only into fresh runtime objects; callers retain their persisted objects.
pub fn overlay(target: &mut Value, secret: &Value) {
    if let (Some(target), Some(secret)) = (target.as_object_mut(), secret.as_object()) {
        for (key, value) in secret {
            if value.is_object() && target.get(key).is_some_and(Value::is_object) {
                overlay(target.get_mut(key).unwrap(), value);
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_envelope_binds_application_identity_and_revision() {
        let raw = include_bytes!("../../../tests/fixtures/provider-credential-v1.json");
        let envelope = Envelope::decode(raw, "claude", "same-id", 2).unwrap();
        assert!(Envelope::decode(raw, "codex", "same-id", 2).is_err());
        assert!(Envelope::decode(raw, "claude", "other", 2).is_err());
        assert!(Envelope::decode(raw, "claude", "same-id", 3).is_err());
        let roundtrip =
            Envelope::decode(&envelope.encode().unwrap(), "claude", "same-id", 2).unwrap();
        assert_eq!(roundtrip.settings, envelope.settings);
    }
    #[test]
    fn provider_references_do_not_accept_standalone_accounts_or_arguments() {
        assert!(valid_reference(
            "provider/v1/00000000-0000-4000-8000-000000000001"
        ));
        for bad in [
            "00000000-0000-4000-8000-000000000001",
            "provider/v1/--help",
            "provider/v1/00000000-0000-4000-8000-00000000000A",
        ] {
            assert!(!valid_reference(bad));
        }
    }
}
