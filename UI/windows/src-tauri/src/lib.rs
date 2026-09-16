//! claude1 桌面端的 Rust 侧：只读本机真实文件，写只碰两类本地 JSON。
//!
//! 全部命令返回 `Result<T, String>`，错误字符串就是给人看的中文原因
//! （AGENTS.md：错误原样暴露，不伪装成功）。

mod provider_management;
mod channels;
mod chat;
mod chat_hub;
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
mod sse;
mod tasks;
mod pull_requests;

use std::os::windows::process::CommandExt;
use std::path::Path;
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
fn set_channel_hidden(id: String, hidden: bool, app_type: String) -> Result<(), String> {
    provider_management::require_claude(&app_type)?;
    channels::set_channel_hidden(&id, hidden)
}

#[tauri::command]
fn set_channel_alias(id: String, alias: Option<String>, app_type: String) -> Result<(), String> {
    provider_management::require_claude(&app_type)?;
    channels::set_channel_alias(&id, alias.as_deref())
}

#[tauri::command]
fn set_channel_override(
    app_type: String,
    id: String,
    model: Option<String>,
    effort: Option<String>,
) -> Result<(), String> {
    provider_management::require_claude(&app_type)?;
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
fn usage_summary(
    hub_name: Option<String>,
    from_ts: i64,
    to_ts: i64,
    granularity: String,
) -> Result<journal::UsageSummary, String> {
    let granularity = Granularity::parse(&granularity)?;
    let primary = hubs::usage_path_for(hub_name.as_deref())?;
    let files = journal::journal_files(&primary);
    let (rows, _report) = journal::scan_usage(&files)?;

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
    Ok(summary)
}

#[tauri::command]
fn recent_usage(limit: usize, hub_name: Option<String>) -> Result<Vec<journal::UsageRow>, String> {
    let primary = hubs::usage_path_for(hub_name.as_deref())?;
    let files = journal::journal_files(&primary);
    journal::recent_usage(&files, limit)
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

/// JS 侧签名不变（`sessionId, content` → `ChatMessage`）：`app` 由 Tauri 注入，
/// 用于把流式增量经 `chat-stream` / `chat-stream-end` / `chat-stream-error` 推给前端。
#[tauri::command]
async fn send_chat_message(
    app: tauri::AppHandle,
    session_id: String,
    content: String,
) -> Result<chat::ChatMessage, String> {
    chat::send_chat_message(&app, &session_id, &content).await
}

#[tauri::command]
fn chat_projects() -> Result<Vec<chat::ChatProject>, String> {
    chat::chat_projects()
}

#[tauri::command]
fn select_chat_project(key: String) -> Result<(), String> {
    chat::select_chat_project(&key)
}

#[tauri::command]
fn create_chat_session(
    hub_name: Option<String>,
    channel_id: String,
) -> Result<chat::ChatSession, String> {
    chat::create_chat_session(hub_name, channel_id)
}

#[tauri::command]
fn delete_chat_session(id: String) -> Result<(), String> {
    chat::delete_chat_session(&id)
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
    run_start(&checked, &path)
}

#[tauri::command]
fn reveal_in_folder(path: String) -> Result<(), String> {
    let checked = paths::ensure_openable(&path)?;
    run_reveal(&checked, &path)
}

/// 把路径包进双引号，交给自己拼的命令行。
///
/// 必须自己包引号：Rust 只在参数含空格时才加引号，而路径里裸奔的 `&`、`^` 会被 cmd
/// 当成语法——`~\.cc-switch\hubs\a&b.json` 就足够让 cmd 多跑一条命令。
/// Windows 的文件名不允许出现 `"`，所以包起来就够，不需要再转义。
/// 剩一个已知的小毛病：cmd 会展开双引号内的 `%VAR%`，文件名真带 `%` 时会被展开成
/// 一个不存在的路径，于是 start 报「找不到文件」。那是如实的失败，不是伪装成功，
/// 而且展开结果里不可能凭空出现路径分隔符，逃不出白名单。
fn quote_path(path: &Path) -> String {
    format!("\"{}\"", path.display())
}

/// 用系统默认程序打开（CONTRACT.md 3.1 节的 `cmd /c start`）。
fn run_start(target: &Path, shown: &str) -> Result<(), String> {
    // `start` 的第一个带引号的参数会被当成窗口标题，所以先给一个空标题，
    // 否则真正的路径就被吃成标题了。
    let output = Command::new(launch::comspec())
        .raw_arg(format!("/c start \"\" {}", quote_path(target)))
        .output()
        .map_err(|err| format!("无法调用 cmd 打开 {shown}：{err}"))?;
    if output.status.success() {
        return Ok(());
    }
    // cmd 的错误话在 stdout 与 stderr 都可能出现，两边都捞
    let mut detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if detail.is_empty() {
        detail = String::from_utf8_lossy(&output.stdout).trim().to_string();
    }
    Err(redact::redact_text(&format!(
        "打开 {shown} 失败：{}",
        if detail.is_empty() {
            format!("cmd 退出码 {:?}", output.status.code())
        } else {
            detail
        }
    )))
}

/// 在资源管理器里选中这个路径。
///
/// `explorer.exe` 的参数解析很特别：`/select` 后面必须紧跟逗号和路径，而且引号只能包
/// 路径本身——把 `/select,<路径>` 整个包起来它会当成一个文件夹名去找。所以用 raw_arg
/// 自己拼，不让 Rust 的默认加引号规则插手。
///
/// 只判「起没起来」，不判退出码：explorer.exe 成功时也经常返回 1，拿它当失败会把
/// 一次正常的定位报成错误——那和伪装成功一样是谎，只是方向相反。
fn run_reveal(target: &Path, shown: &str) -> Result<(), String> {
    Command::new("explorer.exe")
        .raw_arg(format!("/select,{}", quote_path(target)))
        .spawn()
        .map_err(|err| {
            redact::redact_text(&format!("无法调用 explorer 定位 {shown}：{err}"))
        })?;
    Ok(())
}

#[tauri::command]
async fn list_pull_requests(filter: String, repository: String) -> Result<Vec<pull_requests::PullRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || pull_requests::list(&filter, &repository)).await.map_err(|_| "PR 查询中断".to_string())?
}
#[tauri::command]
fn open_pull_request(url: String) -> Result<(), String> { pull_requests::open(&url) }

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Emitter;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut previous = tasks::now_ts();
                let mut last_error: Option<String> = None;
                loop {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let now = tasks::now_ts();
                    let result = tasks::run_due(previous, now, |task| {
                        if task.kind == "doctor-reminder" {
                            return Ok("体检提醒已记录，请打开本机体检 / Reminder recorded; open Diagnostics".into());
                        }
                        let target = task.target.clone().ok_or("任务缺少启动目标")?;
                        let result = launch::launch(target)?;
                        if result.ok { Ok(result.message) } else { Err(result.message) }
                    });
                    match result {
                        Ok(runs) => {
                            previous = now;
                            last_error = None;
                            for run in runs { let _ = handle.emit("scheduled-task-run", run); }
                        }
                        Err(error) => {
                            if last_error.as_ref() != Some(&error) {
                                let _ = handle.emit("scheduled-task-error", crate::redact::redact_text(&error));
                            }
                            last_error = Some(error);
                        }
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            provider_management::preview_import, provider_management::select_import,
            provider_management::apply_import, provider_management::cancel_import,
            provider_management::provider_edit_view, provider_management::save_provider,
            provider_management::remove_provider, provider_management::credential_status,
            provider_management::migrate_credentials,
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
            chat_projects,
            select_chat_project,
            create_chat_session,
            delete_chat_session,
            list_plugins,
            set_plugin_enabled,
            list_pull_requests,
            open_pull_request,
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
