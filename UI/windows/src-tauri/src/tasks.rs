//! 计划任务 CRUD 与应用运行期间的持久认领调度。
//!
//! 持久化到 `agent-hub-tasks.json`（CONTRACT.md §1：顶层是任务对象数组，
//! 原子替换写入，每个任务条目里的未知键原样保留——所以落盘用原始 JSON 地图操作，
//! 不走结构体往返，未知键不会被序列化丢掉）。
//!
//! `scheduleText` / `nextRunAt` 不落盘：每次读出时按 cron 现算（CONTRACT.md §2：
//! 由 Rust 侧计算返回，前端不自算；disabled 时 nextRunAt 为 null）。

use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::channels::SLOT_ORDER;
use crate::cron;
use crate::error;
use crate::launch::LaunchTarget;
use crate::paths;

/// 三种任务类型。
pub const KINDS: [&str; 3] = ["launch-channel", "launch-slot", "doctor-reminder"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledTask {
    pub id: String,
    pub name: String,
    /// 'launch-channel' | 'launch-slot' | 'doctor-reminder'
    pub kind: String,
    /// 复用 LaunchTarget 形状的子集；doctor-reminder 为 None
    pub target: Option<LaunchTarget>,
    /// cron 五字段字符串（分 时 日 月 周）
    pub schedule: String,
    /// schedule 的中文人话
    pub schedule_text: String,
    pub enabled: bool,
    /// Last dispatch attempt, not model-session completion.
    pub last_run_at: Option<i64>,
    pub last_run_status: Option<String>,
    pub last_run_message: Option<String>,
    /// unix 秒，按 cron 现算；disabled 或表达式无法解析时为 None
    pub next_run_at: Option<i64>,
    pub created_at: i64,
}

/// `create_task` 的入参：id / 时间戳 / scheduleText / nextRunAt 都由 Rust 侧补全。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewScheduledTask {
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub target: Option<LaunchTarget>,
    pub schedule: String,
    pub enabled: bool,
}

/// `update_task` 的补丁：只认 enabled / schedule / name 三个键。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub schedule: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

// ---------------------------------------------------------------------------
// 文件读写
// ---------------------------------------------------------------------------

/// 读全量任务条目（原始 JSON 地图）。文件缺失返回空数组，不报错（CONTRACT.md §3）；
/// 存在但坏了就报错，不假装成空清单。
fn load_entries() -> Result<Vec<Map<String, Value>>, String> {
    let path = paths::tasks_path()?;
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(error::io_error("读取 ", &path, &err)),
    };
    if text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let value: Value = serde_json::from_str(&text).map_err(|err| error::json_error(&path, &err))?;
    let Value::Array(items) = value else {
        return Err(format!("{} 的顶层必须是任务数组", error::tilde(&path)));
    };
    items
        .into_iter()
        .enumerate()
        .map(|(index, item)| match item {
            Value::Object(map) => Ok(map),
            _ => Err(format!(
                "{} 的第 {} 个条目不是对象",
                error::tilde(&path),
                index + 1
            )),
        })
        .collect()
}

fn write_entries(entries: &[Map<String, Value>]) -> Result<(), String> {
    let path = paths::tasks_path()?;
    let value = Value::Array(entries.iter().map(|entry| Value::Object(entry.clone())).collect());
    paths::write_json_atomic(&path, &value)?;
    #[cfg(unix)]
    std::fs::File::open(path.parent().ok_or("任务路径缺少父目录")?).and_then(|file| file.sync_all()).map_err(|e| format!("任务目录落盘失败：{e}"))?;
    Ok(())
}

pub fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|span| span.as_secs() as i64)
        .unwrap_or(0)
}

/// 任务 id：时间戳（纳秒）+ 进程内序号，不引 uuid 库。
static TASK_SEQ: AtomicU64 = AtomicU64::new(0);

fn new_task_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|span| span.as_nanos())
        .unwrap_or(0);
    let seq = TASK_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("task-{nanos:x}-{seq}")
}

