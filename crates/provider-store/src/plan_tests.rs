use crate::{
    plan::{Plan, Source},
    sources::user::{self, Scan},
};
use serde_json::json;
use std::{fs, path::PathBuf};

struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("hub-plan-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn claude() -> serde_json::Value {
    json!({"env": {"ANTHROPIC_AUTH_TOKEN": "fake-auth-token", "ANTHROPIC_API_KEY": "fake-other-key",
        "ANTHROPIC_BASE_URL": "https://example.test/private?token=hidden", "ANTHROPIC_MODEL": "fixture-model",
        "ANTHROPIC_DEFAULT_FABLE_MODEL": "fixture-fable", "UNRELATED_ENV": "excluded"},
        "hooks": {"command": "must-not-execute"}, "permissions": {"allow": ["all"]}})
}
fn config() -> &'static [u8] {
    b"model_provider='first'\nmodel='base'\n[model_providers.first]\nbase_url='https://first.test'\n[model_providers.selected]\nbase_url='https://selected.test'\nwire_api='responses'\nenv_key='EXACT_TEST_KEY'\n[profiles.chosen]\nmodel_provider='selected'\nmodel='profile-model'\nmodel_reasoning_effort='high'\n"
}

#[test]
fn claude_scanner_preserves_slots_and_auth_precedence_without_executing_helpers() {
    let Scan::Ready(record) = user::claude(&serde_json::to_vec(&claude()).unwrap()) else {
        panic!("expected ready")
    };
    assert_eq!(
        record.settings_config["env"]["ANTHROPIC_AUTH_TOKEN"],
        "fake-auth-token"
    );
    assert!(record.settings_config["env"]
        .get("ANTHROPIC_API_KEY")
        .is_none());
    assert_eq!(
        record.settings_config["env"]["ANTHROPIC_DEFAULT_FABLE_MODEL"],
        "fixture-fable"
    );
    assert!(record.settings_config.get("hooks").is_none());
    assert!(record.settings_config.get("permissions").is_none());
    assert!(record.settings_config["env"].get("UNRELATED_ENV").is_none());
    assert!(matches!(
        user::claude(br#"{"apiKeyHelper":"touch never-run"}"#),
        Scan::Blocked("credential_helper_unsupported")
    ));
}

#[test]
fn codex_scanner_uses_explicit_profile_and_exact_environment_reference() {
    let mut names = vec![];
    let Scan::Ready(record) = user::codex(config(), None, Some("chosen"), |name| {
        names.push(name.to_string());
        Some("fake-env-key".into())
    }) else {
        panic!("expected ready")
    };
    assert_eq!(names, ["EXACT_TEST_KEY"]);
    assert_eq!(
        record.settings_config["auth"]["OPENAI_API_KEY"],
        "fake-env-key"
    );
    let config: toml::Table =
        toml::from_str(record.settings_config["config"].as_str().unwrap()).unwrap();
    assert_eq!(config["model"].as_str(), Some("profile-model"));
    assert_eq!(config["model_provider"].as_str(), Some("selected"));
    assert_eq!(config["model_providers"].as_table().unwrap().len(), 1);
    assert!(config.get("profiles").is_none());
    assert!(config["model_providers"]["selected"]
        .get("env_key")
        .is_none());
    assert!(matches!(
        user::codex(
            config_string().as_bytes(),
            Some(br#"{"tokens":{}}"#),
            None,
            |_| None
        ),
        Scan::Blocked("oauth_import_unsupported")
    ));
    assert!(matches!(
        user::codex(crate::plan_tests::config(), None, Some("missing"), |_| None),
        Scan::Blocked("missing_profile")
    ));
}
fn config_string() -> String {
    "model_provider='first'\n[model_providers.first]\nbase_url='https://first.test'\n".into()
}

#[test]
fn preview_has_no_target_side_effect_or_secret_and_rejects_stale_source() {
    let temp = Temp::new();
    let source = temp.0.join("settings.json");
    let target = temp.0.join("missing").join("providers.db");
    let bytes = serde_json::to_vec(&claude()).unwrap();
    fs::write(&source, &bytes).unwrap();
    let mut plan = Plan::prepare(
        Source::Claude {
            path: source.clone(),
        },
        &target,
        |_| None,
    )
    .unwrap();
    let preview = serde_json::to_string(&plan.preview()).unwrap();
    assert!(!preview.contains("fake-auth-token"));
    assert!(!preview.contains("fake-other-key"));
    assert!(!preview.contains("private?"));
    assert!(!target.parent().unwrap().exists());
    assert_eq!(fs::read(&source).unwrap(), bytes);
    let selected = vec!["0".into()];
    assert_eq!(plan.select(&selected, false).unwrap().added, 1);
    assert_eq!(
        plan.selected_records(&selected, false, |_| None)
            .unwrap()
            .len(),
        1
    );
    assert!(plan.selected_records(&[], false, |_| None).is_err());
    fs::write(&source, b"{}").unwrap();
    assert_eq!(
        plan.validate(|_| None).unwrap_err().to_string(),
        "plan_stale"
    );
}

#[test]
fn environment_and_target_changes_invalidate_confirmed_plan() {
    let temp = Temp::new();
    let config_path = temp.0.join("config.toml");
    let auth = temp.0.join("auth.json");
    let target = temp.0.join("providers.db");
    fs::write(&config_path, config()).unwrap();
    let plan = Plan::prepare(
        Source::Codex {
            config: config_path,
            auth,
            profile: Some("chosen".into()),
        },
        &target,
        |_| Some("fake-first-key".into()),
    )
    .unwrap();
    assert_eq!(
        plan.validate(|_| Some("fake-rotated-key".into()))
            .unwrap_err()
            .to_string(),
        "plan_stale"
    );
    let conn = crate::open(&target).unwrap();
    drop(conn);
    assert_eq!(
        plan.validate(|_| Some("fake-first-key".into()))
            .unwrap_err()
            .to_string(),
        "plan_stale"
    );
}

#[test]
fn same_id_across_apps_and_explicit_replace_counts_are_preserved() {
    let temp = Temp::new();
    let source = temp.0.join("import.json");
    let target = temp.0.join("providers.db");
    let doc = json!({"version":1,"providers":[
        {"id":"same","app_type":"claude","name":"Claude","settings_config":claude()},
        {"id":"same","app_type":"codex","name":"Codex","settings_config":{"config":config_string(),"auth":{"OPENAI_API_KEY":"fake-key"}}}
    ]});
    fs::write(&source, serde_json::to_vec(&doc).unwrap()).unwrap();
    let records = crate::read_file(&source).unwrap();
    let mut conn = crate::open(&target).unwrap();
    crate::import(&mut conn, &records[..1], "fixture", false, false).unwrap();
    drop(conn);
    let mut plan = Plan::prepare(Source::Json { path: source }, &target, |_| None).unwrap();
    let selected = vec!["0".into(), "1".into()];
    let counts = plan.select(&selected, false).unwrap();
    assert_eq!((counts.added, counts.skipped), (1, 1));
    let counts = plan.select(&selected, true).unwrap();
    assert_eq!((counts.added, counts.updated), (1, 1));
}

#[test]
fn malformed_sources_report_codes_without_parser_secret_snippets() {
    assert!(matches!(
        user::codex(b"secret = \"fake-key\n", None, None, |_| None),
        Scan::Blocked("invalid_codex_config")
    ));
    assert!(matches!(
        user::claude(b"fake-token-invalid-json"),
        Scan::Blocked("invalid_claude_settings")
    ));
}

#[test]
fn oauth_with_api_key_is_never_downgraded() {
    assert!(matches!(
        user::codex(
            config_string().as_bytes(),
            Some(br#"{"auth_mode":"chatgpt","OPENAI_API_KEY":"fake-key","tokens":{}}"#),
            None,
            |_| None
        ),
        Scan::Blocked("oauth_import_unsupported")
    ));
}

#[test]
fn file_sources_cannot_bypass_protocol_validation() {
    let temp = Temp::new();
    let source = temp.0.join("providers.json");
    for (app, settings) in [
        (
            "claude",
            json!({"env":{"ANTHROPIC_AUTH_TOKEN":"fake-key","ANTHROPIC_BASE_URL":"https://example.test"},"apiFormat":"unknown-secret-format"}),
        ),
        (
            "codex",
            json!({"auth":{"OPENAI_API_KEY":"fake-key"},"config":"model_provider='p'\n[model_providers.p]\nbase_url='https://example.test'\nwire_api='chat'\n"}),
        ),
    ] {
        fs::write(&source, serde_json::to_vec(&json!({"version":1,"providers":[{"id":"p","app_type":app,"name":"P","settings_config":settings}]})).unwrap()).unwrap();
        let plan = Plan::prepare(
            Source::Json {
                path: source.clone(),
            },
            &temp.0.join("absent.db"),
            |_| None,
        )
        .unwrap();
        assert_eq!(
            plan.preview().candidates[0].blocked_reason,
            Some("unsupported_protocol")
        );
        assert!(!serde_json::to_string(&plan.preview())
            .unwrap()
            .contains("unknown-secret-format"));
    }
}

#[test]
fn wal_preview_reads_committed_pages_without_creating_or_modifying_sidecars() {
    let temp = Temp::new();
    let source = temp.0.join("source.db");
    let mut conn = crate::open(&source).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    let record = crate::custom(
        "p".into(),
        "claude".into(),
        "P".into(),
        "https://example.test",
        "fake-secret",
        "model",
        "anthropic",
    )
    .unwrap();
    crate::import(&mut conn, &[record], "fixture", false, false).unwrap();
    let snapshot = || -> std::collections::BTreeMap<PathBuf, Vec<u8>> {
        fs::read_dir(&temp.0)
            .unwrap()
            .map(|e| {
                let p = e.unwrap().path();
                let b = fs::read(&p).unwrap();
                (p, b)
            })
            .collect()
    };
    let before = snapshot();
    let preview = Plan::prepare(
        Source::CcSwitch {
            path: source.clone(),
        },
        &temp.0.join("absent.db"),
        |_| None,
    )
    .unwrap()
    .preview();
    assert_eq!(preview.candidates.len(), 1);
    assert_eq!(before, snapshot());
    drop(conn);
    let before = snapshot();
    let preview = Plan::prepare(
        Source::CcSwitch { path: source },
        &temp.0.join("absent.db"),
        |_| None,
    )
    .unwrap()
    .preview();
    assert_eq!(preview.candidates.len(), 1);
    assert_eq!(before, snapshot());
}

#[test]
fn persist_preview_accepts_committed_zero_header_journal_without_source_changes() {
    let temp = Temp::new();
    let source = temp.0.join("persist.db");
    let mut conn = crate::open(&source).unwrap();
    conn.pragma_update(None, "journal_mode", "PERSIST").unwrap();
    let record = crate::custom(
        "persist".into(),
        "claude".into(),
        "Persist".into(),
        "https://example.test",
        "fake-persist-secret",
        "model",
        "anthropic",
    )
    .unwrap();
    crate::import(&mut conn, &[record], "fixture", false, false).unwrap();
    let journal = temp.0.join("persist.db-journal");
    let before_db = fs::read(&source).unwrap();
    let before_journal = fs::read(&journal).unwrap();
    assert!(before_journal.len() > 512);
    assert_eq!(&before_journal[..28], &[0; 28]);
    assert_eq!(
        conn.query_row("SELECT count(*) FROM providers", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
    let preview = Plan::prepare(
        Source::CcSwitch {
            path: source.clone(),
        },
        &temp.0.join("absent.db"),
        |_| None,
    )
    .unwrap()
    .preview();
    assert_eq!(preview.candidates.len(), 1);
    assert_eq!(fs::read(&source).unwrap(), before_db);
    assert_eq!(fs::read(&journal).unwrap(), before_journal);
    assert!(!temp.0.join("absent.db").exists());
}
