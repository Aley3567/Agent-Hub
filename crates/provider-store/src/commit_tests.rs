use crate::{
    commit,
    credentials::{CredentialError, Envelope, SecretStore},
    custom,
};
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    fs,
    path::PathBuf,
};

#[derive(Default)]
struct Memory {
    values: RefCell<HashMap<String, Vec<u8>>>,
    creates: Cell<usize>,
    reads: Cell<usize>,
    deletes: Cell<usize>,
    fail_create: Cell<usize>,
    deny_delete: Cell<bool>,
    corrupt_read: Cell<bool>,
    crash_create: Cell<bool>,
    after_create: RefCell<Option<Box<dyn Fn()>>>,
}
impl SecretStore for Memory {
    fn create(&self, key: &str, value: &[u8]) -> Result<(), CredentialError> {
        self.creates.set(self.creates.get() + 1);
        if self.creates.get() == self.fail_create.get() {
            return Err(CredentialError::Denied);
        }
        assert!(!self.values.borrow().contains_key(key));
        self.values.borrow_mut().insert(key.into(), value.into());
        if let Some(f) = self.after_create.borrow_mut().take() {
            f();
        }
        assert!(
            !self.crash_create.get(),
            "simulated process interruption after OS create"
        );
        Ok(())
    }
    fn read(&self, key: &str) -> Result<Vec<u8>, CredentialError> {
        self.reads.set(self.reads.get() + 1);
        if self.corrupt_read.get() {
            return Ok(b"corrupt".to_vec());
        }
        self.values
            .borrow()
            .get(key)
            .cloned()
            .ok_or(CredentialError::NotFound)
    }
    fn delete(&self, key: &str) -> Result<(), CredentialError> {
        self.deletes.set(self.deletes.get() + 1);
        if self.deny_delete.get() {
            return Err(CredentialError::Denied);
        }
        self.values
            .borrow_mut()
            .remove(key)
            .map(|_| ())
            .ok_or(CredentialError::NotFound)
    }
}
struct Temp(PathBuf);
impl Temp {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!("hub-commit-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn db(&self) -> PathBuf {
        self.0.join("providers.db")
    }
}
impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn record(id: &str) -> crate::ImportProvider {
    custom(
        id.into(),
        "claude".into(),
        "Fixture".into(),
        "https://example.test",
        "fake-secret-marker",
        "model",
        "anthropic",
    )
    .unwrap()
}

#[test]
fn legacy_import_advances_revision_and_stale_editor_cannot_overwrite() {
    let t = Temp::new();
    let mut conn = crate::open(&t.db()).unwrap();
    crate::import(&mut conn, &[record("p")], "fixture", false, false).unwrap();
    let first = crate::edit::view(&t.db(), "claude", "p").unwrap().revision;
    let mut changed = record("p");
    changed.name = "Changed elsewhere".into();
    crate::import(&mut conn, &[changed], "fixture", true, false).unwrap();
    let second = crate::edit::view(&t.db(), "claude", "p").unwrap().revision;
    assert!(second > first, "legacy writes must invalidate editor revisions");
}
fn reference(path: &std::path::Path) -> String {
    crate::open_readonly(path)
        .unwrap()
        .query_row("SELECT credential_ref FROM providers LIMIT 1", [], |r| {
            r.get(0)
        })
        .unwrap()
}

