use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "agent-hub-cli-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
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
