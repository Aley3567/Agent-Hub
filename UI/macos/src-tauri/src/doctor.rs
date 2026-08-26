//! 本机体检：纯本地只读，不连任何上游。
//!
//! 每一条结论都必须由本机文件推出来。查不到就说查不到，不猜。
//!
//! `doctor_fix_subagent_pins` 的边界：子代理固定值写在 CC Switch 数据库的
//! `settings_config` 里，而桌面端对数据库只有只读权限（README.md 安全边界，
//! 「任何写入路径都不允许存在」）。所以这条修复动作**委托给 claude1 CLI**
//! （`claude1 doctor --fix`，它会先备份数据库再清理），桌面端仍然只是遥控器。

use std::process::Command;

use serde::Serialize;

use crate::channels::{self, Channel, SLOT_ORDER};
use crate::db;
use crate::env;
use crate::error;
use crate::hubs;
use crate::journal;
use crate::launch;
use crate::paths;
use crate::redact;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoctorCheck {
    pub id: String,
    pub level: &'static str,
    pub title: String,
    pub detail: Option<String>,
    pub fix_action: Option<String>,
}

fn check(
    id: &str,
    level: &'static str,
    title: impl Into<String>,
    detail: Option<String>,
    fix_action: Option<&str>,
) -> DoctorCheck {
    DoctorCheck {
        id: id.to_string(),
        level,
        title: title.into(),
        detail,
        fix_action: fix_action.map(str::to_string),
    }
}

pub fn run_doctor() -> Result<Vec<DoctorCheck>, String> {
    let mut out: Vec<DoctorCheck> = Vec::new();
    let channel_list = check_database(&mut out);
    // hub 配置读一次给两条检查共用：端口探测有超时，不该做两遍。
    let hub_configs = hubs::list_hubs().unwrap_or_default();
    check_local_config(&mut out);
    check_file_permissions(&mut out);
    check_hub_configs(&mut out, &channel_list, &hub_configs);
    check_hub_processes(&mut out, &hub_configs);
    check_subagent_pins(&mut out);
    check_credentials(&mut out, &channel_list);
    check_compatibility(&mut out, &channel_list);
    check_pricing(&mut out);
    check_usage_journal(&mut out);
    check_errors_journal(&mut out);
    check_account_pools(&mut out);
    check_claude_bin(&mut out);
    check_launcher(&mut out);
    check_python(&mut out);
    Ok(out)
}

fn check_database(out: &mut Vec<DoctorCheck>) -> Vec<Channel> {
    match channels::list_channels() {
        Ok(list) => {
            let visible = list.iter().filter(|channel| !channel.hidden).count();
            out.push(check(
                "database",
                "ok",
                "CC Switch 数据库可只读打开",
                Some(format!(
                    "读到 {} 个 claude 渠道，其中 {} 个未隐藏。连接以 READ_ONLY 加 PRAGMA query_only 打开，桌面端不存在写数据库的路径。",
                    list.len(),
                    visible
                )),
                None,
            ));
            list
        }
        Err(reason) => {
            out.push(check(
                "database",
                "fail",
                "读不到 CC Switch 渠道",
                Some(reason),
                None,
            ));
            Vec::new()
        }
    }
}

