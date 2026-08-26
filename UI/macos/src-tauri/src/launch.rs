//! 启动会话。
//!
//! 桌面端不自己起会话进程（CONTRACT.md 3.1 节），而是拼出与 CLI 等价的命令交给终端：
//! macOS 用 osascript 让终端开新窗口执行 `claude1 <selector>`。终端会加载用户的
//! 登录 shell，所以以 shell 函数形式安装的 `claude1` 在那里是可用的。
//!
//! `LaunchResult.command` 回显真实命令，让用户看得见桌面端到底跑了什么。

use std::path::PathBuf;
use std::process::Command;

use serde::{Deserialize, Serialize};

use crate::channels::SLOT_ORDER;
use crate::db;
use crate::hubs;
use crate::redact;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchTarget {
    pub kind: String,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub hub_name: Option<String>,
    #[serde(default)]
    pub slot: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub ok: bool,
    pub command: String,
    pub message: String,
}

/// 找到 claude1 启动器。找不到就报中文错误，绝不静默失败。
pub fn locate_launcher() -> Result<PathBuf, String> {
    if let Some(raw) = std::env::var_os("CLAUDE1_SCRIPT") {
        let path = PathBuf::from(raw);
        if path.is_file() {
            return Ok(path);
        }
        return Err(format!(
            "环境变量 CLAUDE1_SCRIPT 指向的启动器不存在：{}",
            path.display()
        ));
    }
    if let Ok(home) = crate::paths::home_dir() {
        let script = home.join(".claude/scripts/claude-provider-once.py");
        if script.is_file() {
            return Ok(script);
        }
    }
    if let Some(binary) = which("claude1") {
        return Ok(binary);
    }
    Err(
        "找不到 claude1 启动器：PATH 上没有 claude1，也没有 ~/.claude/scripts/claude-provider-once.py；请先安装 claude1，或用 CLAUDE1_SCRIPT 指定启动器路径"
            .to_string(),
    )
}

/// 在 PATH 里找一个可执行文件。
pub fn which(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&paths) {
        let candidate = dir.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

fn is_executable(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    meta.is_file() && meta.permissions().mode() & 0o111 != 0
}

pub fn launch(target: LaunchTarget) -> Result<LaunchResult, String> {
    locate_launcher()?;
    let args = build_args(&target)?;
    let command = format!(
        "claude1 {}",
        args.iter()
            .map(|arg| shell_quote(arg))
            .collect::<Vec<String>>()
            .join(" ")
    );
    run_in_terminal(&command)?;
    Ok(LaunchResult {
        ok: true,
        command,
        message: "已在新的终端窗口执行该命令。会话由终端里的 claude1 接管，桌面端不代管进程。"
            .to_string(),
    })
}

/// 把 LaunchTarget 翻译成 claude1 的参数。
fn build_args(target: &LaunchTarget) -> Result<Vec<String>, String> {
    match target.kind.as_str() {
        "channel" => {
            let id = target
                .channel_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| "启动渠道会话需要 channelId".to_string())?;
            let rows = db::claude_provider_rows()?;
            if !rows.iter().any(|row| row.id == id) {
                return Err(format!("CC Switch 里找不到渠道 id：{id}"));
            }
            // `id:<完整 id>` 是 claude1 的精确选择器，不会被同名渠道抢走。
            Ok(vec![format!("id:{id}")])
        }
        "hub" => {
            ensure_default_hub(target.hub_name.as_deref())?;
            Ok(vec!["hub".to_string()])
        }
        "slot" => {
            ensure_default_hub(target.hub_name.as_deref())?;
            if let Some(model) = target
                .model
                .as_deref()
                .map(str::trim)
                .filter(|model| !model.is_empty())
            {
                if !model.contains(',') {
                    return Err(format!(
                        "hub --model 需要「渠道,模型」形式的选择器，收到：{model}"
                    ));
                }
                return Ok(vec![
                    "hub".to_string(),
                    "--model".to_string(),
                    model.to_string(),
                ]);
            }
            let slot = target
                .slot
                .as_deref()
                .map(|slot| slot.trim().to_lowercase())
                .filter(|slot| SLOT_ORDER.contains(&slot.as_str()))
                .ok_or_else(|| {
                    "启动槽位会话需要 slot，且只能是 fable、opus、sonnet 或 haiku".to_string()
                })?;
            Ok(vec!["hub".to_string(), "--slot".to_string(), slot])
        }
        other => Err(format!(
            "不认识的启动目标类型：{other}（只支持 channel、slot、hub）"
        )),
    }
}