#[test]
fn immutable_versions_commit_metadata_only_and_skip_without_os_calls() {
    let t = Temp::new();
    let m = Memory::default();
    let p = record("p");
    assert_eq!(
        commit::apply(&t.db(), &[p.clone()], "test", false, &m)
            .unwrap()
            .added,
        1
    );
    let first = reference(&t.db());
    let secret = m.values.borrow()[&first].clone();
    Envelope::decode(&secret, "claude", "p", 1).unwrap();
    let conn = crate::open_readonly(&t.db()).unwrap();
    let settings: String = conn
        .query_row("SELECT settings_config FROM providers", [], |r| r.get(0))
        .unwrap();
    assert!(!settings.contains("fake-secret-marker"));
    assert!(!fs::read(t.db())
        .unwrap()
        .windows(b"fake-secret-marker".len())
        .any(|b| b == b"fake-secret-marker"));
    assert_eq!(
        commit::apply(&t.db(), &[p.clone()], "test", false, &m)
            .unwrap()
            .skipped,
        1
    );
    assert_eq!((m.creates.get(), m.reads.get(), m.deletes.get()), (1, 1, 0));
    assert_eq!(
        commit::apply(&t.db(), &[p], "test", true, &m)
            .unwrap()
            .updated,
        1
    );
    assert_ne!(reference(&t.db()), first);
    assert!(!m.values.borrow().contains_key(&first));
}
#[test]
fn batch_failure_preserves_old_versions_and_reports_cleanup_debt() {
    let t = Temp::new();
    let m = Memory::default();
    commit::apply(&t.db(), &[record("old")], "test", false, &m).unwrap();
    let old = reference(&t.db());
    m.fail_create.set(3);
    m.deny_delete.set(true);
    let error = commit::apply(&t.db(), &[record("old"), record("new")], "test", true, &m)
        .err()
        .unwrap()
        .to_string();
    assert_eq!(error, "credential_denied: not_applied_cleanup_pending");
    assert_eq!(reference(&t.db()), old);
    m.deny_delete.set(false);
    assert_eq!(commit::recover(&t.db(), &m).unwrap(), 0);
    assert_eq!(m.values.borrow().len(), 1);
    assert!(m.values.borrow().contains_key(&old));
}
#[test]
fn sql_failure_is_atomic_and_does_not_expose_trigger_payload() {
    let t = Temp::new();
    let m = Memory::default();
    let conn = crate::open(&t.db()).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_second BEFORE INSERT ON provider_sources WHEN new.id='second' BEGIN SELECT RAISE(ABORT,'fake-secret-error'); END").unwrap();
    let err = commit::apply(
        &t.db(),
        &[record("first"), record("second")],
        "test",
        false,
        &m,
    )
    .err()
    .unwrap()
    .to_string();
    assert_eq!(err, "provider_commit_failed");
    assert_eq!(
        conn.query_row("SELECT count(*) FROM providers", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert!(m.values.borrow().is_empty());
}
#[test]
fn crash_intents_recover_and_post_commit_cleanup_failure_stays_applied() {
    let t = Temp::new();
    let m = Memory::default();
    m.crash_create.set(true);
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| commit::apply(
            &t.db(),
            &[record("p")],
            "test",
            false,
            &m
        )))
        .is_err()
    );
    assert_eq!(m.values.borrow().len(), 1);
    m.crash_create.set(false);
    assert_eq!(commit::recover(&t.db(), &m).unwrap(), 0);
    assert!(m.values.borrow().is_empty());
    commit::apply(&t.db(), &[record("p")], "test", false, &m).unwrap();
    let old = reference(&t.db());
    m.deny_delete.set(true);
    let result = commit::apply(&t.db(), &[record("p")], "test", true, &m).unwrap();
    assert_eq!((result.updated, result.pending_cleanup), (1, 1));
    assert_ne!(reference(&t.db()), old);
    m.deny_delete.set(false);
    assert_eq!(commit::recover(&t.db(), &m).unwrap(), 0);
}
#[test]
fn revision_conflict_cannot_overwrite_concurrent_metadata_edit() {
    let t = Temp::new();
    let m = Memory::default();
    commit::apply(&t.db(), &[record("p")], "test", false, &m).unwrap();
    let path = t.db();
    *m.after_create.borrow_mut() = Some(Box::new(move || {
        crate::open(&path)
            .unwrap()
            .execute("UPDATE providers SET name='concurrent'", [])
            .unwrap();
    }));
    assert_eq!(
        commit::apply(&t.db(), &[record("p")], "test", true, &m)
            .err()
            .unwrap()
            .to_string(),
        "provider_revision_conflict"
    );
    assert_eq!(m.values.borrow().len(), 1);
}
#[test]
fn mismatched_readback_never_commits_and_parallel_writer_is_rejected() {
    let t = Temp::new();
    let m = Memory::default();
    m.corrupt_read.set(true);
    assert_eq!(
        commit::apply(&t.db(), &[record("p")], "test", false, &m)
            .err()
            .unwrap()
            .to_string(),
        "credential_corrupt"
    );
    assert!(m.values.borrow().is_empty());
    let _guard = commit::WriterLock::acquire(&t.db()).unwrap();
    assert!(commit::apply(&t.db(), &[record("p")], "test", false, &m).is_err());
}
#[test]
fn nested_proxy_and_oauth_toml_secrets_roundtrip_without_public_leaks() {
    let mut p = record("p");
    p.app_type = "codex".into();
    p.settings_config = serde_json::json!({"auth":{"tokens":{"access_token":"fake-oauth"}},"config":"model_provider='p'\n[model_providers.p]\nbase_url='https://example.test'\nexperimental_bearer_token='fake-bearer'\n","transport":{"proxies":["http://user:fake-proxy@localhost:7890"]}}); // secret-guard: allow embedded-url-credential
    let (public, envelope) = crate::credentials::split::separate(&p, 1).unwrap();
    let text = public.settings_config.to_string();
    for secret in ["fake-oauth", "fake-bearer", "fake-proxy"] {
        assert!(!text.contains(secret));
    }
    let mut runtime = public.settings_config;
    crate::credentials::overlay(&mut runtime, &envelope.settings);
    assert_eq!(runtime, p.settings_config);
}