fn check_local_config(out: &mut Vec<DoctorCheck>) {
    let Ok(path) = paths::config_path() else {
        out.push(check(
            "local-config",
            "fail",
            "定不出 claude1 本地配置的位置",
            Some("无法确定主目录，请检查 HOME 环境变量。".to_string()),
            None,
        ));
        return;
    };
    match paths::read_json_object(&path) {
        Ok(None) => out.push(check(
            "local-config",
            "info",
            "还没有 claude1 本地配置",
            Some(format!(
                "{} 不存在。隐藏、别名与本地模型覆盖都存在这个文件里；第一次改设置时桌面端会创建它。",
                error::tilde(&path)
            )),
            None,
        )),
        Ok(Some(root)) => {
            let version = root.get("version").and_then(|value| value.as_i64()).unwrap_or(1);
            let count = root
                .get("providers")
                .and_then(|value| value.as_object())
                .map(|providers| providers.len())
                .unwrap_or(0);
            if version < 3 {
                out.push(check(
                    "local-config",
                    "fail",
                    "claude1 本地配置还是旧版",
                    Some(format!(
                        "{} 的 version 是 {}，键还是渠道名而不是稳定 id。请先在终端运行一次 claude1 让它迁移到 version 3；在那之前桌面端不会写这个文件。",
                        error::tilde(&path),
                        version
                    )),
                    None,
                ));
            } else {
                out.push(check(
                    "local-config",
                    "ok",
                    "claude1 本地配置可读",
                    Some(format!(
                        "{}，version {}，记录了 {} 个渠道的本地覆盖。",
                        error::tilde(&path),
                        version,
                        count
                    )),
                    None,
                ));
            }
        }
        Err(reason) => out.push(check(
            "local-config",
            "fail",
            "claude1 本地配置读不出来",
            Some(reason),
            None,
        )),
    }
}

fn check_file_permissions(out: &mut Vec<DoctorCheck>) {
    let Ok(dir) = paths::cc_switch_dir() else {
        return;
    };
    let mut offenders: Vec<String> = Vec::new();
    if let Some(mode) = paths::mode_bits(&dir) {
        if mode & 0o077 != 0 {
            offenders.push(format!("{}（{:o}）", error::tilde(&dir), mode));
        }
    }
    let mut files: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(path) = paths::config_path() {
        files.push(path);
    }
    if let Ok(path) = paths::default_hub_config_path() {
        files.push(path);
    }
    if let Ok(refs) = hubs::hub_refs() {
        for hub in refs {
            files.push(hub.config_path);
        }
    }
    for file in files {
        if !file.is_file() {
            continue;
        }
        if let Some(mode) = paths::mode_bits(&file) {
            if mode & 0o077 != 0 {
                offenders.push(format!("{}（{:o}）", error::tilde(&file), mode));
            }
        }
    }
    offenders.sort();
    offenders.dedup();
    if offenders.is_empty() {
        out.push(check(
            "file-permissions",
            "ok",
            "本地状态文件权限只对自己开放",
            Some("~/.cc-switch 与各 hub 配置都没有对同组或其他用户开放的权限位。".to_string()),
            None,
        ));
    } else {
        out.push(check(
            "file-permissions",
            "fail",
            "有本地状态文件对其他用户可读",
            Some(format!(
                "这些路径的权限位对同组或其他用户开放：{}。hub 配置里带着本机 token，请用 chmod 600（目录 700）收回来。",
                offenders.join("、")
            )),
            None,
        ));
    }
}