// ---------------------------------------------------------------------------
// 校验与视图构造
// ---------------------------------------------------------------------------

/// 校验 name / kind / schedule / target 的组合。错误是给人看的中文。
fn validate(
    name: &str,
    kind: &str,
    target: Option<&LaunchTarget>,
    schedule: &str,
) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("任务名称不能为空".to_string());
    }
    if !KINDS.contains(&kind) {
        return Err(format!(
            "不认识的任务类型：{kind}（只支持 {}）",
            KINDS.join("、")
        ));
    }
    cron::parse(schedule).map_err(|err| format!("任务的 cron 表达式无效：{err}"))?;
    if let Some(target) = target {
        if !["claude", "codex"].contains(&target.app_type.as_str()) {
            return Err("target.appType 必须是 claude 或 codex".into());
        }
        if kind == "launch-slot" && target.app_type != "claude" {
            return Err("launch-slot 仅支持 Claude".into());
        }
    }
    match kind {
        "doctor-reminder" => {
            if target.is_some() {
                return Err("体检提醒（doctor-reminder）不带启动目标，target 必须是 null".to_string());
            }
        }
        "launch-channel" => {
            let target =
                target.ok_or_else(|| "定时启动渠道（launch-channel）需要 target".to_string())?;
            if target.kind != "channel" {
                return Err(format!(
                    "launch-channel 的 target.kind 必须是 channel，收到：{}",
                    target.kind
                ));
            }
            if target
                .channel_id
                .as_deref()
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .is_none()
            {
                return Err("launch-channel 的 target 需要 channelId".to_string());
            }
        }
        "launch-slot" => {
            let target =
                target.ok_or_else(|| "定时启动槽位（launch-slot）需要 target".to_string())?;
            if target.kind != "slot" {
                return Err(format!(
                    "launch-slot 的 target.kind 必须是 slot，收到：{}",
                    target.kind
                ));
            }
            let slot = target.slot.as_deref().map(str::trim).unwrap_or("");
            if !SLOT_ORDER.contains(&slot) {
                return Err(format!(
                    "launch-slot 的 target.slot 只能是 {}，收到：{slot}",
                    SLOT_ORDER.join("、")
                ));
            }
        }
        _ => unreachable!("KINDS 已校验"),
    }
    Ok(())
}

/// 把落盘的原始条目变成 IPC 视图：补 scheduleText 与 nextRunAt。
fn build_view(entry: &Map<String, Value>) -> Result<ScheduledTask, String> {
    let id = entry
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "agent-hub-tasks.json 里有缺 id 的任务条目".to_string())?
        .to_string();
    let name = entry
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("（未命名任务）")
        .to_string();
    let kind = entry
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("doctor-reminder")
        .to_string();
    // 手改文件可能写出 KINDS 之外的 kind：原样透传会在前端变成不可观测的静默降级
    //（空徽章、编辑对话框无选中段）。按「有损但可观测」原则收进最近似的合法值
    //（无 target 就是纯提醒类），并在 scheduleText 里说明原值，让用户看到并改回来。
    let mut notes: Vec<String> = Vec::new();
    let kind = if KINDS.contains(&kind.as_str()) {
        kind
    } else {
        notes.push(format!(
            "kind「{kind}」不在支持列表（{}），已按 doctor-reminder 展示",
            KINDS.join("、")
        ));
        "doctor-reminder".to_string()
    };
    let target = match entry.get("target") {
        Some(value) if !value.is_null() => Some(
            serde_json::from_value::<LaunchTarget>(value.clone())
                .map_err(|err| format!("任务 {id} 的 target 形状不对：{err}"))?,
        ),
        _ => None,
    };
    let schedule = entry
        .get("schedule")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let enabled = entry
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let last_run_at = entry.get("lastRunAt").and_then(Value::as_i64);
    let created_at = entry.get("createdAt").and_then(Value::as_i64).unwrap_or(0);

    // 老文件里手写出无法解析的表达式时，不掀翻整个清单：
    // scheduleText 说明问题、nextRunAt 置 null，让用户看到并改回来。
    let (mut schedule_text, mut next_run_at) = match cron::parse(&schedule) {
        Ok(parsed) => (cron::schedule_text(&parsed, &schedule), cron::next_run(&parsed, now_ts())),
        Err(err) => (format!("cron 表达式无法解析：{err}"), None),
    };
    if !enabled {
        next_run_at = None;
    }
    if !notes.is_empty() {
        schedule_text = format!("{schedule_text}（{}）", notes.join("；"));
    }

    Ok(ScheduledTask {
        id,
        name,
        kind,
        target,
        schedule,
        schedule_text,
        enabled,
        last_run_at,
        last_run_status: entry.get("lastRunStatus").and_then(Value::as_str).map(str::to_string),
        last_run_message: entry.get("lastRunMessage").and_then(Value::as_str).map(crate::redact::redact_text),
        next_run_at,
        created_at,
    })
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

