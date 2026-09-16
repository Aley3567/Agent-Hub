use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
    sync::atomic::{AtomicU64, Ordering},
};

/// Parallel tests share a process, so the wall clock alone cannot keep
/// sandbox names unique when two constructors land on the same nanosecond.
static SANDBOX_SEQ: AtomicU64 = AtomicU64::new(0);

struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "agent-hub-cli-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            SANDBOX_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        Self(dir)
    }
    fn run(&self, args: &[&str], target: &std::path::Path) -> Output {
        Command::new(env!("CARGO_BIN_EXE_agent-hub"))
            .env("HOME", &self.0)
            .env("AGENT_HUB_PROVIDER_DB", target)
            .env("CLAUDE1_DB_PATH", self.0.join("external.db"))
            .args(args)
            .output()
            .unwrap()
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn init_ignores_legacy_read_override() {
    let sandbox = Sandbox::new();
    let external = sandbox.0.join("external.db");
    fs::write(&external, b"external source sentinel").unwrap();
    let hub = sandbox.0.join("hub/providers.db");
    let output = sandbox.run(&["provider", "init"], &hub);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fs::read(external).unwrap(), b"external source sentinel");
    assert!(hub.is_file());
}

#[test]
fn import_cannot_use_target_as_source() {
    let sandbox = Sandbox::new();
    let hub = sandbox.0.join("providers.db");
    assert!(sandbox.run(&["provider", "init"], &hub).status.success());
    let before = fs::read(&hub).unwrap();
    let output = sandbox.run(
        &[
            "provider",
            "import",
            "--cc-switch",
            "--source-db",
            hub.to_str().unwrap(),
        ],
        &hub,
    );
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("different files"));
    assert_eq!(fs::read(&hub).unwrap(), before);
}

#[test]
fn source_db_requires_cc_switch_without_creating_target() {
    let sandbox = Sandbox::new();
    let hub = sandbox.0.join("providers.db");
    let output = sandbox.run(&["provider", "import", "--source-db", "unused.db"], &hub);
    assert!(!output.status.success());
    assert!(!hub.exists());
}

#[test]
fn preview_and_migration_status_never_create_target_or_expose_secrets() {
    let sandbox = Sandbox::new();
    let target = sandbox.0.join("absent/providers.db");
    let source = sandbox.0.join("settings.json");
    fs::write(&source, r#"{"env":{"ANTHROPIC_BASE_URL":"https://example.test/private","ANTHROPIC_AUTH_TOKEN":"fake-secret-marker","ANTHROPIC_MODEL":"model"}}"#).unwrap();
    let output = sandbox.run(
        &[
            "provider",
            "import",
            "--claude-settings",
            source.to_str().unwrap(),
            "--preview",
        ],
        &target,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8_lossy(&output.stdout);
    assert!(text.contains("candidates"));
    assert!(!text.contains("fake-secret-marker"));
    assert!(!text.contains("/private"));
    assert!(!target.parent().unwrap().exists());
    assert!(sandbox
        .run(&["provider", "migrate-credentials"], &target)
        .status
        .success());
    assert!(!target.parent().unwrap().exists());
}
