//! 计划任务（ScheduledTask）的本地 CRUD。
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
    /// unix 秒，未跑过为 None（执行层本轮不做，只透传已有值）
    pub last_run_at: Option<i64>,
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
    paths::write_json_atomic(&path, &value)
}

fn now_ts() -> i64 {
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
    let (schedule_text, mut next_run_at) = match cron::parse(&schedule) {
        Ok(parsed) => (cron::schedule_text(&parsed, &schedule), cron::next_run(&parsed, now_ts())),
        Err(err) => (format!("cron 表达式无法解析：{err}"), None),
    };
    if !enabled {
        next_run_at = None;
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

    let mut entries = load_entries()?;
    entries.push(entry);
    write_entries(&entries)?;
    build_view(entries.last().expect("刚 push 过"))
}

pub fn update_task(id: &str, patch: TaskPatch) -> Result<ScheduledTask, String> {
    let mut entries = load_entries()?;
    let index = entries
        .iter()
        .position(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
        .ok_or_else(|| format!("找不到计划任务：{id}"))?;
    let entry = &mut entries[index];

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
    let mut entries = load_entries()?;
    let before = entries.len();
    entries.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id));
    if entries.len() == before {
        return Err(format!("找不到计划任务：{id}"));
    }
    write_entries(&entries)
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
            kind: "channel".into(),
            channel_id: Some("ch-1".into()),
            hub_name: None,
            slot: None,
            model: None,
        });
        assert!(create_task(task).unwrap_err().contains("doctor-reminder"));
        let mut task = new_task("x", "launch-channel", "0 9 * * *");
        task.target = Some(LaunchTarget {
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
}