pub fn list_tasks() -> Result<Vec<ScheduledTask>, String> {
    load_entries()?.iter().map(build_view).collect()
}

pub fn create_task(task: NewScheduledTask) -> Result<ScheduledTask, String> {
    let name = task.name.trim().to_string();
    let schedule = task.schedule.trim().to_string();
    validate(&name, &task.kind, task.target.as_ref(), &schedule)?;

    let mut entry = Map::new();
    entry.insert("id".into(), Value::String(new_task_id()));
    entry.insert("name".into(), Value::String(name));
    entry.insert("kind".into(), Value::String(task.kind));
    match task.target {
        Some(target) => entry.insert(
            "target".into(),
            serde_json::to_value(target).map_err(|err| format!("序列化 target 失败：{err}"))?,
        ),
        None => entry.insert("target".into(), Value::Null),
    };
    entry.insert("schedule".into(), Value::String(schedule));
    entry.insert("enabled".into(), Value::Bool(task.enabled));
    entry.insert("lastRunAt".into(), Value::Null);
    entry.insert("createdAt".into(), Value::from(now_ts()));

    let _lock = task_lock()?;
    let mut entries = load_entries()?;
    entries.push(entry);
    write_entries(&entries)?;
    build_view(entries.last().expect("刚 push 过"))
}

pub fn update_task(id: &str, patch: TaskPatch) -> Result<ScheduledTask, String> {
    let _lock = task_lock()?;
    let mut entries = load_entries()?;
    let index = entries
        .iter()
        .position(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| format!("找不到计划任务：{id}"))?;
    let entry = &mut entries[index];

    if patch.schedule.is_some() || patch.enabled == Some(true) {
        entry.insert("armedAt".into(), Value::from(now_ts()));
    }
    if let Some(name) = patch.name {
        let name = name.trim().to_string();
        if name.is_empty() {
            return Err("任务名称不能为空".to_string());
        }
        entry.insert("name".into(), Value::String(name));
    }
    if let Some(schedule) = patch.schedule {
        let schedule = schedule.trim().to_string();
        cron::parse(&schedule).map_err(|err| format!("任务的 cron 表达式无效：{err}"))?;
        entry.insert("schedule".into(), Value::String(schedule));
    }
    if let Some(enabled) = patch.enabled {
        entry.insert("enabled".into(), Value::Bool(enabled));
    }

    let view = build_view(entry)?;
    write_entries(&entries)?;
    Ok(view)
}

pub fn delete_task(id: &str) -> Result<(), String> {
    let _lock = task_lock()?;
    let mut entries = load_entries()?;
    let before = entries.len();
    entries.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id));
    if entries.len() == before {
        return Err(format!("找不到计划任务：{id}"));
    }
    write_entries(&entries)
}

