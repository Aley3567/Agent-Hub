//! 本机环境信息（设置页与体检用）。
//!
//! 每一项都是真检测出来的：检测不到就是 `false` / `null`，界面显示「未检测到」，
//! 绝不填一个看起来像真的默认值。

use std::path::PathBuf;
use std::process::Command;

use serde::Serialize;

use crate::launch;
use crate::paths;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppEnv {
    pub platform: String,
    pub app_version: String,
    pub tauri_version: String,
    pub db_path: String,
    pub config_path: String,
    pub logs_dir: String,
    pub has_claude_bin: bool,
    pub python_version: Option<String>,
}

pub fn app_env(app_version: String) -> Result<AppEnv, String> {
    Ok(AppEnv {
        platform: std::env::consts::OS.to_string(),
        app_version,
        tauri_version: tauri::VERSION.to_string(),
        db_path: paths::db_path()?.to_string_lossy().into_owned(),
        config_path: paths::config_path()?.to_string_lossy().into_owned(),
        logs_dir: paths::logs_dir()?.to_string_lossy().into_owned(),
        has_claude_bin: locate_claude_bin().is_some(),
        python_version: detect_python_version(),
    })
}

/// 找 Claude Code 的可执行文件。
///
/// GUI 进程继承到的 PATH 通常很短，所以除了 PATH 还要看几个常见安装位置与 nvm 的
/// node 版本目录，否则明明装了却报「未检测到」。
pub fn locate_claude_bin() -> Option<PathBuf> {
    for key in ["CLAUDE1_CLAUDE_BIN", "CLAUDE1_DEFAULT_CLAUDE_BIN"] {
        if let Some(raw) = std::env::var_os(key) {
            let path = PathBuf::from(raw);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    if let Some(found) = launch::which("claude") {
        return Some(found);
    }
    let home = paths::home_dir().ok()?;
    let candidates = [
        home.join(".local/bin/claude"),
        home.join(".claude/local/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    let nvm = home.join(".nvm/versions/node");
    if let Ok(entries) = std::fs::read_dir(&nvm) {
        for entry in entries.flatten() {
            let candidate = entry.path().join("bin/claude");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Use the same supported interpreter for GUI diagnostics and repair commands.
/// Finder's PATH may contain only the older system Python.
pub fn resolve_python() -> Option<PathBuf> {
    let (path, version) = discover_python()?;
    supported_python(&version).then_some(path)
}

pub fn detect_python_version() -> Option<String> {
    discover_python().map(|(_, version)| version)
}

pub fn supported_python(version: &str) -> bool {
    let mut numbers = version.split_whitespace().last().unwrap_or("").split('.');
    let major = numbers.next().and_then(|value| value.parse::<u32>().ok());
    let minor = numbers.next().and_then(|value| value.parse::<u32>().ok());
    matches!((major, minor), (Some(3), Some(11..)) | (Some(4..), _))
}

fn discover_python() -> Option<(PathBuf, String)> {
    let mut candidates = Vec::new();
    if let Some(program) = launch::which("python3") { candidates.push(program); }
    if let Ok(home) = paths::home_dir() { candidates.push(home.join(".local/bin/python3")); }
    candidates.extend(["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].map(PathBuf::from));
    choose_python(candidates.into_iter().filter_map(|program| {
        python_version(&program).map(|version| (program, version))
    }))
}

fn choose_python(probes: impl IntoIterator<Item = (PathBuf, String)>) -> Option<(PathBuf, String)> {
    let mut fallback = None;
    for (program, version) in probes {
        if supported_python(&version) { return Some((program, version)); }
        if fallback.is_none() { fallback = Some((program, version)); }
    }
    fallback
}

fn python_version(program: &std::path::Path) -> Option<String> {
    let output = Command::new(program).arg("--version").output().ok()?;
    if !output.status.success() { return None; }
    let text = if output.stdout.is_empty() { &output.stderr } else { &output.stdout };
    let version = String::from_utf8_lossy(text).trim().to_string();
    (!version.is_empty()).then_some(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gui_system_python_does_not_hide_supported_homebrew_python() {
        let found = choose_python([
            (PathBuf::from("/usr/bin/python3"), "Python 3.9.6".into()),
            (PathBuf::from("/usr/local/bin/python3"), "Python 3.12.8".into()),
        ]).unwrap();
        assert_eq!(found.0, PathBuf::from("/usr/local/bin/python3"));
        assert!(supported_python(&found.1));
    }

    #[test]
    fn unsupported_python_is_reported_but_not_approved_for_repairs() {
        let found = choose_python([(PathBuf::from("old"), "Python 3.9.6".into())]).unwrap();
        assert_eq!(found.1, "Python 3.9.6");
        assert!(!supported_python(&found.1));
        assert!(!supported_python("unknown"));
        assert!(supported_python("Python 3.11.0"));
    }
}
