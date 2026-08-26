//! 启动会话。
//!
//! 桌面端不自己起会话进程（CONTRACT.md 3.1 节），而是拼出与 CLI 等价的命令交给终端：
//! Windows 用 `cmd /c start wt.exe`（Windows Terminal）开新窗口执行 `claude1 <selector>`，
//! `wt` 不在就退回 `powershell`。窗口里跑的是 PowerShell 且会加载用户的 $PROFILE，
//! 所以以函数形式安装在 profile 里的 `claude1` 在那里是可用的；`-NoExit` 让窗口在
//! 命令结束后留着，命令不存在或立刻报错时用户能看见原文，而不是窗口一闪就没。
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
///
/// Windows 没有 unix 的执行位，能不能执行由扩展名决定，所以名字不带扩展名时要把
/// PATHEXT 里的扩展名逐个试一遍——`claude1` 装成 `claude1.cmd` 是常态，
/// 只找同名无扩展文件会一个都找不到。
pub fn which(name: &str) -> Option<PathBuf> {
    let paths = std::env::var_os("PATH")?;
    let named_with_ext = std::path::Path::new(name).extension().is_some();
    let extensions = path_extensions();
    for dir in std::env::split_paths(&paths) {
        if named_with_ext && is_executable(&dir.join(name)) {
            return Some(dir.join(name));
        }
        for ext in &extensions {
            let candidate = dir.join(format!("{name}{ext}"));
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

/// PATHEXT 里的可执行扩展名。取不到就用 Windows 自带的那四个，不猜别的。
fn path_extensions() -> Vec<String> {
    let raw = std::env::var("PATHEXT").unwrap_or_default();
    let parsed: Vec<String> = raw
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .map(|ext| {
            if ext.starts_with('.') {
                ext.to_string()
            } else {
                format!(".{ext}")
            }
        })
        .collect();
    if parsed.is_empty() {
        return [".COM", ".EXE", ".BAT", ".CMD"]
            .iter()
            .map(|ext| (*ext).to_string())
            .collect();
    }
    parsed
}

fn is_executable(path: &std::path::Path) -> bool {
    // 应用执行别名（%LOCALAPPDATA%\Microsoft\WindowsApps\wt.exe 这类）是 0 字节的
    // 重解析点，metadata 仍然报 is_file，所以这里只判「是文件」就够，不看大小。
    path.is_file()
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

/// 单引号包起来。PowerShell 的单引号字符串里，单引号靠重复一次转义（`'it''s'`），
/// 不是 POSIX 的断开再拼——照抄 POSIX 写法会让参数在 PowerShell 里被切成好几段。
fn shell_quote(arg: &str) -> String {
    let simple = !arg.is_empty()
        && arg.chars().all(|ch| {
            ch.is_ascii_alphanumeric()
                || matches!(ch, '_' | '-' | '.' | '/' | ':' | ',' | '=' | '@')
        });
    if simple {
        return arg.to_string();
    }
    format!("'{}'", arg.replace('\'', "''"))
}

/// 命令行要经过 cmd.exe 与 PowerShell 两层解析，所以拼好之后必须确认里面没有它们的
/// 元字符。这是本文件唯一的 fail-closed 点，防的灾难很具体：渠道名或模型名里带一个
/// `&`、`|`、`$(` 就能让终端多执行一条命令，而这两个名字来自 CC Switch 数据库与 hub
/// 配置，不是桌面端能保证内容的地方。
///
/// 反过来说这里不做转义，只做拒绝：跨两层 shell 的转义正是注入漏洞的高发地，
/// 而合法选择器（`id:<uuid>`、`hub`、`--slot opus`、`--model 渠道,模型`）本来就
/// 用不到这些字符。中日韩文字对两层 shell 都无害，所以照常放行。
fn ensure_shell_safe(command: &str) -> Result<(), String> {
    const FORBIDDEN: [char; 19] = [
        '"', '&', '|', '<', '>', '^', '%', '$', '`', ';', '(', ')', '{', '}', '[', ']', '!', '*',
        '?',
    ];
    if let Some(bad) = command
        .chars()
        .find(|ch| FORBIDDEN.contains(ch) || ch.is_control())
    {
        return Err(format!(
            "拼出来的启动命令里有 Windows shell 的元字符或控制字符（{}），终端会把它当成命令的一部分执行，所以这一步没有执行。这些字符只可能来自渠道名或模型名，请在 CC Switch 或 hub 配置里把它去掉。完整命令：{}",
            bad.escape_debug(),
            redact::redact_text(command)
        ));
    }
    Ok(())
}

/// cmd.exe 的位置。`COMSPEC` 是 Windows 一直给的环境变量，缺了才退回按 PATH 找 cmd.exe。
pub fn comspec() -> PathBuf {
    match std::env::var_os("COMSPEC") {
        Some(raw) if !raw.is_empty() => PathBuf::from(raw),
        _ => PathBuf::from("cmd.exe"),
    }
}

fn run_in_terminal(command: &str) -> Result<(), String> {
    ensure_shell_safe(command)?;
    // Windows Terminal 优先；没装就退回 powershell（CONTRACT.md 3.1 节）。
    let terminal = if which("wt").is_some() { "wt.exe" } else { "powershell" };
    // `start` 的第一个带引号的参数是窗口标题，不给就会把程序名吃成标题，所以先塞一个空标题。
    let mut args: Vec<&str> = vec!["/c", "start", ""];
    if terminal == "wt.exe" {
        args.extend_from_slice(&["wt.exe", "--"]);
    }
    args.extend_from_slice(&["powershell", "-NoExit", "-Command", command]);
    let output = Command::new(comspec())
        .args(&args)
        .output()
        .map_err(|err| format!("无法调用 cmd 打开终端：{err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(redact::redact_text(&format!(
        "用 {terminal} 打开新窗口失败：{}",
        if stderr.is_empty() {
            format!("cmd 退出码 {:?}", output.status.code())
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
        // PowerShell 的单引号靠重复转义
        assert_eq!(shell_quote("it's"), "'it''s'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn shell_metacharacters_are_refused_not_escaped() {
        let err = ensure_shell_safe("claude1 hub --model 'a&calc',b").unwrap_err();
        assert!(err.contains("元字符"), "{err}");
        assert!(ensure_shell_safe("claude1 id:d76dae36-5f87").is_ok());
        // 中文渠道名对 cmd 与 PowerShell 都无害，不能被拦下
        assert!(ensure_shell_safe("claude1 hub --model '国内中转,claude-opus-4'").is_ok());
        assert!(ensure_shell_safe("claude1 hub\n打开计算器").is_err());
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