#[test]
fn legacy_writers_cannot_replace_or_delete_referenced_records() {
    let t = Temp::new();
    let m = Memory::default();
    let p = record("p");
    commit::apply(&t.db(), &[p.clone()], "test", false, &m).unwrap();
    let mut conn = crate::open(&t.db()).unwrap();
    assert_eq!(
        crate::import(&mut conn, &[p], "legacy", true, false)
            .unwrap_err()
            .to_string(),
        "credential_store_required"
    );
    assert_eq!(
        crate::remove(&mut conn, "p", "claude")
            .unwrap_err()
            .to_string(),
        "credential_store_required"
    );
    assert_eq!(m.values.borrow().len(), 1);
}

#[test]
fn invalid_revision_and_intent_errors_are_rejected_before_os_calls() {
    let t = Temp::new();
    let m = Memory::default();
    let mut conn = crate::open(&t.db()).unwrap();
    crate::import(&mut conn, &[record("p")], "old", false, false).unwrap();
    conn.execute("UPDATE providers SET revision=-1", [])
        .unwrap();
    assert_eq!(
        commit::apply(&t.db(), &[record("p")], "test", true, &m)
            .err()
            .unwrap()
            .to_string(),
        "invalid_revision"
    );
    conn.execute("UPDATE providers SET revision=0", []).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_intent BEFORE INSERT ON credential_operations BEGIN SELECT RAISE(ABORT,'fake-secret-error'); END").unwrap();
    assert_eq!(
        commit::apply(&t.db(), &[record("p")], "test", true, &m)
            .err()
            .unwrap()
            .to_string(),
        "provider_commit_failed"
    );
    assert_eq!(m.creates.get(), 0);
}

#[test]
fn explicit_migration_is_idempotent_and_cleans_active_database_not_backups() {
    let t = Temp::new();
    let m = Memory::default();
    let mut conn = crate::open(&t.db()).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    crate::import(&mut conn, &[record("p")], "old", false, false).unwrap();
    let backup = t.0.join("history.db");
    conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
        .unwrap();
    fs::copy(t.db(), &backup).unwrap();
    let original = fs::read(&backup).unwrap();
    assert_eq!(crate::migration::status(&t.db()).unwrap().legacy, 1);
    let result = crate::migration::migrate(&t.db(), &m).unwrap();
    assert_eq!(result.applied.updated, 1);
    assert!(!result.storage_cleanup_pending);
    assert_eq!(crate::migration::status(&t.db()).unwrap().referenced, 1);
    for path in [t.db(), t.0.join("providers.db-wal")] {
        let bytes = fs::read(path).unwrap_or_default();
        assert!(!bytes
            .windows(b"fake-secret-marker".len())
            .any(|b| b == b"fake-secret-marker"));
    }
    assert_eq!(fs::read(backup).unwrap(), original);
    let calls = (m.creates.get(), m.reads.get(), m.deletes.get());
    assert_eq!(
        crate::migration::migrate(&t.db(), &m)
            .unwrap()
            .applied
            .skipped,
        1
    );
    assert_eq!((m.creates.get(), m.reads.get(), m.deletes.get()), calls);
}

