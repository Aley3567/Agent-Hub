use super::*;
use rusqlite::Connection;

fn fixture() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(SCHEMA).unwrap();
    c
}
fn provider() -> ImportProvider {
    custom(
        "p1".into(),
        "claude".into(),
        "Example".into(),
        "https://example.com",
        "test-only-key",
        "model",
        "anthropic",
    )
    .unwrap()
}
#[test]
fn import_is_explicit_idempotent_and_preserves_edits() {
    let mut c = fixture();
    let mut p = provider();
    assert_eq!(
        import(&mut c, &[provider()], "cc-switch", false, true).unwrap(),
        (1, 0)
    );
    assert_eq!(list_providers(&c, None).unwrap().len(), 0);
    import(&mut c, &[provider()], "cc-switch", false, false).unwrap();
    p.name = "Changed".into();
    assert_eq!(
        import(&mut c, &[p], "cc-switch", false, false).unwrap(),
        (0, 1)
    );
    assert_eq!(list_providers(&c, None).unwrap()[0].name, "Example");
    assert!(!serde_json::to_string(&list_providers(&c, None).unwrap())
        .unwrap()
        .contains("test-only-key"));
}
#[test]
fn imported_provider_survives_source_changes_and_removal() {
    let path = std::env::temp_dir().join(format!(
        "agenthub-import-test-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut source = open(&path).unwrap();
    import(&mut source, &[provider()], "manual", false, false).unwrap();
    let records = read_cc(&path).unwrap();
    let mut target = fixture();
    import(&mut target, &records, "cc-switch", false, false).unwrap();
    source
        .execute("UPDATE providers SET name='Edited externally'", [])
        .unwrap();
    drop(source);
    std::fs::remove_file(&path).unwrap();
    assert_eq!(list_providers(&target, None).unwrap()[0].name, "Example");
}

#[test]
fn invalid_batch_is_atomic() {
    let mut c = fixture();
    let mut p = provider();
    p.id = "".into();
    assert!(import(&mut c, &[provider(), p], "file", false, false).is_err());
    assert_eq!(list_providers(&c, None).unwrap().len(), 0);
}
fn list_fixture() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute(
            "INSERT INTO providers (id, app_type, name, settings_config, category, \
             is_current, sort_index) VALUES ('p1', 'claude', '甲渠道', '{\"apiKey\":\"sk-secret\"}', \
             'relay', 1, 0)",
            [],
        )
        .unwrap();
    conn.execute(
        "INSERT INTO providers (id, app_type, name, settings_config, is_current, sort_index) \
             VALUES ('p2', 'codex', '乙渠道', '{}', 0, 1)",
        [],
    )
    .unwrap();
    conn
}

#[test]
fn list_all_and_filter_by_app() {
    let conn = list_fixture();
    assert_eq!(list_providers(&conn, None).unwrap().len(), 2);
    let claude = list_providers(&conn, Some("claude")).unwrap();
    assert_eq!(claude.len(), 1);
    assert_eq!(claude[0].name, "甲渠道");
    assert!(claude[0].is_current);
}

#[test]
fn current_only_returns_activated() {
    let conn = list_fixture();
    let current = current_providers(&conn).unwrap();
    assert_eq!(current.len(), 1);
    assert_eq!(current[0].id, "p1");
}

#[test]
fn serialized_output_never_contains_credentials() {
    let conn = list_fixture();
    let json = serde_json::to_string(&list_providers(&conn, None).unwrap()).unwrap();
    assert!(!json.contains("sk-secret"));
    assert!(!json.contains("settings_config"));
}

struct Scratch(std::path::PathBuf);
impl Scratch {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "provider-store-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn db(&self) -> std::path::PathBuf {
        self.0.join("providers.db")
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn missing_source_columns_are_explicit() {
    for missing in ["id", "app_type", "name", "settings_config"] {
        let scratch = Scratch::new();
        let conn = Connection::open(scratch.db()).unwrap();
        let columns: Vec<_> = ["id", "app_type", "name", "settings_config"]
            .into_iter()
            .filter(|column| *column != missing)
            .map(|column| format!("{column} TEXT"))
            .collect();
        conn.execute_batch(&format!("CREATE TABLE providers ({})", columns.join(",")))
            .unwrap();
        let error = read_cc(&scratch.db())
            .err()
            .expect("missing required column accepted");
        assert!(
            error.to_string().contains(missing),
            "missing column {missing}: {error}"
        );
    }
}

#[test]
fn source_import_is_read_only_and_accepts_optional_columns_missing() {
    let scratch = Scratch::new();
    let conn = Connection::open(scratch.db()).unwrap();
    conn.execute_batch("CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, settings_config TEXT);
        INSERT INTO providers VALUES ('same','claude','Claude','{}'), ('same','codex','Codex','{}');").unwrap();
    drop(conn);
    let before = std::fs::read(scratch.db()).unwrap();
    let modified = std::fs::metadata(scratch.db()).unwrap().modified().unwrap();
    let records = read_cc(&scratch.db()).unwrap();
    assert_eq!(records.len(), 2);
    assert_eq!(records[0].meta, serde_json::json!({}));
    let mut target = fixture();
    import(&mut target, &records, "cc-switch", false, false).unwrap();
    assert_eq!(list_providers(&target, None).unwrap().len(), 2);
    assert_eq!(std::fs::read(scratch.db()).unwrap(), before);
    assert_eq!(
        std::fs::metadata(scratch.db()).unwrap().modified().unwrap(),
        modified
    );
}

#[test]
fn replacement_and_removal_are_scoped_to_application() {
    let mut conn = fixture();
    let mut codex = provider();
    codex.app_type = "codex".into();
    codex.name = "Codex".into();
    import(&mut conn, &[provider(), codex], "file", false, false).unwrap();
    let mut update = provider();
    update.name = "Updated Claude".into();
    import(&mut conn, &[update], "manual", true, false).unwrap();
    assert_eq!(
        list_providers(&conn, Some("codex")).unwrap()[0].name,
        "Codex"
    );
    assert_eq!(
        list_providers(&conn, Some("claude")).unwrap()[0].name,
        "Updated Claude"
    );
    assert_eq!(remove(&mut conn, "p1", "claude").unwrap(), 1);
    assert_eq!(remove(&mut conn, "p1", "claude").unwrap(), 0);
    assert_eq!(list_providers(&conn, None).unwrap()[0].app_type, "codex");
    let sources: i64 = conn
        .query_row("SELECT count(*) FROM provider_sources", [], |r| r.get(0))
        .unwrap();
    assert_eq!(sources, 1);
}

#[test]
fn sql_failure_rolls_back_provider_and_provenance_batch() {
    let mut conn = fixture();
    conn.execute_batch(
        "CREATE TRIGGER fail_second BEFORE INSERT ON provider_sources
        WHEN NEW.id='second' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;",
    )
    .unwrap();
    let mut second = provider();
    second.id = "second".into();
    assert!(import(&mut conn, &[provider(), second], "file", false, false).is_err());
    assert!(list_providers(&conn, None).unwrap().is_empty());
    let sources: i64 = conn
        .query_row("SELECT count(*) FROM provider_sources", [], |r| r.get(0))
        .unwrap();
    assert_eq!(sources, 0);
}

#[test]
fn read_only_open_has_no_cc_schema_version_coupling() {
    let scratch = Scratch::new();
    let conn = open(&scratch.db()).unwrap();
    conn.execute_batch("PRAGMA user_version=999").unwrap();
    drop(conn);
    let conn = open_readonly(&scratch.db()).unwrap();
    assert!(list_providers(&conn, None).unwrap().is_empty());
    assert!(conn.execute("DELETE FROM providers", []).is_err());
}