fn check_hub_configs(
    out: &mut Vec<DoctorCheck>,
    channel_list: &[Channel],
    hub_configs: &[hubs::HubConfig],
) {
    let refs = match hubs::hub_refs() {
        Ok(refs) => refs,
        Err(reason) => {
            out.push(check(
                "hub-config",
                "fail",
                "读不到 hub 注册表",
                Some(reason),
                None,
            ));
            return;
        }
    };
    let mut broken: Vec<String> = Vec::new();
    let mut healthy = 0usize;
    let mut unbound: Vec<String> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();
    for hub in &refs {
        match hubs::inspect_hub(hub) {
            Ok(None) => broken.push(format!(
                "{}：配置文件不存在（{}）",
                hub.id,
                error::tilde(&hub.config_path)
            )),
            Err(reason) => broken.push(format!("{}：{}", hub.id, reason)),
            Ok(Some(_)) => healthy += 1,
        }
    }
    if broken.is_empty() {
        out.push(check(
            "hub-config",
            "ok",
            "全部 hub 配置都能解析",
            Some(format!("共 {healthy} 个 hub，配置文件都读得出来。")),
            None,
        ));
    } else {
        out.push(check(
            "hub-config",
            "fail",
            "有 hub 的配置读不出来",
            Some(format!(
                "这些 hub 不会出现在槽位视图里：{}。",
                broken.join("；")
            )),
            None,
        ));
    }

    let hub_channel_total: usize = hub_configs.iter().map(|hub| hub.channels.len()).sum();
    for hub in hub_configs {
        for slot in SLOT_ORDER {
            if hub
                .slots
                .get(slot)
                .and_then(|value| value.as_ref())
                .is_none()
            {
                unbound.push(format!("{}·{}", hub.name, slot));
            }
        }
        for channel in &hub.channels {
            if channel.resolved_channel_id.is_none() {
                unresolved.push(format!(
                    "{}·{}（{}）",
                    hub.name, channel.name, channel.provider
                ));
            }
        }
    }
    if unbound.is_empty() {
        out.push(check(
            "hub-slots",
            "ok",
            "四个槽位都绑好了",
            Some("每个 hub 的 fable、opus、sonnet、haiku 都指向了已声明的渠道与模型。".to_string()),
            None,
        ));
    } else {
        out.push(check(
            "hub-slots",
            "info",
            "有槽位没绑定，会走 default_channel 兜底",
            Some(format!(
                "未绑定的槽位：{}。claude1 会把它们回落到该 hub 的 default_channel 加首个模型。",
                unbound.join("、")
            )),
            None,
        ));
    }
    if unresolved.is_empty() {
        out.push(check(
            "hub-channel-resolve",
            "ok",
            "hub 渠道都能对上 CC Switch 渠道",
            Some(format!(
                "{hub_channel_total} 个 hub 渠道的 provider 选择器全部解析成功（当前可见 {} 个 CC Switch 渠道）。",
                channel_list.len()
            )),
            None,
        ));
    } else {
        out.push(check(
            "hub-channel-resolve",
            "fail",
            "有 hub 渠道对不上 CC Switch 渠道",
            Some(format!(
                "这些渠道在槽位视图里会显示「未解析」，转发时会失败：{}。请检查 provider 选择器，或在 CC Switch 里确认对应渠道还在。",
                unresolved.join("、")
            )),
            None,
        ));
    }
}

fn check_hub_processes(out: &mut Vec<DoctorCheck>, hub_list: &[hubs::HubConfig]) {
    let running: Vec<String> = hub_list
        .iter()
        .filter(|hub| hub.running)
        .map(|hub| match hub.port {
            Some(port) => format!("{}（127.0.0.1:{}）", hub.name, port),
            None => hub.name.clone(),
        })
        .collect();
    let detail = if running.is_empty() {
        "没有 hub 在监听。下次启动会话时 claude1 会自己把它拉起来。".to_string()
    } else {
        format!(
            "正在监听：{}。探测只连回环，不带 token、不发外部请求。",
            running.join("、")
        )
    };
    out.push(check(
        "hub-running",
        "info",
        "hub 进程状态",
        Some(detail),
        None,
    ));
}

fn check_subagent_pins(out: &mut Vec<DoctorCheck>) {
    match db::subagent_pinned_providers() {
        Ok((pinned, invalid)) => {
            if pinned.is_empty() && invalid.is_empty() {
                out.push(check(
                    "subagent-pins",
                    "ok",
                    "没有渠道固定子代理模型",
                    Some(format!(
                        "没有 provider 在 settings_config 里写 {}，子代理会跟随会话主模型。",
                        channels::SUBAGENT_MODEL_KEY
                    )),
                    None,
                ));
                return;
            }
            let mut detail = String::new();
            if !pinned.is_empty() {
                let names: Vec<&str> = pinned.iter().map(|(_, name)| name.as_str()).collect();
                detail.push_str(&format!(
                    "这些 provider 在 settings_config 里固定了 {}：{}。它会把所有子代理钉在一个模型上，槽位设置对子代理就失效了。修复动作会调用 claude1 doctor --fix：先备份 CC Switch 数据库，再清掉这个键（桌面端自己对数据库只读，所以这一步交给 CLI 做）。",
                    channels::SUBAGENT_MODEL_KEY,
                    names.join("、")
                ));
            }
            if !invalid.is_empty() {
                if !detail.is_empty() {
                    detail.push(' ');
                }
                detail.push_str(&format!(
                    "另有 {} 个 provider 的 settings_config 不是合法 JSON，无法判断：{}。",
                    invalid.len(),
                    invalid.join("、")
                ));
            }
            out.push(check(
                "subagent-pins",
                "fail",
                "有渠道把子代理模型钉死了",
                Some(detail),
                Some("doctor_fix_subagent_pins"),
            ));
        }
        Err(reason) => out.push(check(
            "subagent-pins",
            "fail",
            "查不了子代理模型固定值",
            Some(reason),
            None,
        )),
    }
}

