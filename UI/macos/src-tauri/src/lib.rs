//! claude1 桌面端的 Rust 侧：只读本机真实文件，写只碰两类本地 JSON。
//!
//! 全部命令返回 `Result<T, String>`，错误字符串就是给人看的中文原因
//! （AGENTS.md：错误原样暴露，不伪装成功）。

mod channels;
mod chat;
mod codex_usage;
mod cron;
mod db;
mod doctor;
mod env;
mod error;
mod hubs;
mod journal;
mod launch;
mod paths;
mod plugins;
mod pools;
mod redact;
mod tasks;

use std::process::Command;

use crate::journal::Granularity;

// ---------------------------------------------------------------------------
// 渠道
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_channels() -> Result<Vec<channels::Channel>, String> {
    channels::list_channels()
}

#[tauri::command]
fn set_channel_hidden(id: String, hidden: bool) -> Result<(), String> {
    channels::set_channel_hidden(&id, hidden)
}

#[tauri::command]
fn set_channel_alias(id: String, alias: Option<String>) -> Result<(), String> {
    channels::set_channel_alias(&id, alias.as_deref())
}

#[tauri::command]
fn set_channel_override(
    id: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    channels::set_channel_override(&id, model.as_deref(), effort.as_deref())
}

// ---------------------------------------------------------------------------
// hub 与槽位
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_hubs() -> Result<Vec<hubs::HubConfig>, String> {
    hubs::list_hubs()
}

#[tauri::command]
fn set_hub_slot(
    hub_name: String,
    slot: String,
    channel: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    hubs::set_hub_slot(&hub_name, &slot, channel.as_deref(), model.as_deref())
}

#[tauri::command]
fn set_hub_slot_effort(
    hub_name: String,
    slot: String,
    effort: Option<String>,
) -> Result<(), String> {
    hubs::set_hub_slot_effort(&hub_name, &slot, effort.as_deref())
}

// ---------------------------------------------------------------------------
// 流水
// ---------------------------------------------------------------------------

#[tauri::command]
async fn usage_summary(
    hub_name: Option<String>,
    from_ts: i64,
    to_ts: i64,
    granularity: String,
) -> Result<journal::UsageSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let granularity = Granularity::parse(&granularity)?;
        let primary = hubs::usage_path_for(hub_name.as_deref())?;
        let files = journal::journal_files(&primary);
        let (mut rows, _report) = journal::scan_usage(&files)?;
        if hub_name.is_none() {
            rows.extend(codex_usage::read(from_ts, to_ts)?);
        }

        // Pricing file first, then an explicitly configured pricing DB; otherwise unknown.
        let file_table = journal::load_price_table()?;
        let (table, cost_source) = if !file_table.is_empty() {
            (file_table, Some("pricing-file".to_string()))
        } else {
            let pricing_path = paths::pricing_db_path();
            let db_table = db::optional_model_pricing(pricing_path.as_deref());
            if !db_table.is_empty() {
                (db_table, Some("pricing-db".to_string()))
            } else {
                (journal::PriceTable::new(), None)
            }
        };

        let mut summary = journal::summarize_rows(&rows, from_ts, to_ts, granularity, &table)?;
        journal::apply_pricing(&mut summary, &table);
        summary.cost_source = cost_source;
        let provider_path = paths::db_path()?;
        if provider_path.exists() {
            let conn = db::open_readonly(&provider_path)?;
            let mut stmt = conn
                .prepare("SELECT app_type,id,name FROM providers")
                .map_err(|_| "无法读取 provider 名称")?;
            let entries = stmt
                .query_map([], |r| {
                    Ok((
                        format!("{}:{}", r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                        r.get::<_, String>(2)?,
                    ))
                })
                .map_err(|_| "无法读取 provider 名称")?;
            for entry in entries {
                let (key, name) = entry.map_err(|_| "无法读取 provider 名称")?;
                summary.provider_labels.insert(key, name);
            }
        }
        Ok(summary)
    })
    .await
    .map_err(|_| "用量扫描任务失败".to_string())?
}

