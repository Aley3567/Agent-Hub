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

/// `python3 --version` 的输出。取不到返回 `None`。
pub fn detect_python_version() -> Option<String> {
    let program = launch::which("python3").or_else(|| {
        let fallback = PathBuf::from("/usr/bin/python3");
        if fallback.is_file() {
            Some(fallback)
        } else {
            None
        }
    })?;
    let output = Command::new(&program).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    }
    if text.is_empty() {
        return None;
    }
    Some(text)
}