fn check_credentials(out: &mut Vec<DoctorCheck>, channel_list: &[Channel]) {
    if channel_list.is_empty() {
        return;
    }
    let missing: Vec<&str> = channel_list
        .iter()
        .filter(|channel| !channel.hidden && channel.credential == "missing")
        .map(|channel| channel.name.as_str())
        .collect();
    if missing.is_empty() {
        out.push(check(
            "credentials",
            "ok",
            "未隐藏的渠道都配了凭证",
            Some("体检只看凭证键是否存在且非空，从不读凭证本身。".to_string()),
            None,
        ));
    } else {
        out.push(check(
            "credentials",
            "fail",
            "有未隐藏的渠道没配凭证",
            Some(format!(
                "这些渠道启动会 401：{}。请在 CC Switch 里补上 key 或 token，桌面端不提供凭证录入。",
                missing.join("、")
            )),
            None,
        ));
    }
}

fn check_compatibility(out: &mut Vec<DoctorCheck>, channel_list: &[Channel]) {
    if channel_list.is_empty() {
        return;
    }
    let incompatible: Vec<String> = channel_list
        .iter()
        .filter(|channel| channel.compatibility == "incompatible")
        .map(|channel| match &channel.compatibility_reason {
            Some(reason) => format!("{}（{}）", channel.name, reason),
            None => channel.name.clone(),
        })
        .collect();
    let unassessed = channel_list
        .iter()
        .filter(|channel| channel.compatibility == "unassessed")
        .count();
    let mut detail = format!("{} 个渠道尚未做语义兼容性验收。", unassessed);
    if incompatible.is_empty() {
        detail.push_str(" 没有被判为不兼容的渠道。");
    } else {
        detail.push_str(&format!(
            " 被判为不兼容的渠道：{}。claude1 默认会把它们从启动菜单里挡掉，只有用完整 id: 选择器才能强制诊断。",
            incompatible.join("、")
        ));
    }
    // 「不兼容」是人工验收结论而不是机器故障，所以这条永远是 info；界面负责把它显式标出来。
    out.push(check(
        "compatibility",
        "info",
        "Claude Code 语义兼容性",
        Some(detail),
        None,
    ));
}

fn check_pricing(out: &mut Vec<DoctorCheck>) {
    let Ok(path) = paths::pricing_path() else {
        return;
    };
    match journal::load_price_table() {
        Ok(table) if table.is_empty() => out.push(check(
            "pricing",
            "info",
            "没有可用的价格表，不显示成本",
            Some(format!(
                "{} 的 models 是空的，所以用量视图只给 token 量，不估算金额。这是刻意的：编造单价算出来的钱比不显示更糟。",
                error::tilde(&path)
            )),
            None,
        )),
        Ok(table) => out.push(check(
            "pricing",
            "ok",
            "价格表可用",
            Some(format!("收录了 {} 个模型的单价。", table.len())),
            None,
        )),
        Err(reason) => out.push(check("pricing", "fail", "价格表读不出来", Some(reason), None)),
    }
}

