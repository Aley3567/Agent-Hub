//! 本机环境信息（设置页与体检用）。
//!
//! 每一项都是真检测出来的：检测不到就是 `false` / `null`，界面显示「未检测到」，
//! 绝不填一个看起来像真的默认值。

use std::path::{Path, PathBuf};
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
/// Windows 上 GUI 进程继承的是完整的用户 PATH，所以 `which` 基本能找到；
/// 但 npm 全局安装出来的是 `%APPDATA%\npm\claude.cmd`，而 PATH 被用户改坏过的机器
/// 并不罕见，所以再兜几个真实存在的安装位置，免得明明装了却报「未检测到」。
/// nvm for Windows 会把当前版本目录符号链接进 PATH，所以不像 macOS 那样需要扫版本目录。
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
    let mut candidates: Vec<PathBuf> = Vec::new();
    // Claude Code 的原生安装位置（跨平台一致），Windows 上是 .exe 或 npm 生成的 .cmd
    for stem in [
        home.join(".local").join("bin").join("claude"),
        home.join(".claude").join("local").join("claude"),
    ] {
        for ext in ["exe", "cmd", "ps1"] {
            candidates.push(stem.with_extension(ext));
        }
    }
    // npm 全局：%APPDATA%\npm\claude.cmd
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let npm = PathBuf::from(appdata).join("npm");
        candidates.push(npm.join("claude.cmd"));
        candidates.push(npm.join("claude.exe"));
    }
    // 系统级 Node 的全局 bin：%ProgramFiles%\nodejs\claude.cmd
    if let Some(program_files) = std::env::var_os("ProgramFiles") {
        let nodejs = PathBuf::from(program_files).join("nodejs");
        candidates.push(nodejs.join("claude.cmd"));
        candidates.push(nodejs.join("claude.exe"));
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

/// 一个真的能跑起来的 python3：程序路径、前置参数与 `--version` 的原文。
#[derive(Debug, Clone)]
pub struct PythonInfo {
    pub program: PathBuf,
    /// 调 `py` 时需要 `-3` 这样的前置参数；直接是解释器时为空
    pub prefix: Vec<&'static str>,
    pub version: String,
}

/// Windows 上找 python3 的顺序，按可靠性排：
///
/// 1. `py -3`：python.org 安装包自带的版本启动器，装了就一定指向真的 3.x；
/// 2. `python`：虚拟环境与大多数安装都提供这个名字；
/// 3. `python3`：Microsoft Store 的「应用执行别名」也叫这个名字，跑起来只会弹商店、
///    不打印版本号，所以排最后，并且只认真的打印出版本的那一个。
const PYTHON_CANDIDATES: [(&str, &[&str]); 3] = [("py", &["-3"]), ("python", &[]), ("python3", &[])];

/// 找一个能用的 python3。全都试不出版本号就返回 `None`，界面显示「未检测到」，不猜一个。
pub fn locate_python() -> Option<PythonInfo> {
    for (name, prefix) in PYTHON_CANDIDATES {
        let Some(program) = launch::which(name) else {
            continue;
        };
        let Some(version) = probe_version(&program, prefix) else {
            continue;
        };
        return Some(PythonInfo {
            program,
            prefix: prefix.to_vec(),
            version,
        });
    }
    None
}

/// 跑一次 `<program> <prefix...> --version`，拿它的输出。跑不起来或没输出返回 `None`。
fn probe_version(program: &Path, prefix: &[&str]) -> Option<String> {
    let output = Command::new(program)
        .args(prefix)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        // Python 2 把版本号打在 stderr 上；这里照样读出来，让体检如实报出旧版本
        text = String::from_utf8_lossy(&output.stderr).trim().to_string();
    }
    if text.is_empty() {
        return None;
    }
    Some(text)
}

/// `python --version` 的输出。取不到返回 `None`。
pub fn detect_python_version() -> Option<String> {
    locate_python().map(|info| info.version)
}