/// claude1 命令行没有选择命名 hub 的开关（只有 TUI 里能选），所以这里必须说清楚，
/// 不能拼一条其实指向默认 hub 的命令冒充成功。
fn ensure_default_hub(hub_name: Option<&str>) -> Result<(), String> {
    let wanted = hub_name.map(str::trim).filter(|name| !name.is_empty());
    let Some(wanted) = wanted else {
        return Ok(());
    };
    let hub = hubs::resolve_hub(wanted)?;
    if hub.is_default {
        return Ok(());
    }
    Err(format!(
        "claude1 命令行没有指定命名 hub 的开关，只有 claude1 的 TUI 启动器里能选，所以桌面端拼不出启动 {} 的等价命令；请在终端运行 claude1，在启动器里选择它",
        hub.display_name
    ))
}

/// 单引号包起来，内部单引号按 POSIX 惯例断开再拼。
fn shell_quote(arg: &str) -> String {
    let simple = !arg.is_empty()
        && arg.chars().all(|ch| {
            ch.is_ascii_alphanumeric()
                || matches!(ch, '_' | '-' | '.' | '/' | ':' | ',' | '=' | '@')
        });
    if simple {
        return arg.to_string();
    }
    format!("'{}'", arg.replace('\'', "'\\''"))
}

/// AppleScript 字符串字面量转义。
fn applescript_quote(text: &str) -> String {
    text.replace('\\', "\\\\").replace('"', "\\\"")
}

/// 用户在用哪个终端。Tauri 进程本身没有 TERM_PROGRAM，取不到就用 Terminal.app。
fn terminal_app() -> &'static str {
    match std::env::var("TERM_PROGRAM").ok().as_deref() {
        Some("iTerm.app") | Some("iTerm") => "iTerm",
        _ => "Terminal",
    }
}

fn run_in_terminal(command: &str) -> Result<(), String> {
    let app = terminal_app();
    let quoted = applescript_quote(command);
    let script = if app == "iTerm" {
        format!(
            "tell application \"iTerm\"\n  activate\n  set newWindow to (create window with default profile)\n  tell current session of newWindow to write text \"{quoted}\"\nend tell"
        )
    } else {
        format!("tell application \"Terminal\"\n  activate\n  do script \"{quoted}\"\nend tell")
    };
    let output = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|err| format!("无法调用 osascript 打开终端：{err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(redact::redact_text(&format!(
        "用 {app} 打开新窗口失败：{}",
        if stderr.is_empty() {
            format!("osascript 退出码 {:?}", output.status.code())
        } else {
            stderr
        }
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quoting_keeps_simple_tokens_readable() {
        assert_eq!(shell_quote("hub"), "hub");
        assert_eq!(shell_quote("id:d76dae36-5f87"), "id:d76dae36-5f87");
        assert_eq!(shell_quote("grok,grok-4.5"), "grok,grok-4.5");
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn applescript_escaping() {
        assert_eq!(applescript_quote(r#"say "hi""#), r#"say \"hi\""#);
        assert_eq!(applescript_quote(r"back\slash"), r"back\\slash");
    }

    #[test]
    fn slot_target_needs_a_valid_slot() {
        let target = LaunchTarget {
            kind: "slot".into(),
            channel_id: None,
            hub_name: None,
            slot: Some("nonsense".into()),
            model: None,
        };
        let err = build_args(&target).unwrap_err();
        assert!(err.contains("fable"), "{err}");
    }

    #[test]
    fn slot_target_builds_the_cli_equivalent() {
        let target = LaunchTarget {
            kind: "slot".into(),
            channel_id: None,
            hub_name: None,
            slot: Some("Opus".into()),
            model: None,
        };
        assert_eq!(
            build_args(&target).unwrap(),
            vec!["hub".to_string(), "--slot".to_string(), "opus".to_string()]
        );
    }

    #[test]
    fn slot_model_must_be_a_channel_model_selector() {
        let target = LaunchTarget {
            kind: "slot".into(),
            channel_id: None,
            hub_name: None,
            slot: Some("opus".into()),
            model: Some("grok-4.5".into()),
        };
        let err = build_args(&target).unwrap_err();
        assert!(err.contains("渠道,模型"), "{err}");
    }

    #[test]
    fn unknown_kind_is_rejected() {
        let target = LaunchTarget {
            kind: "spaceship".into(),
            channel_id: None,
            hub_name: None,
            slot: None,
            model: None,
        };
        assert!(build_args(&target)
            .unwrap_err()
            .contains("不认识的启动目标"));
    }
}