fn check_usage_journal(out: &mut Vec<DoctorCheck>) {
    let Ok(primary) = paths::default_usage_journal() else {
        return;
    };
    let files = journal::journal_files(&primary);
    if files.is_empty() {
        out.push(check(
            "usage-journal",
            "info",
            "本机还没有用量流水",
            Some(format!(
                "{} 不存在。跑一次经过 hub 的会话后，用量视图才会有数据。",
                error::tilde(&primary)
            )),
            None,
        ));
        return;
    }
    match journal::count_usage_lines(&files) {
        Ok(report) if report.skipped == 0 => out.push(check(
            "usage-journal",
            "ok",
            "用量流水可解析",
            Some(format!(
                "{} 个文件共 {} 行，全部解析成功。",
                files.len(),
                report.parsed
            )),
            None,
        )),
        Ok(report) => out.push(check(
            "usage-journal",
            "info",
            "用量流水里有坏行，已跳过",
            Some(format!(
                "{} 行解析成功，{} 行跳过（通常是写入时被截断的最后一行）。坏行只是不计入统计，不会影响其他数据。",
                report.parsed, report.skipped
            )),
            None,
        )),
        Err(reason) => out.push(check(
            "usage-journal",
            "fail",
            "用量流水读不出来",
            Some(reason),
            None,
        )),
    }
}

fn check_errors_journal(out: &mut Vec<DoctorCheck>) {
    let Ok(primary) = paths::default_errors_journal() else {
        return;
    };
    if !primary.is_file() {
        out.push(check(
            "errors-journal",
            "info",
            "本机还没有错误流水",
            Some(format!(
                "{} 不存在，说明还没记录过失败，也可能只是还没跑过会话。",
                error::tilde(&primary)
            )),
            None,
        ));
        return;
    }
    match journal::recent_errors(50) {
        Ok(rows) if rows.is_empty() => out.push(check(
            "errors-journal",
            "ok",
            "错误流水里没有记录",
            Some(format!("{} 是空的。", error::tilde(&primary))),
            None,
        )),
        Ok(rows) => {
            let newest = rows.first().map(|row| row.ts).unwrap_or(0);
            out.push(check(
                "errors-journal",
                "info",
                "错误流水里有失败记录",
                Some(format!(
                    "最近 {} 条里最新一条的时间戳是 {}。到诊断视图看阶段、状态码与人话原因。",
                    rows.len(),
                    newest
                )),
                None,
            ));
        }
        Err(reason) => out.push(check(
            "errors-journal",
            "fail",
            "错误流水读不出来",
            Some(reason),
            None,
        )),
    }
}

fn check_account_pools(out: &mut Vec<DoctorCheck>) {
    let Ok(path) = paths::account_pool_path() else {
        return;
    };
    match crate::pools::list_account_pools() {
        Ok(pools) if pools.is_empty() => out.push(check(
            "account-pools",
            "info",
            "本机没有配置账号池",
            Some(format!(
                "{} 不存在或没有 providers。同一渠道多账号轮换要用 claude1 accounts 配置；桌面端首版只做只读展示。",
                error::tilde(&path)
            )),
            None,
        )),
        Ok(pools) => {
            let unresolved: Vec<String> = pools
                .iter()
                .flat_map(|pool| pool.members.iter())
                .filter(|member| member.resolved_channel_id.is_none())
                .map(|member| member.provider_ref.clone())
                .collect();
            if unresolved.is_empty() {
                out.push(check(
                    "account-pools",
                    "ok",
                    "账号池成员都能对上渠道",
                    Some(format!("{} 个池，成员选择器全部解析成功。", pools.len())),
                    None,
                ));
            } else {
                out.push(check(
                    "account-pools",
                    "fail",
                    "账号池里有成员对不上渠道",
                    Some(format!(
                        "这些选择器在 CC Switch 里找不到对应渠道：{}。轮到它们时会取不到凭证。",
                        unresolved.join("、")
                    )),
                    None,
                ));
            }
        }
        Err(reason) => out.push(check(
            "account-pools",
            "fail",
            "账号池读不出来",
            Some(reason),
            None,
        )),
    }
}