#[test]
fn confirmed_plan_rechecks_source_after_os_write_and_rolls_back() {
    let t = Temp::new();
    let m = Memory::default();
    let source = t.0.join("settings.json");
    fs::write(&source, record("p").settings_config.to_string()).unwrap();
    let mut plan = crate::plan::Plan::prepare(
        crate::plan::Source::Claude {
            path: source.clone(),
        },
        &t.db(),
        |_| None,
    )
    .unwrap();
    let selected = vec!["0".to_string()];
    plan.select(&selected, false).unwrap();
    *m.after_create.borrow_mut() = Some(Box::new(move || {
        fs::write(&source, "{}").unwrap();
    }));
    assert_eq!(
        plan.apply(&selected, false, &m, |_| None)
            .err()
            .unwrap()
            .to_string(),
        "plan_stale"
    );
    assert!(m.values.borrow().is_empty());
    assert_eq!(
        crate::list_providers(&crate::open_readonly(&t.db()).unwrap(), None)
            .unwrap()
            .len(),
        0
    );
}

#[test]
fn delete_blocks_hub_and_pool_references_but_not_same_id_in_codex() {
    let t = Temp::new();
    let m = Memory::default();
    let mut codex = record("same");
    codex.app_type = "codex".into();
    commit::apply(&t.db(), &[record("same"), codex], "test", false, &m).unwrap();
    let refs = crate::references::References {
        hub: t.0.join("hub.json"),
        catalog: t.0.join("catalog.json"),
        pools: t.0.join("pools.json"),
        config: t.0.join("config.json"),
    };
    fs::write(
        &refs.hub,
        r#"{"channels":{"main":{"provider":"id:same"}},"slots":{"opus":"main,model"}}"#,
    )
    .unwrap();
    let result = commit::remove(&t.db(), "claude", "same", &refs, &m).unwrap();
    assert_eq!(result.removed, 0);
    assert_eq!(result.blockers.len(), 1);
    assert_eq!(
        commit::remove(&t.db(), "codex", "same", &refs, &m)
            .unwrap()
            .removed,
        1
    );
    fs::write(&refs.hub, "{}").unwrap();
    fs::write(
        &refs.pools,
        r#"{"providers":{"id:other":{"members":[{"provider":"id:same"}]}}}"#,
    )
    .unwrap();
    assert_eq!(
        commit::remove(&t.db(), "claude", "same", &refs, &m)
            .unwrap()
            .removed,
        0
    );
    fs::write(&refs.pools, "{}").unwrap();
    m.deny_delete.set(true);
    let result = commit::remove(&t.db(), "claude", "same", &refs, &m).unwrap();
    assert_eq!((result.removed, result.pending_cleanup), (1, 1));
}

#[test]
fn preflight_cannot_redefine_baseline_after_an_external_write() {
    let t = Temp::new();
    let m = Memory::default();
    commit::apply(&t.db(), &[record("p")], "test", false, &m).unwrap();
    let path = t.db();
    let before = m.creates.get();
    let result = commit::apply_checked(
        &path,
        &[record("p")],
        "test",
        true,
        &m,
        || {
            crate::open(&path)?.execute("UPDATE providers SET name='concurrent'", [])?;
            Ok(())
        },
        || Ok(()),
    );
    assert_eq!(
        result.err().unwrap().to_string(),
        "provider_revision_conflict"
    );
    assert_eq!(m.creates.get(), before);
}