#[tauri::command]
async fn recent_usage(
    limit: usize,
    hub_name: Option<String>,
    from_ts: Option<i64>,
    to_ts: Option<i64>,
) -> Result<Vec<journal::UsageRow>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let from = from_ts.unwrap_or(i64::MIN);
        let to = to_ts.unwrap_or(i64::MAX);
        let primary = hubs::usage_path_for(hub_name.as_deref())?;
        let files = journal::journal_files(&primary);
        let (mut rows, _) = journal::scan_usage(&files)?;
        if hub_name.is_none() {
            rows.extend(codex_usage::read(from, to)?);
        }
        rows.retain(|r| r.ts >= from && r.ts <= to);
        rows.sort_by(|a, b| b.ts.cmp(&a.ts));
        rows.truncate(limit.min(5000));
        Ok(rows)
    })
    .await
    .map_err(|_| "用量明细读取失败".to_string())?
}

#[tauri::command]
fn recent_errors(limit: usize) -> Result<Vec<journal::ErrorRow>, String> {
    journal::recent_errors(limit)
}

// ---------------------------------------------------------------------------
// 账号池与体检
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_account_pools() -> Result<Vec<pools::AccountPool>, String> {
    pools::list_account_pools()
}

#[tauri::command]
fn run_doctor() -> Result<Vec<doctor::DoctorCheck>, String> {
    doctor::run_doctor()
}

#[tauri::command]
fn doctor_fix_subagent_pins() -> Result<Vec<doctor::DoctorCheck>, String> {
    doctor::fix_subagent_pins()
}

// ---------------------------------------------------------------------------
// 对话、插件与计划任务
// ---------------------------------------------------------------------------

#[tauri::command]
fn list_chat_sessions() -> Result<Vec<chat::ChatSession>, String> {
    chat::list_chat_sessions()
}

#[tauri::command]
fn send_chat_message(session_id: String, content: String) -> Result<chat::ChatMessage, String> {
    chat::send_chat_message(&session_id, &content)
}

#[tauri::command]
fn list_plugins() -> Result<Vec<plugins::PluginItem>, String> {
    plugins::list_plugins()
}

#[tauri::command]
fn set_plugin_enabled(id: String, enabled: bool) -> Result<(), String> {
    plugins::set_plugin_enabled(&id, enabled)
}

#[tauri::command]
fn list_tasks() -> Result<Vec<tasks::ScheduledTask>, String> {
    tasks::list_tasks()
}

#[tauri::command]
fn create_task(task: tasks::NewScheduledTask) -> Result<tasks::ScheduledTask, String> {
    tasks::create_task(task)
}

#[tauri::command]
fn update_task(id: String, patch: tasks::TaskPatch) -> Result<tasks::ScheduledTask, String> {
    tasks::update_task(&id, patch)
}

#[tauri::command]
fn delete_task(id: String) -> Result<(), String> {
    tasks::delete_task(&id)
}

// ---------------------------------------------------------------------------
// 启动、环境与打开路径
// ---------------------------------------------------------------------------

#[tauri::command]
fn launch(target: launch::LaunchTarget) -> Result<launch::LaunchResult, String> {
    launch::launch(target)
}

#[tauri::command]
fn app_env(app: tauri::AppHandle) -> Result<env::AppEnv, String> {
    let version = app.package_info().version.to_string();
    env::app_env(version)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let checked = paths::ensure_openable(&path)?;
    run_open(&["--", &checked.to_string_lossy()], &path)
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    let checked = paths::ensure_openable(&path)?;
    run_open(&["-R", "--", &checked.to_string_lossy()], &path)
}

/// 用系统的 `open` 打开。不经 shell，参数直接传，避免任何注入面。
fn run_open(args: &[&str], shown: &str) -> Result<(), String> {
    let output = Command::new("/usr/bin/open")
        .args(args)
        .output()
        .map_err(|err| format!("无法调用 open 打开 {shown}：{err}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Err(redact::redact_text(&format!(
        "打开 {shown} 失败：{}",
        if stderr.is_empty() {
            format!("open 退出码 {:?}", output.status.code())
        } else {
            stderr
        }
    )))
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_channels,
            set_channel_hidden,
            set_channel_alias,
            set_channel_override,
            list_hubs,
            set_hub_slot,
            set_hub_slot_effort,
            usage_summary,
            recent_usage,
            recent_errors,
            list_account_pools,
            run_doctor,
            doctor_fix_subagent_pins,
            list_chat_sessions,
            send_chat_message,
            list_plugins,
            set_plugin_enabled,
            list_tasks,
            create_task,
            update_task,
            delete_task,
            launch,
            app_env,
            open_path,
            reveal_in_folder
        ])
        .run(tauri::generate_context!())
        .expect("claude1 桌面端启动失败");
}