fn check_claude_bin(out: &mut Vec<DoctorCheck>) {
    match env::locate_claude_bin() {
        Some(path) => out.push(check(
            "claude-bin",
            "ok",
            "找到 Claude Code 可执行文件",
            Some(error::tilde(&path)),
            None,
        )),
        None => out.push(check(
            "claude-bin",
            "fail",
            "没找到 Claude Code 可执行文件",
            Some("PATH 与常见安装位置里都没有 claude。请安装 Claude Code，或用 CLAUDE1_CLAUDE_BIN 指定路径。注意桌面应用继承到的 PATH 通常比终端里短。".to_string()),
            None,
        )),
    }
}

fn check_launcher(out: &mut Vec<DoctorCheck>) {
    match launch::locate_launcher() {
        Ok(path) => out.push(check(
            "claude1-launcher",
            "ok",
            "找到 claude1 启动器",
            Some(format!(
                "{}。启动会话时桌面端只是让终端新窗口执行 claude1，进程由终端接管。",
                error::tilde(&path)
            )),
            None,
        )),
        Err(reason) => out.push(check(
            "claude1-launcher",
            "fail",
            "没找到 claude1 启动器",
            Some(reason),
            None,
        )),
    }
}

fn check_python(out: &mut Vec<DoctorCheck>) {
    match env::detect_python_version() {
        Some(version) => {
            let numbers: Vec<i64> = version
                .split_whitespace()
                .last()
                .unwrap_or("")
                .split('.')
                .filter_map(|part| part.parse::<i64>().ok())
                .collect();
            let ok = match (numbers.first(), numbers.get(1)) {
                (Some(3), Some(minor)) => *minor >= 11,
                (Some(major), _) => *major > 3,
                _ => false,
            };
            if ok {
                out.push(check("python", "ok", version, None, None));
            } else {
                out.push(check(
                    "python",
                    "fail",
                    version,
                    Some("claude1 需要 Python 3.11 或更高版本。".to_string()),
                    None,
                ));
            }
        }
        None => out.push(check(
            "python",
            "fail",
            "没检测到 python3",
            Some("claude1 与 claude-hub 都是 Python 脚本，缺了 python3 会话起不来。".to_string()),
            None,
        )),
    }
}

/// 委托 claude1 CLI 清理子代理固定值，然后重跑体检。
///
/// 不在桌面端直接改数据库：README.md 的安全边界要求这里不存在数据库写入路径。
pub fn fix_subagent_pins() -> Result<Vec<DoctorCheck>, String> {
    let launcher = launch::locate_launcher()?;
    let python = launch::which("python3")
        .or_else(|| {
            let fallback = std::path::PathBuf::from("/usr/bin/python3");
            if fallback.is_file() {
                Some(fallback)
            } else {
                None
            }
        })
        .ok_or_else(|| {
            "没找到 python3，无法调用 claude1 doctor --fix 清理子代理固定值".to_string()
        })?;
    let output = Command::new(&python)
        .arg(&launcher)
        .arg("doctor")
        .arg("--fix")
        .output()
        .map_err(|err| {
            format!(
                "调用 {} doctor --fix 失败：{}",
                error::tilde(&launcher),
                err
            )
        })?;
    // claude1 doctor 有失败项时返回 1，那不代表修复没跑成，所以 0 和 1 都算跑过了。
    let code = output.status.code();
    if !matches!(code, Some(0) | Some(1)) {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let tail = if stderr.is_empty() { stdout } else { stderr };
        return Err(redact::redact_text(&format!(
            "claude1 doctor --fix 异常退出（退出码 {:?}）：{}",
            code,
            if tail.is_empty() {
                "没有任何输出".to_string()
            } else {
                tail
            }
        )));
    }
    run_doctor()
}