#[test]
fn alias_blocks_delete_and_sql_errors_never_expose_payloads() {
    let t = Temp::new();
    let m = Memory::default();
    let mut p = record("p");
    p.name = "Production East".into();
    let mut other = record("other");
    other.name = "Production".into();
    commit::apply(&t.db(), &[p, other], "test", false, &m).unwrap();
    let refs = crate::references::References {
        hub: t.0.join("hub.json"),
        catalog: t.0.join("catalog.json"),
        pools: t.0.join("pools.json"),
        config: t.0.join("config.json"),
    };
    fs::write(&refs.config, r#"{"providers":{"p":{"alias":"work"}}}"#).unwrap();
    fs::write(&refs.hub, r#"{"channels":{"main":{"provider":"work"}}}"#).unwrap();
    assert_eq!(
        commit::remove(&t.db(), "claude", "p", &refs, &m)
            .unwrap()
            .removed,
        0
    );
    fs::write(
        &refs.hub,
        r#"{"channels":{"main":{"provider":"Production"}}}"#,
    )
    .unwrap();
    let conn = crate::open(&t.db()).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_delete BEFORE DELETE ON providers BEGIN SELECT RAISE(ABORT,'fake-secret-error'); END").unwrap();
    assert_eq!(
        commit::remove(&t.db(), "claude", "p", &refs, &m)
            .err()
            .unwrap()
            .to_string(),
        "provider_commit_failed"
    );
    conn.execute_batch("DROP TRIGGER fail_delete").unwrap();
    assert_eq!(
        commit::remove(&t.db(), "claude", "p", &refs, &m)
            .unwrap()
            .removed,
        1
    );
}

#[test]
fn migration_retries_pending_storage_cleanup_without_creating_more_secrets() {
    let t = Temp::new();
    let m = Memory::default();
    let mut conn = crate::open(&t.db()).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    crate::import(&mut conn, &[record("p")], "legacy", false, false).unwrap();
    let reader = crate::open_readonly(&t.db()).unwrap();
    reader
        .execute_batch("BEGIN; SELECT * FROM providers;")
        .unwrap();
    let first = crate::migration::migrate(&t.db(), &m).unwrap();
    assert!(first.storage_cleanup_pending);
    let calls = (m.creates.get(), m.reads.get());
    reader.execute_batch("ROLLBACK").unwrap();
    let second = crate::migration::migrate(&t.db(), &m).unwrap();
    assert!(!second.storage_cleanup_pending);
    assert_eq!((m.creates.get(), m.reads.get()), calls);
    for path in [t.db(), t.0.join("providers.db-wal")] {
        assert!(!fs::read(path)
            .unwrap_or_default()
            .windows(b"fake-secret-marker".len())
            .any(|b| b == b"fake-secret-marker"));
    }
}

#[test]
fn edit_preserves_secret_checks_revision_and_noop_never_reads_os() {
    let t = Temp::new();
    let m = Memory::default();
    commit::apply(&t.db(), &[record("p")], "test", false, &m).unwrap();
    let input = |name: &str, revision| crate::edit::Input {
        app_type: "claude".into(),
        id: "p".into(),
        name: name.into(),
        expected_revision: Some(revision),
        endpoint: None,
        model: None,
        protocol: None,
        secret: None,
        clear_secret: false,
    };
    let calls = m.reads.get();
    assert_eq!(
        crate::edit::save(&t.db(), input("Fixture", 1), &m)
            .unwrap()
            .skipped,
        1
    );
    assert_eq!(m.reads.get(), calls);
    crate::edit::save(&t.db(), input("Renamed", 1), &m).unwrap();
    let payload = m.read(&reference(&t.db())).unwrap();
    assert_eq!(
        Envelope::decode(&payload, "claude", "p", 2)
            .unwrap()
            .settings["env"]["ANTHROPIC_AUTH_TOKEN"],
        "fake-secret-marker"
    );
    assert_eq!(
        crate::edit::save(&t.db(), input("Stale", 1), &m)
            .err()
            .unwrap()
            .to_string(),
        "provider_revision_conflict"
    );
    let view = serde_json::to_string(&crate::edit::view(&t.db(), "claude", "p").unwrap()).unwrap();
    assert!(!view.contains("fake-secret-marker"));
    let mut clear = input("Renamed", 2);
    clear.clear_secret = true;
    crate::edit::save(&t.db(), clear, &m).unwrap();
    let payload = m.read(&reference(&t.db())).unwrap();
    assert!(Envelope::decode(&payload, "claude", "p", 3)
        .unwrap()
        .settings["env"]["ANTHROPIC_AUTH_TOKEN"]
        .is_null());
}

#[test]
fn rust_split_roundtrips_through_actual_python_resolver() {
    use std::io::Write;
    let mut record = record("p");
    record.app_type = "codex".into();
    record.settings_config = serde_json::json!({"auth":{"tokens":{"access_token":"fake-oauth"}},"config":"model_provider='p'\n[model_providers.p]\nexperimental_bearer_token='fake-key'\n"});
    let (public, payload) = crate::credentials::split::separate(&record, 2).unwrap();
    let mut child=std::process::Command::new("python3").args(["-c","import json,sys; from claude1_credentials import resolve; d=json.load(sys.stdin); s,m=resolve(d['row'],'codex',d['public'],reader=lambda _:d['payload'].encode()); assert s==d['expected']; print('ok')"])
        .env("PYTHONPATH",std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))
        .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
    let input = serde_json::json!({"row":{"id":"p","credential_ref":"provider/v1/00000000-0000-4000-8000-000000000001","credential_version":1,"revision":2},"public":public.settings_config,"payload":String::from_utf8(payload.encode().unwrap()).unwrap(),"expected":record.settings_config});
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.to_string().as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"ok\n");
}