/// The lock is shared by CRUD and occurrence claims, including other app processes.
fn task_lock() -> Result<std::fs::File, String> {
    use fs2::FileExt;
    let path = paths::tasks_path()?.with_extension("json.lock");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| error::io_error("创建任务目录 ", parent, &e))?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)] {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&path).map_err(|e| error::io_error("打开任务锁 ", &path, &e))?;
    file.try_lock_exclusive().map_err(|_| "任务文件正在更新，请稍后重试".to_string())?;
    Ok(file)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRun {
    pub task_id: String,
    pub name: String,
    pub kind: String,
    pub occurrence_at: i64,
    pub status: String,
    pub message: String,
}

/// At most one dispatch attempt per occurrence. No startup, sleep-gap or rollback catch-up.
/// A durable `unconfirmed` claim is never retried: a crash may occur after terminal handoff.
/// A pause after claim cannot recall a dispatch already accepted by this function.
pub fn run_due(
    previous: i64,
    now: i64,
    mut dispatch: impl FnMut(&ScheduledTask) -> Result<String, String>,
) -> Result<Vec<TaskRun>, String> {
    if now <= previous || now - previous > 60 || !paths::tasks_path()?.exists() {
        return Ok(Vec::new());
    }
    let ids: Vec<String> = load_entries()?.iter().filter_map(|e| e.get("id")?.as_str().map(str::to_string)).collect();
    let mut runs = Vec::new();
    for id in ids {
        let claim = {
            let _lock = task_lock()?;
            let mut entries = load_entries()?;
            let Some(index) = entries.iter().position(|e| e.get("id").and_then(Value::as_str) == Some(&id)) else { continue };
            let entry = &mut entries[index];
            if entry.get("enabled").and_then(Value::as_bool) != Some(true) { continue; }
            let Ok(task) = build_view(entry) else { continue };
            // Display degradation must never turn an unknown kind into executable work.
            if entry.get("kind").and_then(Value::as_str) != Some(task.kind.as_str()) { continue; }
            if validate(&task.name, &task.kind, task.target.as_ref(), &task.schedule).is_err() { continue; }
            let schedule = cron::parse(&task.schedule)?;
            let after = previous.max(entry.get("armedAt").and_then(Value::as_i64).unwrap_or(task.created_at));
            let Some(due) = cron::next_run(&schedule, after) else { continue };
            if due > now || entry.get("lastClaimAt").and_then(Value::as_i64).is_some_and(|claimed| claimed >= due) { continue; }
            entry.insert("lastClaimAt".into(), Value::from(due));
            entry.insert("lastRunAt".into(), Value::from(now));
            entry.insert("lastRunStatus".into(), Value::from("unconfirmed"));
            entry.insert("lastRunMessage".into(), Value::from("已认领；若应用中断，结果无法确认，不自动重试"));
            write_entries(&entries)?; // If durability fails, no side effect is allowed.
            (task, due)
        };
        let (task, due) = claim;
        let (status, message) = match dispatch(&task) {
            Ok(message) => (if task.kind == "doctor-reminder" { "reminded" } else { "dispatched" }, message),
            Err(message) => ("failed", crate::redact::redact_text(&message)),
        };
        // Merge into fresh data: concurrent pause/edit/delete must never be undone.
        {
            let _lock = task_lock()?;
            let mut entries = load_entries()?;
            if let Some(entry) = entries.iter_mut().find(|e| e.get("id").and_then(Value::as_str) == Some(&id)) {
                if entry.get("lastClaimAt").and_then(Value::as_i64) == Some(due) {
                    entry.insert("lastRunStatus".into(), Value::from(status));
                    entry.insert("lastRunMessage".into(), Value::from(message.clone()));
                    write_entries(&entries)?;
                }
            }
        }
        runs.push(TaskRun { task_id: id, name: task.name, kind: task.kind, occurrence_at: due, status: status.into(), message });
    }
    Ok(runs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// AGENT_HUB_TASKS_PATH 是进程级环境变量，这些测试必须串行。
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct TasksEnv {
        dir: std::path::PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl TasksEnv {
        fn new(tag: &str) -> Self {
            let guard = ENV_LOCK.lock().unwrap();
            let dir = std::env::temp_dir().join(format!("claude1-desktop-tasks-{tag}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            std::env::set_var("AGENT_HUB_TASKS_PATH", dir.join("agent-hub-tasks.json"));
            TasksEnv { dir, _guard: guard }
        }
    }

    impl Drop for TasksEnv {
        fn drop(&mut self) {
            std::env::remove_var("AGENT_HUB_TASKS_PATH");
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn new_task(name: &str, kind: &str, schedule: &str) -> NewScheduledTask {
        NewScheduledTask {
            name: name.to_string(),
            kind: kind.to_string(),
            target: None,
            schedule: schedule.to_string(),
            enabled: true,
        }
    }

    fn due_fixture() -> (ScheduledTask, i64) {
        let task = create_task(new_task("synthetic", "doctor-reminder", "* * * * *")).unwrap();
        (task, (now_ts() / 60 + 2) * 60)
    }

    #[test]
    fn scheduler_claims_once_and_preserves_concurrent_pause_and_unknown_fields() {
        let _env = TasksEnv::new("scheduler-once");
        let (task, due) = due_fixture();
        let mut entries = load_entries().unwrap();
        entries[0].insert("futureKey".into(), Value::from(42));
        write_entries(&entries).unwrap();
        let runs = run_due(due - 1, due, |_| {
            update_task(&task.id, TaskPatch { enabled: Some(false), schedule: None, name: Some("renamed".into()) }).unwrap();
            Ok("reminder stored".into())
        }).unwrap();
        assert_eq!(runs.len(), 1);
        let raw = load_entries().unwrap();
        assert_eq!(raw[0]["futureKey"], 42);
        assert_eq!(raw[0]["enabled"], false);
        assert_eq!(raw[0]["name"], "renamed");
        assert_eq!(raw[0]["lastRunStatus"], "reminded");
        assert!(run_due(due - 1, due, |_| panic!("duplicate")).unwrap().is_empty());
        assert!(run_due(due + 1, due, |_| panic!("clock rollback")).unwrap().is_empty());
        assert!(run_due(due, due + 120, |_| panic!("sleep catch-up")).unwrap().is_empty());
    }

    #[test]
    fn scheduler_failed_and_interrupted_attempts_are_not_retried() {
        let _env = TasksEnv::new("scheduler-failure");
        let (_, due) = due_fixture();
        let runs = run_due(due - 1, due, |_| Err("synthetic dispatch failure".into())).unwrap();
        assert_eq!(runs[0].status, "failed");
        assert!(run_due(due - 1, due, |_| panic!("retry")).unwrap().is_empty());
        let interrupted = std::panic::catch_unwind(|| run_due(due + 59, due + 60, |_| panic!("crash after claim")));
        assert!(interrupted.is_err());
        assert_eq!(load_entries().unwrap()[0]["lastRunStatus"], "unconfirmed");
        assert!(run_due(due + 59, due + 60, |_| panic!("crash retry")).unwrap().is_empty());
        assert!(run_due(due + 60, due + 60, |_| panic!("startup catch-up")).unwrap().is_empty());
    }

    #[test]
    fn scheduler_refuses_invalid_targets_paused_tasks_and_locked_writes() {
        let _env = TasksEnv::new("scheduler-invalid");
        let (task, due) = due_fixture();
        let lock = task_lock().unwrap();
        assert!(run_due(due - 1, due, |_| panic!("unpersisted claim")).is_err());
        assert!(delete_task(&task.id).is_err());
        drop(lock);
        let baseline = load_entries().unwrap();
        for (key, value) in [("kind", Value::from("future-kind")), ("schedule", Value::from("bad cron")), ("enabled", Value::from(false))] {
            let mut entries = baseline.clone();
            entries[0].insert(key.into(), value);
            write_entries(&entries).unwrap();
            assert!(run_due(due - 1, due, |_| panic!("invalid dispatch")).unwrap().is_empty());
        }
    }

    #[test]
    fn completing_a_dispatch_cannot_restore_a_deleted_task_or_old_schedule() {
        let _env = TasksEnv::new("scheduler-delete");
        let (task, due) = due_fixture();
        run_due(due - 1, due, |_| {
            update_task(&task.id, TaskPatch { enabled: None, schedule: Some("0 9 * * *".into()), name: None }).unwrap();
            Ok("synthetic".into())
        }).unwrap();
        assert_eq!(load_entries().unwrap()[0]["schedule"], "0 9 * * *");
        let mut entries = load_entries().unwrap();
        entries[0].insert("schedule".into(), Value::from("* * * * *"));
        write_entries(&entries).unwrap();
        run_due(due + 59, due + 60, |_| { delete_task(&task.id).unwrap(); Ok("synthetic".into()) }).unwrap();
        assert!(list_tasks().unwrap().is_empty());
    }

    #[test]
    fn concurrent_scheduler_instances_dispatch_only_once() {
        let _env = TasksEnv::new("scheduler-concurrent");
        let (_, due) = due_fixture();
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let handles: Vec<_> = (0..2).map(|_| {
            let count = count.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let _ = run_due(due - 1, due, |_| { count.fetch_add(1, Ordering::SeqCst); Ok("synthetic".into()) });
            })
        }).collect();
        for handle in handles { handle.join().unwrap(); }
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn task_targets_validate_application_and_default_legacy_to_claude() {
        let mut target: LaunchTarget = serde_json::from_value(serde_json::json!({"kind":"channel","channelId":"same"})).unwrap();
        assert_eq!(target.app_type, "claude");
        assert!(validate("fixture", "launch-channel", Some(&target), "0 9 * * *").is_ok());
        target.app_type = "codex".into();
        assert!(validate("fixture", "launch-channel", Some(&target), "0 9 * * *").is_ok());
        target.kind = "slot".into(); target.slot = Some("opus".into());
        assert!(validate("fixture", "launch-slot", Some(&target), "0 9 * * *").is_err());
        target.app_type = "unknown".into(); target.kind = "channel".into();
        assert!(validate("fixture", "launch-channel", Some(&target), "0 9 * * *").unwrap_err().contains("appType"));
    }

    #[test]
    fn missing_file_lists_empty_without_error() {
        let _env = TasksEnv::new("missing");
        assert!(list_tasks().unwrap().is_empty());
    }

    #[test]
    fn create_list_update_delete_roundtrip() {
        let _env = TasksEnv::new("roundtrip");

        let created = create_task(new_task("早会前开渠道", "doctor-reminder", "0 9 * * 1-5")).unwrap();
        assert!(created.id.starts_with("task-"));
        assert_eq!(created.schedule_text, "每工作日 09:00");
        assert!(created.next_run_at.is_some(), "启用中必须有 nextRunAt");
        assert!(created.created_at > 0);

        // 未知键在更新后仍然保留
        let path = paths::tasks_path().unwrap();
        let mut raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        raw[0]["未来新键"] = Value::from(42);
        paths::write_json_atomic(&path, &raw).unwrap();

        let updated = update_task(
            &created.id,
            TaskPatch {
                enabled: Some(false),
                schedule: Some("*/30 * * * *".to_string()),
                name: Some("  改名了  ".to_string()),
            },
        )
        .unwrap();
        assert_eq!(updated.name, "改名了");
        assert_eq!(updated.schedule_text, "每 30 分钟");
        assert_eq!(updated.next_run_at, None, "disabled 时 nextRunAt 必须是 null");

        // 重新启用后 nextRunAt 回来了，未知键还在
        let reenabled = update_task(
            &created.id,
            TaskPatch {
                enabled: Some(true),
                schedule: None,
                name: None,
            },
        )
        .unwrap();
        assert!(reenabled.next_run_at.is_some());
        let raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw[0]["未来新键"], Value::from(42));

        let list = list_tasks().unwrap();
        assert_eq!(list.len(), 1);

        delete_task(&created.id).unwrap();
        assert!(list_tasks().unwrap().is_empty());
        assert!(delete_task(&created.id)
            .unwrap_err()
            .contains("找不到计划任务"));
    }

    #[test]
    fn create_validates_kind_schedule_and_target() {
        let _env = TasksEnv::new("validate");
        assert!(create_task(new_task("x", "nonsense", "0 9 * * *"))
            .unwrap_err()
            .contains("不认识的任务类型"));
        assert!(create_task(new_task("x", "doctor-reminder", "61 9 * * *"))
            .unwrap_err()
            .contains("cron 表达式无效"));
        assert!(create_task(new_task("   ", "doctor-reminder", "0 9 * * *"))
            .unwrap_err()
            .contains("不能为空"));
        // doctor-reminder 不许带 target；launch-channel 必须有 channelId
        let mut task = new_task("x", "doctor-reminder", "0 9 * * *");
        task.target = Some(LaunchTarget {
            app_type: "claude".into(),
            kind: "channel".into(),
            channel_id: Some("ch-1".into()),
            hub_name: None,
            slot: None,
            model: None,
        });
        assert!(create_task(task).unwrap_err().contains("doctor-reminder"));
        let mut task = new_task("x", "launch-channel", "0 9 * * *");
        task.target = Some(LaunchTarget {
            app_type: "claude".into(),
            kind: "channel".into(),
            channel_id: None,
            hub_name: None,
            slot: None,
            model: None,
        });
        assert!(create_task(task).unwrap_err().contains("channelId"));
    }

    #[test]
    fn update_rejects_bad_schedule_and_unknown_id() {
        let _env = TasksEnv::new("update");
        let created = create_task(new_task("x", "doctor-reminder", "0 9 * * *")).unwrap();
        assert!(update_task(
            &created.id,
            TaskPatch {
                enabled: None,
                schedule: Some("0 25 * * *".to_string()),
                name: None,
            }
        )
        .unwrap_err()
        .contains("cron 表达式无效"));
        assert!(update_task(
            "task-nope",
            TaskPatch {
                enabled: Some(true),
                schedule: None,
                name: None,
            }
        )
        .unwrap_err()
        .contains("找不到计划任务"));
    }

    #[test]
    fn unparsable_schedule_in_file_degrades_to_null_next_run() {
        let _env = TasksEnv::new("degrade");
        let created = create_task(new_task("x", "doctor-reminder", "0 9 * * *")).unwrap();
        // 模拟手改文件把 schedule 写坏
        let path = paths::tasks_path().unwrap();
        let mut raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        raw[0]["schedule"] = Value::from("不是 cron");
        paths::write_json_atomic(&path, &raw).unwrap();

        let list = list_tasks().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, created.id);
        assert_eq!(list[0].next_run_at, None);
        assert!(list[0].schedule_text.contains("无法解析"), "{}", list[0].schedule_text);
    }

    #[test]
    fn unknown_kind_in_file_degrades_observably() {
        let _env = TasksEnv::new("unknown-kind");
        create_task(new_task("x", "doctor-reminder", "0 9 * * *")).unwrap();
        // 模拟手改文件写进 KINDS 之外的 kind
        let path = paths::tasks_path().unwrap();
        let mut raw: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        raw[0]["kind"] = Value::from("future-kind");
        paths::write_json_atomic(&path, &raw).unwrap();

        let list = list_tasks().unwrap();
        // 不掀翻清单，但必须留下可观测的降级记号，前端徽章/编辑对话框不落空
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].kind, "doctor-reminder");
        assert!(list[0].schedule_text.contains("future-kind"), "{}", list[0].schedule_text);
    }
}
