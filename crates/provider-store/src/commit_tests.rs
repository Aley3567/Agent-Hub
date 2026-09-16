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