#[test]
fn legacy_editor_preserves_omitted_secret_and_rejects_stale_revision() {
    let t = Temp::new();
    let input = |name: &str, revision| crate::edit::Input {
        app_type: "claude".into(), id: "p".into(), name: name.into(), expected_revision: revision,
        endpoint: None, model: None, protocol: None, secret: None, clear_secret: false,
    };
    crate::import(&mut crate::open(&t.db()).unwrap(), &[record("p")], "fixture", false, false).unwrap();
    crate::edit::save_legacy(&t.db(), input("Renamed", Some(1))).unwrap();
    let conn = crate::open_readonly(&t.db()).unwrap();
    let raw: String = conn.query_row("SELECT settings_config FROM providers", [], |r| r.get(0)).unwrap();
    assert!(raw.contains("fake-secret-marker"));
    assert_eq!(crate::edit::save_legacy(&t.db(), input("Stale", Some(1))).err().unwrap().to_string(), "provider_revision_conflict");
    let mut clear = input("Renamed", Some(2)); clear.clear_secret = true;
    crate::edit::save_legacy(&t.db(), clear).unwrap();
    let raw: String = conn.query_row("SELECT settings_config FROM providers", [], |r| r.get(0)).unwrap();
    assert!(!raw.contains("fake-secret-marker"));
    commit::apply(&t.db(), &[record("p")], "fixture", true, &Memory::default()).unwrap();
    assert_eq!(crate::edit::save_legacy(&t.db(), input("Unsafe downgrade", Some(4))).err().unwrap().to_string(), "credential_store_required");
}

#[test]
fn legacy_writer_checks_lock_source_and_delete_references() {
    let t = Temp::new();
    let refs = crate::references::References { hub: t.0.join("hub.json"), catalog: t.0.join("catalog.json"), pools: t.0.join("pools.json"), config: t.0.join("config.json") };
    crate::legacy::apply_checked(&t.db(), &[record("p")], "fixture", false, || Ok(()), || Ok(())).unwrap();
    let lock = commit::WriterLock::acquire(&t.db()).unwrap();
    assert_eq!(crate::legacy::remove(&t.db(), "claude", "p", &refs).err().unwrap().to_string(), "provider_store_busy");
    drop(lock);
    let result = crate::legacy::apply_checked(&t.db(), &[record("new")], "fixture", false, || Ok(()), || anyhow::bail!("plan_stale"));
    assert_eq!(result.err().unwrap().to_string(), "plan_stale");
    assert_eq!(crate::list_providers(&crate::open_readonly(&t.db()).unwrap(), None).unwrap().len(), 1);
    fs::write(&refs.hub, r#"{"channels":{"main":{"provider":"id:p"}}}"#).unwrap();
    assert!(!crate::legacy::remove(&t.db(), "claude", "p", &refs).unwrap().blockers.is_empty());
    fs::write(&refs.hub, "{}").unwrap();
    assert_eq!(crate::legacy::remove(&t.db(), "claude", "p", &refs).unwrap().removed, 1);
    commit::apply(&t.db(), &[record("p")], "fixture", false, &Memory::default()).unwrap();
    assert_eq!(crate::legacy::remove(&t.db(), "claude", "p", &refs).err().unwrap().to_string(), "credential_store_required");
}

#[test]
fn legacy_sql_errors_are_redacted_and_preflight_cannot_move_baseline() {
    let t = Temp::new();
    crate::legacy::apply_checked(&t.db(), &[record("p")], "fixture", false, || Ok(()), || Ok(())).unwrap();
    let result = crate::legacy::apply_checked(&t.db(), &[record("p")], "fixture", true, || {
        crate::open(&t.db())?.execute("UPDATE providers SET name='concurrent'", [])?;
        Ok(())
    }, || Ok(()));
    assert_eq!(result.err().unwrap().to_string(), "provider_revision_conflict");
    let conn = crate::open(&t.db()).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_write BEFORE UPDATE ON providers BEGIN SELECT RAISE(ABORT, 'fake-secret-error'); END; CREATE TRIGGER fail_delete BEFORE DELETE ON providers BEGIN SELECT RAISE(ABORT, 'fake-secret-error'); END;").unwrap();
    let result = crate::legacy::apply_checked(&t.db(), &[record("p")], "fixture", true, || Ok(()), || Ok(()));
    assert_eq!(result.err().unwrap().to_string(), "provider_commit_failed");
    let refs = crate::references::References { hub: t.0.join("hub"), catalog: t.0.join("catalog"), pools: t.0.join("pools"), config: t.0.join("config") };
    assert_eq!(crate::legacy::remove(&t.db(), "claude", "p", &refs).err().unwrap().to_string(), "provider_commit_failed");
}

/// Filesystem-backed synthetic secret store survives a killed test subprocess.
/// This proves journal recovery across process death, not OS credential ACL behavior.
struct DurableFixture {
    directory: PathBuf,
    stop_after_create: bool,
}
impl DurableFixture {
    fn path(&self, reference: &str) -> PathBuf {
        assert!(crate::credentials::valid_reference(reference));
        self.directory.join(reference.replace('/', "_"))
    }
}
impl SecretStore for DurableFixture {
    fn create(&self, reference: &str, payload: &[u8]) -> Result<(), CredentialError> {
        use std::io::Write;
        let mut file = fs::OpenOptions::new().create_new(true).write(true).open(self.path(reference)).map_err(|_| CredentialError::Unavailable)?;
        file.write_all(payload).map_err(|_| CredentialError::Unavailable)?;
        file.sync_all().map_err(|_| CredentialError::Unavailable)?;
        if self.stop_after_create {
            fs::write(self.directory.join("ready"), b"created").unwrap();
            loop { std::thread::park_timeout(std::time::Duration::from_secs(1)); }
        }
        Ok(())
    }
    fn read(&self, reference: &str) -> Result<Vec<u8>, CredentialError> {
        fs::read(self.path(reference)).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { CredentialError::NotFound } else { CredentialError::Unavailable })
    }
    fn delete(&self, reference: &str) -> Result<(), CredentialError> {
        match fs::remove_file(self.path(reference)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(CredentialError::Unavailable),
        }
    }
}

#[test]
fn crash_fixture_child() {
    let Some(raw) = std::env::var_os("AGENT_HUB_TEST_CRASH_DIRECTORY") else { return };
    let directory = PathBuf::from(raw);
    let fixture = DurableFixture { directory: directory.clone(), stop_after_create: true };
    commit::apply(&directory.join("providers.db"), &[record("after-crash")], "synthetic-process-kill", false, &fixture).unwrap();
    panic!("fixture should have been killed after durable create");
}

#[test]
fn killed_process_releases_writer_lock_and_recovers_durable_secret_intent() {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let temp = Temp::new();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "commit_tests::crash_fixture_child", "--nocapture"])
        .env("AGENT_HUB_TEST_CRASH_DIRECTORY", &temp.0)
        .stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !temp.0.join("ready").exists() && Instant::now() < deadline {
        if child.try_wait().unwrap().is_some() { break; }
        std::thread::sleep(Duration::from_millis(20));
    }
    let ready = temp.0.join("ready").exists();
    let _ = child.kill();
    let status = child.wait().unwrap();
    assert!(ready, "child must reach durable secret creation before kill");
    assert!(!status.success());
    let fixture = DurableFixture { directory: temp.0.clone(), stop_after_create: false };
    assert!(fs::read_dir(&temp.0).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("provider_v1_")));
    assert_eq!(commit::recover(&temp.db(), &fixture).unwrap(), 0);
    assert!(!fs::read_dir(&temp.0).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("provider_v1_")));
    assert!(crate::list_providers(&crate::open(&temp.db()).unwrap(), None).unwrap().is_empty());
    commit::apply(&temp.db(), &[record("retry")], "synthetic", false, &fixture).unwrap();
}
