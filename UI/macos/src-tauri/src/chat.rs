//! 对话：真实 hub 上游（CONTRACT.md §3 list_chat_sessions / send_chat_message）。
//!
//! 两类会话：
//! - `source == "history"`：只读回放 `~/.claude/projects/<project_key>/*.jsonl`；
//! - `source == "local"`：可写，发送时经 `chat_hub` 真连 hub 的 `POST /v1/messages`（SSE 流式）。
//!
//! 落盘只有一处：`~/.cc-switch/agent-hub-chat.json`（本地会话 + 当前选中项目），
//! 原子替换 + 保留未知键 + 0600，与 `agent-hub-tasks.json` 同一套惯例。历史只读。
//!
//! 终态纪律：只有上游真的发了 `message_stop` 才算 stop；流干净结束但没有终态帧记
//! `truncated`，落盘已收到的部分文本 + 一条 system 说明，然后如实报错——绝不补一个
//! `message_stop` 把截断伪装成成功。
//!
//! 凭证：所有进 IPC 的正文（含历史回放、标题、事件增量）都过 `redact::redact_text`；
//! token 只存在于 `chat_hub` 内部，绝不进这里的数据结构。

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

use serde::Serialize;
use serde_json::{json, Map, Value};
use tauri::Emitter;

use crate::channels;
use crate::chat_hub::{self, Outcome};
use crate::error;
use crate::hubs;
use crate::paths;
use crate::redact;

/// 列表里最多回放多少个历史会话（按文件 mtime 倒序取最近的）。
const HISTORY_SESSION_LIMIT: usize = 50;
/// 选中项目后，每个历史会话最多读最近多少条消息。
const HISTORY_MESSAGE_LIMIT: usize = 200;
/// 发送时带上该会话最近多少条消息。
const REQUEST_MESSAGE_WINDOW: usize = 50;
/// 标题取首条 user 消息的前多少个字符。
const TITLE_MAX_CHARS: usize = 60;
/// 新建本地会话的占位标题；首条 user 消息发出后换成真实标题。
const NEW_SESSION_TITLE: &str = "新会话";
/// 会话文件的版本号，只用于将来迁移。
const STORE_VERSION: i64 = 1;
/// 找项目显示路径时最多扫多少行。
const CWD_SCAN_LINES: usize = 50;
/// 截断时落盘的那句说明（与澄清口径同字面）。
const TRUNCATED_NOTE: &str = "回复被截断：上游未发送终止帧";

/// 事件名：正文增量。
pub const STREAM_EVENT: &str = "chat-stream";
/// 事件名：终态。
pub const STREAM_END_EVENT: &str = "chat-stream-end";
/// 事件名：失败（`ChatStreamError`，`message` 已脱敏）。
pub const STREAM_ERROR_EVENT: &str = "chat-stream-error";

/// 历史根目录的覆盖变量。
///
/// `CLAUDE_CONFIG_DIR` 是 Claude Code 自己的配置目录变量，`CLAUDE1_CLAUDE_HOME` 是
/// 本仓库测试用的同义覆盖（照 codex_usage.rs 的 `CODEX1_CODEX_HOME` 形态）。
const PROJECTS_ROOT_ENVS: [&str; 2] = ["CLAUDE_CONFIG_DIR", "CLAUDE1_CLAUDE_HOME"];

// ---------------------------------------------------------------------------
// IPC 类型
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    /// 进 IPC 前按 CONTRACT.md §1.2 过一遍凭证剥离
    pub content: String,
    /// unix 秒
    pub ts: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    /// 关联 Channel.id，未绑定渠道为 None
    pub channel_id: Option<String>,
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub created_at: i64,
    pub updated_at: i64,
    /// `"history"`（只读回放）或 `"local"`（可写、可真发送）
    pub source: String,
    /// 仅 local 有意义：绑定的 hub 名，None 是默认 hub
    pub hub_name: Option<String>,
    /// 仅 history 有意义：`~/.claude/projects` 下的目录名
    pub project_key: Option<String>,
}

/// 一个可回放的历史项目（`~/.claude/projects` 下的一个目录）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatProject {
    /// 目录名。**不可逆**，不是路径的反解（`-` 与路径里的连字符有歧义）
    pub key: String,
    /// 显示用路径：取 jsonl 里的 `cwd` 字段
    pub path: String,
    pub session_count: usize,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamDelta {
    pub session_id: String,
    pub request_id: String,
    pub delta: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamEnd {
    pub session_id: String,
    pub request_id: String,
    /// `"stop"`（收到上游终态）或 `"truncated"`（干净结束但没有终态帧）
    pub reason: String,
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamError {
    pub session_id: String,
    pub request_id: String,
    /// 已脱敏的错误原文
    pub message: String,
}

// ---------------------------------------------------------------------------
// 落盘：agent-hub-chat.json
// ---------------------------------------------------------------------------

/// 读全量存储（原始 JSON 地图，未知键因此保留）。文件缺失当空文件，不报错。
fn load_store() -> Result<Map<String, Value>, String> {
    let path = paths::chat_path()?;
    Ok(paths::read_json_object(&path)?.unwrap_or_default())
}

fn write_store(store: &Map<String, Value>) -> Result<(), String> {
    let path = paths::chat_path()?;
    paths::write_json_atomic(&path, &Value::Object(store.clone()))?;
    #[cfg(unix)]
    std::fs::File::open(path.parent().ok_or("对话路径缺少父目录")?)
        .and_then(|file| file.sync_all())
        .map_err(|e| format!("对话目录落盘失败：{e}"))?;
    Ok(())
}

/// 与 tasks.rs 同一把锁：CRUD 与并发写都串行。
fn chat_lock() -> Result<std::fs::File, String> {
    use fs2::FileExt;
    let path = paths::chat_path()?.with_extension("json.lock");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| error::io_error("创建对话目录 ", parent, &e))?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.create(true).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(&path)
        .map_err(|e| error::io_error("打开对话锁 ", &path, &e))?;
    file.try_lock_exclusive()
        .map_err(|_| "对话文件正在更新，请稍后重试".to_string())?;
    Ok(file)
}

fn session_entries(store: &Map<String, Value>) -> Vec<&Map<String, Value>> {
    store
        .get("sessions")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default()
}

fn sessions_array(store: &mut Map<String, Value>) -> &mut Vec<Value> {
    if !store.get("sessions").is_some_and(Value::is_array) {
        store.insert("sessions".into(), Value::Array(Vec::new()));
    }
    store
        .get_mut("sessions")
        .and_then(Value::as_array_mut)
        .expect("刚插入过 sessions 数组")
}

fn selected_project(store: &Map<String, Value>) -> Option<String> {
    store
        .get("selectedProject")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|key| is_plain_component(key))
        .map(str::to_string)
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|span| span.as_secs() as i64)
        .unwrap_or(0)
}

/// 会话 id / 请求 id：时间戳（纳秒）+ 进程内序号，不引 uuid 库。
static CHAT_SEQ: AtomicU64 = AtomicU64::new(0);

fn new_id(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|span| span.as_nanos())
        .unwrap_or(0);
    let seq = CHAT_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{nanos:x}-{seq}")
}

fn message_value(role: &str, content: &str, ts: i64) -> Value {
    json!({ "role": role, "content": content, "ts": ts })
}

/// 一条落盘的原始消息 → IPC 视图；形状不对就跳过（一条坏消息不该掀翻整个会话）。
fn build_message(value: &Value) -> Option<ChatMessage> {
    let fields = value.as_object()?;
    let role = fields.get("role")?.as_str()?.trim().to_ascii_lowercase();
    if role.is_empty() {
        return None;
    }
    let content = fields.get("content").and_then(Value::as_str).unwrap_or("");
    Some(ChatMessage {
        role,
        // 来源是文件里的原文，进 IPC 前一律过剥离
        content: redact::redact_text(content),
        ts: fields.get("ts").and_then(Value::as_i64).unwrap_or(0),
    })
}

/// 一条本地会话的原始条目 → IPC 视图。
fn build_local_session(entry: &Map<String, Value>) -> Result<ChatSession, String> {
    let id = entry
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(|| "agent-hub-chat.json 里有缺 id 的会话条目".to_string())?
        .to_string();
    let title = entry
        .get("title")
        .and_then(Value::as_str)
        .map(redact::redact_text)
        .map(|title| title.trim().to_string())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| NEW_SESSION_TITLE.to_string());
    let messages = entry
        .get("messages")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(build_message).collect())
        .unwrap_or_default();
    Ok(ChatSession {
        id,
        title,
        channel_id: entry
            .get("channelId")
            .and_then(Value::as_str)
            .map(str::to_string),
        model: entry
            .get("model")
            .and_then(Value::as_str)
            .map(redact::redact_text)
            .unwrap_or_default(),
        messages,
        created_at: entry.get("createdAt").and_then(Value::as_i64).unwrap_or(0),
        updated_at: entry.get("updatedAt").and_then(Value::as_i64).unwrap_or(0),
        source: "local".to_string(),
        hub_name: entry
            .get("hubName")
            .and_then(Value::as_str)
            .map(str::to_string),
        project_key: None,
    })
}

fn load_local_session(session_id: &str) -> Result<Option<ChatSession>, String> {
    let store = load_store()?;
    match session_entries(&store)
        .into_iter()
        .find(|entry| entry.get("id").and_then(Value::as_str) == Some(session_id))
    {
        Some(entry) => Ok(Some(build_local_session(entry)?)),
        None => Ok(None),
    }
}

/// 往本地会话追加一条消息（落盘、保留未知键），返回落盘后的这条消息。
///
/// 正文在这里过一次 `redact_text`：用户输入与上游原文都是「来自源数据的字符串」。
fn append_local_message(
    session_id: &str,
    role: &str,
    content: &str,
    ts: i64,
) -> Result<ChatMessage, String> {
    let role = role.trim().to_ascii_lowercase();
    let safe = redact::redact_text(content);
    let _lock = chat_lock()?;
    let mut store = load_store()?;
    let position = session_entries(&store)
        .iter()
        .position(|entry| entry.get("id").and_then(Value::as_str) == Some(session_id))
        .ok_or_else(|| redact::redact_text(&format!("找不到会话 {session_id}，请刷新会话列表")))?;
    {
        let entry = sessions_array(&mut store)[position]
            .as_object_mut()
            .ok_or_else(|| redact::redact_text(&format!("会话 {session_id} 的条目不是对象")))?;
        if !entry.get("messages").is_some_and(Value::is_array) {
            entry.insert("messages".into(), Value::Array(Vec::new()));
        }
        entry
            .get_mut("messages")
            .and_then(Value::as_array_mut)
            .ok_or_else(|| {
                redact::redact_text(&format!("会话 {session_id} 的 messages 不是数组"))
            })?
            .push(message_value(&role, &safe, ts));
        // 占位标题在首条 user 消息落盘时换成真实标题（与历史标题同一套取法）
        if role == "user" {
            let current = entry
                .get("title")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if current.is_empty() || current == NEW_SESSION_TITLE {
                let derived = truncate_title(&safe);
                if !derived.is_empty() {
                    entry.insert("title".into(), Value::String(derived));
                }
            }
        }
        entry.insert("updatedAt".into(), Value::from(ts));
    }
    write_store(&store)?;
    Ok(ChatMessage {
        role,
        content: safe,
        ts,
    })
}

// ---------------------------------------------------------------------------
// 历史：~/.claude/projects
// ---------------------------------------------------------------------------

/// 历史根目录：覆盖变量优先，缺省 `~/.claude/projects`。
fn projects_root() -> Result<PathBuf, String> {
    for name in PROJECTS_ROOT_ENVS {
        if let Some(value) = std::env::var_os(name) {
            if !value.is_empty() {
                return Ok(PathBuf::from(value).join("projects"));
            }
        }
    }
    Ok(paths::home_dir()?.join(".claude").join("projects"))
}

/// 单个路径分量（目录名 / 会话 id）：不允许分隔符与 `..`，避免拼出逃逸路径。
fn is_plain_component(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\\')
}

fn validate_project_key(key: &str) -> Result<String, String> {
    let key = key.trim();
    if key.is_empty() {
        return Err("项目标识为空，没有可回放的历史".to_string());
    }
    if !is_plain_component(key) {
        return Err(redact::redact_text(&format!("项目标识不合法：{key}")));
    }
    Ok(key.to_string())
}

fn modified_seconds(path: &Path) -> Option<i64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    modified
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|span| span.as_secs() as i64)
}

/// 一个项目目录下的会话文件，按 mtime 倒序（只取直接子文件：子代理在 `<id>/subagents/`）。
fn session_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<(PathBuf, i64)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|extension| extension != "jsonl") {
            continue;
        }
        if !path.is_file() {
            continue;
        }
        files.push((path.clone(), modified_seconds(&path).unwrap_or(0)));
    }
    files.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.0.cmp(&a.0)));
    files.into_iter().map(|(path, _)| path).collect()
}

/// 一个会话文件的摘要：尾部 N 条消息 + 全文首条 user 消息做标题 + 时间范围。
#[derive(Debug, Clone)]
struct Transcript {
    messages: Vec<ChatMessage>,
    title: Option<String>,
    model: Option<String>,
    created_at: i64,
    updated_at: i64,
}

struct CachedTranscript {
    size: u64,
    modified: Option<SystemTime>,
    transcript: Transcript,
}

/// 按 `(len, mtime)` 缓存：刷新会话列表时会重复读同一批 jsonl（照 codex_usage.rs 的做法）。
static TRANSCRIPT_CACHE: OnceLock<Mutex<BTreeMap<PathBuf, CachedTranscript>>> = OnceLock::new();

fn cached_transcript(path: &Path, limit: usize) -> Option<Transcript> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta.modified().ok();
    let Ok(mut cache) = TRANSCRIPT_CACHE
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
    else {
        return read_transcript(path, limit);
    };
    if let Some(hit) = cache
        .get(path)
        .filter(|entry| entry.size == meta.len() && entry.modified == modified)
    {
        return Some(hit.transcript.clone());
    }
    let transcript = read_transcript(path, limit)?;
    cache.insert(
        path.to_path_buf(),
        CachedTranscript {
            size: meta.len(),
            modified,
            transcript: transcript.clone(),
        },
    );
    Some(transcript)
}

/// 读一个 jsonl 会话：只处理 `type` 为 user/assistant 的行，其余全部跳过。
///
/// 这里必须 fail-soft：文件是别的进程边写边追加的，未知 `type`、未知 block、畸形
/// JSON、空行混在一起是常态，任何一条都不许让整次读取炸掉——坏行跳过，能读的照读。
fn read_transcript(path: &Path, limit: usize) -> Option<Transcript> {
    let file = std::fs::File::open(path).ok()?;
    let mut messages: Vec<ChatMessage> = Vec::new();
    let mut title: Option<String> = None;
    let mut model: Option<String> = None;
    let mut first_ts: Option<i64> = None;
    let mut last_ts: Option<i64> = None;
    for line in BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        // 廉价预筛：user/assistant 行必有 message 字段，其余行先跳过再谈解析
        if !line.contains("\"message\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let role = match value.get("type").and_then(Value::as_str) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        // 子代理分支不进主对话
        if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let content = flatten_content(value.pointer("/message/content"));
        if content.trim().is_empty() {
            continue;
        }
        let safe = redact::redact_text(&content);
        if title.is_none() && role == "user" {
            title = Some(truncate_title(&safe)).filter(|title| !title.is_empty());
        }
        if role == "assistant" && model.is_none() {
            model = value
                .pointer("/message/model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .map(redact::redact_text);
        }
        let ts = value
            .get("timestamp")
            .and_then(Value::as_str)
            .and_then(parse_iso8601_seconds);
        if let Some(ts) = ts {
            first_ts.get_or_insert(ts);
            last_ts = Some(ts);
        }
        messages.push(ChatMessage {
            role: role.to_string(),
            content: safe,
            ts: ts.unwrap_or(0),
        });
        if messages.len() > limit {
            messages.remove(0);
        }
    }
    let fallback = modified_seconds(path).unwrap_or(0);
    Some(Transcript {
        messages,
        title,
        model,
        created_at: first_ts.unwrap_or(fallback),
        updated_at: last_ts.or(first_ts).unwrap_or(fallback),
    })
}

/// 把 `message.content`（字符串或 block 数组）拍平成一段文本。
///
/// block 是 `text` 就取文本，`thinking` / `tool_use` / `tool_result` 拍成占位短语：
/// `ChatMessage` 的形状不许变，所以不引入 block 数组。未知 block 类型忽略。
fn flatten_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => {
            let mut parts: Vec<String> = Vec::new();
            for block in blocks {
                let Some(fields) = block.as_object() else {
                    continue;
                };
                match fields.get("type").and_then(Value::as_str).unwrap_or("") {
                    "text" => {
                        if let Some(text) = fields.get("text").and_then(Value::as_str) {
                            if !text.trim().is_empty() {
                                parts.push(text.to_string());
                            }
                        }
                    }
                    "thinking" => parts.push("〔思考〕".to_string()),
                    "tool_use" => {
                        let name = fields
                            .get("name")
                            .and_then(Value::as_str)
                            .unwrap_or("未命名工具");
                        parts.push(format!("〔调用工具 {name}〕"));
                    }
                    "tool_result" => parts.push("〔工具结果〕".to_string()),
                    _ => {}
                }
            }
            parts.join("\n")
        }
        _ => String::new(),
    }
}

/// 标题：换行折成空格，取前 N 个字符，过长加省略号。空串由调用方回落。
fn truncate_title(text: &str) -> String {
    let flattened = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = flattened.chars().take(TITLE_MAX_CHARS).collect();
    if flattened.chars().count() > TITLE_MAX_CHARS {
        format!("{title}…")
    } else {
        title
    }
}

/// 项目显示路径：取 jsonl 里的 `cwd`，**不反解目录名**（`-` 与路径里的连字符有歧义）。
fn project_cwd(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    for line in BufReader::new(file).lines().take(CWD_SCAN_LINES) {
        let Ok(line) = line else { break };
        if !line.contains("\"cwd\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if let Some(cwd) = value
            .get("cwd")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|cwd| !cwd.is_empty())
        {
            return Some(cwd.to_string());
        }
    }
    None
}

/// ISO8601（`2026-09-15T08:20:57.841Z` / `+08:00`）→ unix 秒。
///
/// 手写而不引 chrono：Windows 侧没有 chrono 依赖，两侧必须共用同一份实现。
pub fn parse_iso8601_seconds(raw: &str) -> Option<i64> {
    let bytes = raw.as_bytes();
    if bytes.len() < 19 {
        return None;
    }
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || !matches!(bytes[10], b'T' | b't' | b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let number = |from: usize, to: usize| -> Option<i64> {
        let slice = raw.get(from..to)?;
        if !slice.bytes().all(|byte| byte.is_ascii_digit()) {
            return None;
        }
        slice.parse::<i64>().ok()
    };
    let year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    let hour = number(11, 13)?;
    let minute = number(14, 16)?;
    let second = number(17, 19)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 || second > 60
    {
        return None;
    }
    let mut rest = raw.get(19..)?;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits = fraction
            .bytes()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        rest = fraction.get(digits..)?;
    }
    let offset = match rest.as_bytes().first() {
        None | Some(b'Z') | Some(b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let zone = rest.get(1..)?;
            let (hours, minutes) = match zone.find(':') {
                Some(index) => (zone.get(..index)?, zone.get(index + 1..)?),
                None if zone.len() == 4 => (zone.get(..2)?, zone.get(2..)?),
                None => return None,
            };
            let magnitude = hours.parse::<i64>().ok()? * 3600 + minutes.parse::<i64>().ok()? * 60;
            if *sign == b'+' {
                magnitude
            } else {
                -magnitude
            }
        }
        _ => return None,
    };
    Some(days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second - offset)
}

/// Howard Hinnant 的 `days_from_civil`：公历日期 → 1970-01-01 起的天数。
///
/// 闰年与月末都由这个算法自己吃下（2024-02-29 存在，2026-02-29 会滚到 03-01）。
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_shift = (month + 9) % 12;
    let day_of_year = (153 * month_shift + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// 当前选中项目下的历史会话（离线/目录没了就是空列表，绝不退回假数据）。
fn history_sessions(key: &str) -> Result<Vec<ChatSession>, String> {
    let dir = projects_root()?.join(key);
    let files: Vec<PathBuf> = session_files(&dir)
        .into_iter()
        .take(HISTORY_SESSION_LIMIT)
        .collect();
    if let Ok(mut cache) = TRANSCRIPT_CACHE
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
    {
        cache.retain(|path, _| files.contains(path));
    }
    let mut sessions: Vec<ChatSession> = Vec::new();
    for path in files {
        let Some(id) = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|id| is_plain_component(id))
            .map(str::to_string)
        else {
            continue;
        };
        let Some(transcript) = cached_transcript(&path, HISTORY_MESSAGE_LIMIT) else {
            continue;
        };
        sessions.push(ChatSession {
            title: transcript
                .title
                .clone()
                .unwrap_or_else(|| id.clone()),
            id,
            channel_id: None,
            model: transcript.model.clone().unwrap_or_default(),
            messages: transcript.messages,
            created_at: transcript.created_at,
            updated_at: transcript.updated_at,
            source: "history".to_string(),
            hub_name: None,
            project_key: Some(key.to_string()),
        });
    }
    Ok(sessions)
}

/// 这个 id 是不是当前选中项目里的历史会话（决定「只读」还是「找不到」）。
fn history_session_exists(session_id: &str) -> bool {
    if !is_plain_component(session_id) {
        return false;
    }
    let Ok(store) = load_store() else {
        return false;
    };
    let Some(key) = selected_project(&store) else {
        return false;
    };
    let Ok(root) = projects_root() else {
        return false;
    };
    root.join(key).join(format!("{session_id}.jsonl")).is_file()
}

fn missing_session_error(session_id: &str) -> String {
    // id 是界面传来的原样字符串，进错误文案前同样过一遍剥离
    if history_session_exists(session_id) {
        redact::redact_text(&format!(
            "会话 {session_id} 是历史会话，只读：不能发送消息，只能回放"
        ))
    } else {
        redact::redact_text(&format!("找不到会话 {session_id}，请刷新会话列表"))
    }
}

// ---------------------------------------------------------------------------
// 公开命令
// ---------------------------------------------------------------------------

/// 当前选中项目的历史 + 本地会话，按更新时间倒序。
pub fn list_chat_sessions() -> Result<Vec<ChatSession>, String> {
    let store = load_store()?;
    let mut sessions: Vec<ChatSession> = Vec::new();
    for entry in session_entries(&store) {
        sessions.push(build_local_session(entry)?);
    }
    if let Some(key) = selected_project(&store) {
        sessions.extend(history_sessions(&key)?);
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions)
}

/// `~/.claude/projects` 下已有项目（只列真有 jsonl 的目录）。
pub fn chat_projects() -> Result<Vec<ChatProject>, String> {
    let root = projects_root()?;
    let Ok(entries) = std::fs::read_dir(&root) else {
        // 历史根目录不存在 = 这台机器没有历史，返回空列表而不是编一个
        return Ok(Vec::new());
    };
    let mut projects: Vec<ChatProject> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(key) = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|key| is_plain_component(key))
            .map(str::to_string)
        else {
            continue;
        };
        let files = session_files(&path);
        if files.is_empty() {
            continue;
        }
        projects.push(ChatProject {
            key,
            path: files
                .iter()
                .find_map(|file| project_cwd(file))
                .unwrap_or_else(|| path.to_string_lossy().into_owned()),
            session_count: files.len(),
            updated_at: files.iter().filter_map(|file| modified_seconds(file)).max().unwrap_or(0),
        });
    }
    projects.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(projects)
}

/// 选中要回放的历史项目。目录不存在就报错，不静默记一个空选择。
pub fn select_chat_project(key: &str) -> Result<(), String> {
    let key = validate_project_key(key)?;
    let dir = projects_root()?.join(&key);
    if !dir.is_dir() {
        return Err(format!(
            "找不到项目 {key}：{} 不是目录",
            error::tilde(&dir)
        ));
    }
    let _lock = chat_lock()?;
    let mut store = load_store()?;
    if store.get("version").is_none() {
        store.insert("version".into(), Value::from(STORE_VERSION));
    }
    store.insert("selectedProject".into(), Value::String(key));
    write_store(&store)
}

/// 新建一个本地会话：绑定 hub（None 是默认 hub）与渠道，模型取该渠道的覆盖/声明模型。
pub fn create_chat_session(
    hub_name: Option<String>,
    channel_id: String,
) -> Result<ChatSession, String> {
    let channel_id = channel_id.trim().to_string();
    if channel_id.is_empty() {
        return Err("必须选择一个渠道才能新建会话".to_string());
    }
    // 渠道与模型都是真值：读不到渠道或读不到模型就报错，绝不编一个默认模型名
    let channels = channels::list_channels()?;
    let channel = channels
        .iter()
        .find(|channel| channel.id == channel_id)
        .ok_or_else(|| {
            redact::redact_text(&format!(
                "找不到渠道 {channel_id}：本机渠道列表里没有这个 id"
            ))
        })?;
    let model = channel_model(
        channel.model_override.as_deref(),
        channel.declared_model.as_deref(),
        &channel.name,
    )?;
    let hub_name = hub_name
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty());
    if let Some(name) = hub_name.as_deref() {
        hubs::resolve_hub(name)?;
    }

    let now = now_ts();
    let id = new_id("chat");
    let system = format!(
        "本会话通过 hub「{}」发送到渠道「{}」，模型 {model}。",
        hub_name.as_deref().unwrap_or(hubs::DEFAULT_HUB_ID),
        channel.name
    );
    let mut entry = Map::new();
    entry.insert("id".into(), Value::String(id.clone()));
    entry.insert("title".into(), Value::String(NEW_SESSION_TITLE.to_string()));
    entry.insert("channelId".into(), Value::String(channel_id));
    entry.insert(
        "hubName".into(),
        match hub_name {
            Some(name) => Value::String(name),
            None => Value::Null,
        },
    );
    entry.insert("model".into(), Value::String(model));
    entry.insert(
        "messages".into(),
        Value::Array(vec![message_value(
            "system",
            &redact::redact_text(&system),
            now,
        )]),
    );
    entry.insert("createdAt".into(), Value::from(now));
    entry.insert("updatedAt".into(), Value::from(now));

    let _lock = chat_lock()?;
    let mut store = load_store()?;
    if store.get("version").is_none() {
        store.insert("version".into(), Value::from(STORE_VERSION));
    }
    sessions_array(&mut store).push(Value::Object(entry.clone()));
    write_store(&store)?;
    build_local_session(&entry)
}

/// 删除一个本地会话。历史会话只读，不能删。
pub fn delete_chat_session(id: &str) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("会话 id 为空，没有可删除的会话".to_string());
    }
    let _lock = chat_lock()?;
    let mut store = load_store()?;
    let removed = {
        let sessions = sessions_array(&mut store);
        let before = sessions.len();
        sessions.retain(|entry| entry.get("id").and_then(Value::as_str) != Some(id));
        before - sessions.len()
    };
    if removed == 0 {
        return Err(redact::redact_text(&format!(
            "找不到本地会话 {id}：历史会话只读，不能删除"
        )));
    }
    write_store(&store)
}

/// 会话的模型：渠道的本地覆盖优先，其次声明模型；都没有就报错，不编默认值。
fn channel_model(
    override_model: Option<&str>,
    declared: Option<&str>,
    channel_name: &str,
) -> Result<String, String> {
    override_model
        .or(declared)
        .map(str::trim)
        .filter(|model| !model.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            redact::redact_text(&format!(
                "渠道「{channel_name}」既没有本地模型覆盖也没有声明模型；请先在渠道页设好模型再新建会话"
            ))
        })
}

/// 发送时的两份素材：顶层 `system` 与会话消息窗口。
fn request_parts(messages: &[ChatMessage]) -> (Option<String>, Vec<chat_hub::Turn>) {
    let start = messages.len().saturating_sub(REQUEST_MESSAGE_WINDOW);
    let mut system: Vec<String> = Vec::new();
    let mut turns: Vec<chat_hub::Turn> = Vec::new();
    for message in &messages[start..] {
        if message.role == "system" {
            system.push(message.content.clone());
            continue;
        }
        turns.push((message.role.clone(), message.content.clone()));
    }
    (
        if system.is_empty() {
            None
        } else {
            Some(system.join("\n\n"))
        },
        turns,
    )
}

/// 终态落盘。只有拿到真终态才返回 Ok。
///
/// - `Complete`：落盘 assistant 消息，返回 Ok
/// - `Truncated`：落盘已收到的部分文本 + 一条 system 说明，返回 Err——流干净结束但
///   没有终态帧就是没结束，不补 `message_stop`，也不谎报成功
fn finish_stream(
    session_id: &str,
    outcome: &Outcome,
    text: &str,
    ts: i64,
) -> Result<ChatMessage, String> {
    match outcome {
        Outcome::Complete => append_local_message(session_id, "assistant", text, ts),
        Outcome::Truncated => {
            let partial = append_local_message(session_id, "assistant", text, ts)?;
            append_local_message(session_id, "system", TRUNCATED_NOTE, ts)?;
            Err(format!(
                "回复被截断：上游未发送终止帧（已保存收到的 {} 个字符）",
                partial.content.chars().count()
            ))
        }
    }
}

/// 失败事件的载荷。
///
/// 与 `ChatStreamDelta` / `ChatStreamEnd` 同形：带上 `sessionId` / `requestId`，前端才能把
/// 这条错误归因到具体某次发送。缺了它前端只能用「缓冲还在 = 这次还在途」猜，旧流的迟到
/// 错误就会误收新流的缓冲。`message` 已脱敏。
fn error_event(session_id: &str, request_id: &str, message: &str) -> ChatStreamError {
    ChatStreamError {
        session_id: session_id.to_string(),
        request_id: request_id.to_string(),
        // 形状自由，凭证不许漏：这是唯一一处把错误原文送进 IPC 的通道
        message: redact::redact_text(message),
    }
}

/// 失败事件。只在 `send_chat_message` 里调用——那里的 `session_id` / `request_id` 一定可得；
/// 发送流程之外的失败没有可归因的请求，直接返回 `Err`，不发这条事件。
fn emit_error(app: &tauri::AppHandle, session_id: &str, request_id: &str, message: &str) {
    let _ = app.emit(
        STREAM_ERROR_EVENT,
        error_event(session_id, request_id, message),
    );
}

/// 扣住尾部未终结的 token 形状串，再异步投递增量。
///
/// 一个长凭证串可能被切成多段到达：逐段各自过 `redact_text` 时每段都短于 24 字符阈值，
/// 前缀就会原样漏出去。所以尾部还没结束的 `[A-Za-z0-9_-]+` 先扣住，等它结束（或流结束）
/// 再决定是打码还是原样发出。
#[derive(Default)]
struct DeltaEmitter {
    raw: String,
    emitted: usize,
}

impl DeltaEmitter {
    /// 投递一段增量：只有确定不再延续的字符才放行。
    fn push(&mut self, delta: &str, out: &mut impl FnMut(&str)) {
        self.raw.push_str(delta);
        let frozen = frozen_prefix_len(&self.raw);
        self.emit_until(frozen, out);
    }

    /// 流结束时把剩下的部分投递完。
    fn flush(&mut self, out: &mut impl FnMut(&str)) {
        let end = self.raw.len();
        self.emit_until(end, out);
    }

    fn emit_until(&mut self, end: usize, out: &mut impl FnMut(&str)) {
        if end <= self.emitted {
            return;
        }
        let piece = redact::redact_text(&self.raw[self.emitted..end]);
        self.emitted = end;
        if !piece.is_empty() {
            out(&piece);
        }
    }
}

/// 尾部未终结的 token 形状串的起点：这段还不算「冻结」。
fn frozen_prefix_len(raw: &str) -> usize {
    let mut start = raw.len();
    for (index, ch) in raw.char_indices().rev() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            start = index;
        } else {
            break;
        }
    }
    start
}

/// 发一条消息：真连 hub，真流式，终态只认上游给的。
///
/// JS 侧签名不变（`sessionId, content` → `ChatMessage`）；增量与终态走事件通道。
pub async fn send_chat_message(
    app: &tauri::AppHandle,
    session_id: &str,
    content: &str,
) -> Result<ChatMessage, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("消息内容为空，没有可发送的文本".to_string());
    }
    let now = now_ts();
    let request_id = new_id("req");

    // 1. 历史会话只读：先确认这是本地会话，再落盘用户消息
    let existing = match load_local_session(session_id)? {
        Some(session) => session,
        None => return Err(missing_session_error(session_id)),
    };
    // 模型是请求的必填字段：手改过的会话可能没有模型，空模型发出去只换来上游 400
    let model = existing.model.trim().to_string();
    if model.is_empty() {
        return Err(redact::redact_text(&format!(
            "会话 {session_id} 没有模型，没法发送；请删掉它重新建一个会话"
        )));
    }
    let appended = append_local_message(session_id, "user", content, now)?;
    // 请求带的是刚落盘的那条用户消息（用返回值拼，不再重读文件）
    let mut messages = existing.messages;
    messages.push(appended);

    // 2. 目标 hub（缺凭证/端口在这里就停下，进不了发送流程）
    let target = match chat_hub::resolve_target(existing.hub_name.as_deref()) {
        Ok(target) => target,
        Err(error) => {
            emit_error(app, session_id, &request_id, &error);
            return Err(error);
        }
    };

    // 3. 组装请求：system 提到顶层，数组里不留 system 项
    let (system, turns) = request_parts(&messages);
    let body = chat_hub::build_request_body(&model, system.as_deref(), &turns);

    let mut emitter = DeltaEmitter::default();
    let mut emit = |delta: &str| {
        let _ = app.emit(
            STREAM_EVENT,
            ChatStreamDelta {
                session_id: session_id.to_string(),
                request_id: request_id.clone(),
                delta: delta.to_string(),
            },
        );
    };
    let streamed = chat_hub::stream_message(&target, &body, |delta| emitter.push(delta, &mut emit)).await;
    emitter.flush(&mut emit);

    let result = match streamed {
        Ok(result) => result,
        Err(error) => {
            let error = redact::redact_text(&error);
            emit_error(app, session_id, &request_id, &error);
            return Err(error);
        }
    };

    // 4. 终态：只有真终态才算 stop
    let safe_text = redact::redact_text(&result.text);
    let outcome = result.outcome;
    let finished = finish_stream(session_id, &outcome, &safe_text, now);
    let _ = app.emit(
        STREAM_END_EVENT,
        ChatStreamEnd {
            session_id: session_id.to_string(),
            request_id,
            reason: match outcome {
                Outcome::Complete => "stop".to_string(),
                Outcome::Truncated => "truncated".to_string(),
            },
            stop_reason: result.stop_reason,
        },
    );
    finished
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// 环境变量是进程级的，这些测试必须串行（照 tasks.rs 的 TasksEnv）。
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct ChatEnv {
        dir: PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
    }

    impl ChatEnv {
        fn new(tag: &str) -> Self {
            // 一个测试断言失败不该让同进程的其他测试跟着报 PoisonError
            let guard = ENV_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let dir = std::env::temp_dir().join(format!("claude1-desktop-chat-{tag}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join("projects")).unwrap();
            std::env::set_var("AGENT_HUB_CHAT_PATH", dir.join("agent-hub-chat.json"));
            // 两个历史根变量都按到临时目录：父进程若设过 CLAUDE_CONFIG_DIR 也不会读到真家目录
            std::env::set_var("CLAUDE_CONFIG_DIR", &dir);
            std::env::set_var("CLAUDE1_CLAUDE_HOME", &dir);
            ChatEnv {
                dir,
                _guard: guard,
            }
        }

        fn project_dir(&self, key: &str) -> PathBuf {
            let path = self.dir.join("projects").join(key);
            std::fs::create_dir_all(&path).unwrap();
            path
        }

        /// 写一个合成历史会话文件，返回它的路径。
        fn write_transcript(&self, key: &str, id: &str, lines: &[Value]) -> PathBuf {
            let path = self.project_dir(key).join(format!("{id}.jsonl"));
            let body: String = lines
                .iter()
                .map(|line| format!("{line}\n"))
                .collect::<Vec<String>>()
                .concat();
            std::fs::write(&path, body).unwrap();
            path
        }
    }

    impl Drop for ChatEnv {
        fn drop(&mut self) {
            std::env::remove_var("AGENT_HUB_CHAT_PATH");
            std::env::remove_var("CLAUDE_CONFIG_DIR");
            std::env::remove_var("CLAUDE1_CLAUDE_HOME");
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn user_line(text: &str, ts: &str) -> Value {
        json!({
            "type": "user",
            "isSidechain": false,
            "timestamp": ts,
            "cwd": "/Users/synthetic/project",
            "message": { "role": "user", "content": text },
        })
    }

    fn assistant_line(blocks: Value, ts: &str) -> Value {
        json!({
            "type": "assistant",
            "isSidechain": false,
            "timestamp": ts,
            "message": { "role": "assistant", "model": "claude-synthetic-5", "content": blocks },
        })
    }

    /// 直接塞一条本地会话，跳过需要真渠道库的 create_chat_session。
    fn seed_local_session(id: &str, title: &str) -> PathBuf {
        let path = paths::chat_path().unwrap();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let store = json!({
            "version": STORE_VERSION,
            "selectedProject": null,
            "未来新键": { "keep": true },
            "sessions": [{
                "id": id,
                "title": title,
                "channelId": "ch-1",
                "hubName": "claude-hub",
                "model": "glm-5.2",
                "messages": [ { "role": "system", "content": "设定", "ts": 10 } ],
                "createdAt": 10,
                "updatedAt": 10,
                "会话侧未知键": 7,
            }],
        });
        paths::write_json_atomic(&path, &store).unwrap();
        path
    }

    #[test]
    fn iso8601_seconds_handles_leap_days_month_ends_and_offsets() {
        assert_eq!(parse_iso8601_seconds("2024-02-29T00:00:00Z"), Some(1_709_164_800));
        assert_eq!(
            parse_iso8601_seconds("2026-02-28T23:59:59Z"),
            Some(1_772_323_199)
        );
        assert_eq!(
            parse_iso8601_seconds("2026-03-01T00:00:00.500Z"),
            Some(1_772_323_200)
        );
        assert_eq!(parse_iso8601_seconds("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_iso8601_seconds("2026-12-31T23:59:59Z"),
            Some(1_798_761_599)
        );
        assert_eq!(parse_iso8601_seconds("2027-01-01T00:00:00Z"), Some(1_798_761_600));
        // 带时区后缀：+08:00 比 UTC 早 8 小时
        assert_eq!(
            parse_iso8601_seconds("2026-09-16T12:34:56+08:00"),
            Some(1_789_533_296)
        );
        assert_eq!(
            parse_iso8601_seconds("2026-09-16T12:34:56-05:30"),
            Some(1_789_581_896)
        );
        // 畸形输入不 panic、不猜
        for bad in [
            "",
            "2026-09-16",
            "2026-13-01T00:00:00Z",
            "2026-09-16T25:00:00Z",
            "not a timestamp",
            "2026-09-16T12:34:56+oops",
        ] {
            assert_eq!(parse_iso8601_seconds(bad), None, "{bad}");
        }
    }

    #[test]
    fn transcript_skips_unknown_lines_blocks_and_broken_json() {
        let env = ChatEnv::new("fail-soft");
        let lines = vec![
            json!({ "type": "summary", "summary": "压缩摘要" }),
            json!({ "type": "attachment", "rendered": "附件渲染" }),
            json!({ "type": "queue-operation", "op": "enqueue" }),
            user_line("第一条用户消息", "2026-09-15T08:00:00Z"),
            json!({ "type": "user", "message": { "role": "user" } }),
            json!({ "type": "user", "isSidechain": true, "message": { "role": "user", "content": "子代理" } }),
            json!({ "type": "assistant", "message": { "role": "assistant", "content": [
                { "type": "thinking", "thinking": "内部推理" },
                { "type": "text", "text": "可见回答" },
                { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": "ls" } },
                { "type": "未知道具", "whatever": 1 },
            ] }, "timestamp": "2026-09-15T08:00:05.000Z" }),
            json!({ "type": "user", "message": { "role": "user", "content": [
                { "type": "tool_result", "tool_use_id": "t1", "content": "工具输出" },
            ] }, "timestamp": "2026-09-15T08:00:06Z" }),
        ];
        let path = env.write_transcript("proj-soft", "sess-soft", &lines);
        // 真的畸形行：整行不是 JSON（半截写入就是这样）
        let mut body = std::fs::read_to_string(&path).unwrap();
        body.push_str("{ \"type\": \"assistant\", \"message\": {\"content\": \"未闭合\n");
        std::fs::write(&path, body).unwrap();

        let transcript = read_transcript(&path, HISTORY_MESSAGE_LIMIT).unwrap();
        assert_eq!(transcript.messages.len(), 3, "{:?}", transcript.messages);
        assert_eq!(transcript.messages[0].role, "user");
        assert_eq!(transcript.messages[0].content, "第一条用户消息");
        assert_eq!(transcript.messages[1].content, "〔思考〕\n可见回答\n〔调用工具 Bash〕");
        assert!(transcript
            .messages
            .iter()
            .all(|message| !message.content.contains("子代理")));
        assert_eq!(transcript.title.as_deref(), Some("第一条用户消息"));
        assert_eq!(transcript.messages[2].content, "〔工具结果〕");
        assert_eq!(transcript.created_at, 1_789_459_200);
        assert_eq!(transcript.updated_at, 1_789_459_206);
    }

    #[test]
    fn a_missing_or_empty_transcript_never_panics() {
        let env = ChatEnv::new("empty");
        let lines = vec![Value::Null, json!({}), json!({ "type": "user" })];
        let path = env.write_transcript("proj-empty", "sess-empty", &lines);
        let transcript = read_transcript(&path, HISTORY_MESSAGE_LIMIT).unwrap();
        assert!(transcript.messages.is_empty());
        assert!(transcript.title.is_none());
        assert!(read_transcript(&env.dir.join("nope.jsonl"), HISTORY_MESSAGE_LIMIT).is_none());
    }

    #[test]
    fn history_title_falls_back_to_the_file_name_without_a_user_message() {
        let env = ChatEnv::new("title-fallback");
        let lines = vec![assistant_line(
            json!([{ "type": "text", "text": "只有助手说话" }]),
            "2026-09-15T08:00:00Z",
        )];
        env.write_transcript("proj-title", "sess-title-fallback", &lines);
        let sessions = history_sessions("proj-title").unwrap();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].title, "sess-title-fallback");
        assert_eq!(sessions[0].source, "history");
        assert_eq!(sessions[0].project_key.as_deref(), Some("proj-title"));
        assert_eq!(sessions[0].model, "claude-synthetic-5");
    }

    #[test]
    fn only_the_tail_is_kept_but_the_title_still_comes_from_the_first_message() {
        let env = ChatEnv::new("window");
        let mut lines = vec![user_line("首条用户消息", "2026-09-15T08:00:00Z")];
        for index in 0..204 {
            let role = if index % 2 == 0 { "assistant" } else { "user" };
            lines.push(json!({
                "type": role,
                "timestamp": "2026-09-15T08:00:01Z",
                "message": { "role": role, "content": format!("第 {index} 条") },
            }));
        }
        let path = env.write_transcript("proj-window", "sess-window", &lines);
        let transcript = read_transcript(&path, HISTORY_MESSAGE_LIMIT).unwrap();
        assert_eq!(transcript.messages.len(), HISTORY_MESSAGE_LIMIT);
        // 保留尾部：第一条被挤掉的正是「首条用户消息」
        assert!(transcript
            .messages
            .iter()
            .all(|message| message.content != "首条用户消息"));
        assert_eq!(transcript.title.as_deref(), Some("首条用户消息"));
    }

    #[test]
    fn history_list_caps_at_fifty_sessions_by_mtime_desc() {
        let env = ChatEnv::new("cap");
        for index in 0..55 {
            let path = env.write_transcript(
                "proj-cap",
                &format!("sess-{index:03}"),
                &[user_line("历史", "2026-09-15T08:00:00Z")],
            );
            let handle = std::fs::OpenOptions::new().write(true).open(&path).unwrap();
            let times = std::fs::FileTimes::new()
                .set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000 + index));
            handle.set_times(times).unwrap();
        }
        let sessions = history_sessions("proj-cap").unwrap();
        assert_eq!(sessions.len(), HISTORY_SESSION_LIMIT);
        assert_eq!(sessions[0].id, "sess-054");
        assert_eq!(sessions[HISTORY_SESSION_LIMIT - 1].id, "sess-005");
        assert!(sessions
            .iter()
            .all(|session| session.id.as_str() > "sess-004"));
    }

    #[test]
    fn chat_projects_lists_directories_with_history_and_reads_cwd() {
        let env = ChatEnv::new("projects");
        env.write_transcript(
            "proj-a",
            "sess-a",
            &[user_line("你好", "2026-09-15T08:00:00Z")],
        );
        env.project_dir("proj-empty-dir");
        let projects = chat_projects().unwrap();
        assert_eq!(projects.len(), 1);
        assert_eq!(projects[0].key, "proj-a");
        assert_eq!(projects[0].path, "/Users/synthetic/project");
        assert_eq!(projects[0].session_count, 1);
        assert!(projects[0].updated_at > 0);
    }

    #[test]
    fn a_missing_projects_root_lists_nothing_instead_of_fake_history() {
        let env = ChatEnv::new("offline");
        std::fs::remove_dir_all(env.dir.join("projects")).unwrap();
        assert!(chat_projects().unwrap().is_empty());
        assert!(history_sessions("proj-a").unwrap().is_empty());
        assert!(select_chat_project("proj-a")
            .unwrap_err()
            .contains("不是目录"));
    }

    #[test]
    fn local_session_roundtrip_keeps_unknown_keys_and_private_permissions() {
        let _env = ChatEnv::new("roundtrip");
        let path = seed_local_session("chat-1", "本地会话");

        let listed = list_chat_sessions().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].source, "local");
        assert_eq!(listed[0].channel_id.as_deref(), Some("ch-1"));
        assert_eq!(listed[0].hub_name.as_deref(), Some("claude-hub"));

        let appended = append_local_message("chat-1", "user", "第一条消息", 20).unwrap();
        assert_eq!(appended.role, "user");
        assert_eq!(appended.content, "第一条消息");

        let raw: Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["未来新键"]["keep"], json!(true));
        assert_eq!(raw["sessions"][0]["会话侧未知键"], json!(7));
        assert_eq!(raw["sessions"][0]["updatedAt"], json!(20));
        assert_eq!(raw["sessions"][0]["messages"].as_array().unwrap().len(), 2);
        #[cfg(unix)]
        assert_eq!(paths::mode_bits(&path), Some(0o600));

        delete_chat_session("chat-1").unwrap();
        assert!(list_chat_sessions().unwrap().is_empty());
        assert!(delete_chat_session("chat-1")
            .unwrap_err()
            .contains("只读"));
    }

    #[test]
    fn the_placeholder_title_is_replaced_by_the_first_user_message() {
        let _env = ChatEnv::new("retitle");
        seed_local_session("chat-title", NEW_SESSION_TITLE);
        append_local_message("chat-title", "user", "帮我看一下这个缓存问题", 30).unwrap();
        let session = load_local_session("chat-title").unwrap().unwrap();
        assert_eq!(session.title, "帮我看一下这个缓存问题");
        // 后续消息不再改标题
        append_local_message("chat-title", "user", "换个话题", 31).unwrap();
        let session = load_local_session("chat-title").unwrap().unwrap();
        assert_eq!(session.title, "帮我看一下这个缓存问题");
    }

    #[test]
    fn stored_content_is_redacted_before_it_reaches_ipc() {
        let _env = ChatEnv::new("redact");
        seed_local_session("chat-redact", "会话");
        let fake = format!("sk-chat-{}", "y".repeat(30));
        append_local_message("chat-redact", "user", &fake, 40).unwrap();
        let session = load_local_session("chat-redact").unwrap().unwrap();
        let last = session.messages.last().unwrap();
        assert!(!last.content.contains(&"y".repeat(30)));
        assert!(last.content.contains(redact::MASK));
        // 原始文件里也不留明文
        let raw = std::fs::read_to_string(paths::chat_path().unwrap()).unwrap();
        assert!(!raw.contains(&"y".repeat(30)));
    }

    #[test]
    fn the_failure_event_carries_the_request_and_masks_credentials() {
        let fake = format!("sk-error-{}", "q".repeat(30));
        let payload = error_event("chat-1", "req-7", &format!("上游 500：{fake} 被拒"));
        let value = serde_json::to_value(&payload).unwrap();
        // 形状：camelCase，三个字段齐全且没有多余键——前端按这个形状解构
        let mut keys: Vec<&str> = value
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        assert_eq!(keys, ["message", "requestId", "sessionId"]);
        assert_eq!(value["sessionId"], json!("chat-1"));
        assert_eq!(value["requestId"], json!("req-7"));
        // 加了字段也不许漏掉打码
        let message = value["message"].as_str().unwrap();
        assert!(!message.contains(&"q".repeat(30)), "{message}");
        assert!(!message.contains(&fake), "{message}");
        assert!(message.contains(redact::MASK), "{message}");
        // 与凭证无关的原文照常保留，不整段吞掉
        assert!(message.contains("上游 500"), "{message}");
    }

    #[test]
    fn sending_into_a_history_session_is_refused_as_read_only() {
        let env = ChatEnv::new("readonly");
        env.write_transcript("proj-ro", "sess-ro", &[user_line("历史", "2026-09-15T08:00:00Z")]);
        // 先铺本地会话再选项目：选中是写回同一份存储，顺序反过来会把本地会话覆盖掉
        seed_local_session("chat-ro", "本地会话");
        select_chat_project("proj-ro").unwrap();
        let listed = list_chat_sessions().unwrap();
        assert_eq!(listed.len(), 2);
        assert!(list_chat_sessions()
            .unwrap()
            .iter()
            .any(|session| session.id == "sess-ro" && session.source == "history"));
        let missing = missing_session_error("sess-ro");
        assert!(missing.contains("只读"), "{missing}");
        let unknown = missing_session_error("no-such-session");
        assert!(unknown.contains("找不到会话"), "{unknown}");
    }

    #[test]
    fn select_chat_project_rejects_traversal_and_keeps_the_choice() {
        let env = ChatEnv::new("select");
        env.write_transcript("proj-sel", "sess-sel", &[user_line("你好", "2026-09-15T08:00:00Z")]);
        for bad in ["../proj-sel", "a/b", "..", ""] {
            assert!(select_chat_project(bad).is_err(), "{bad}");
        }
        select_chat_project("proj-sel").unwrap();
        let store = load_store().unwrap();
        assert_eq!(store["selectedProject"], json!("proj-sel"));
        assert_eq!(list_chat_sessions().unwrap().len(), 1);
    }

    #[test]
    fn finish_stream_only_persists_a_reply_when_the_upstream_terminated() {
        let _env = ChatEnv::new("terminate");
        seed_local_session("chat-stop", "会话");
        let message = finish_stream("chat-stop", &Outcome::Complete, "完整回复", 50).unwrap();
        assert_eq!(message.role, "assistant");
        assert_eq!(message.content, "完整回复");
        let session = load_local_session("chat-stop").unwrap().unwrap();
        assert_eq!(session.messages.last().unwrap().content, "完整回复");

        // 截断：部分文本 + 说明都落盘，但调用方拿到的是 Err
        let error = finish_stream("chat-stop", &Outcome::Truncated, "半句", 51).unwrap_err();
        assert!(error.contains("截断"), "{error}");
        let session = load_local_session("chat-stop").unwrap().unwrap();
        assert_eq!(session.messages.len(), 4);
        assert_eq!(session.messages[2].content, "半句");
        assert_eq!(session.messages[3].role, "system");
        assert_eq!(session.messages[3].content, TRUNCATED_NOTE);
    }

    #[test]
    fn request_parts_hoist_system_out_of_the_window() {
        let messages: Vec<ChatMessage> = (0..60)
            .map(|index| ChatMessage {
                role: if index == 0 {
                    "system".to_string()
                } else {
                    "user".to_string()
                },
                content: format!("第 {index} 条"),
                ts: index,
            })
            .collect();
        let (system, turns) = request_parts(&messages);
        assert_eq!(turns.len(), REQUEST_MESSAGE_WINDOW);
        assert!(turns.iter().all(|(role, _)| role != "system"));
        assert_eq!(turns[0].1, "第 10 条");
        assert_eq!(system, None, "system 落在窗口外时不再补一个");

        let mut with_system = messages.clone();
        with_system[59].role = "system".to_string();
        let (system, turns) = request_parts(&with_system);
        assert_eq!(system.as_deref(), Some("第 59 条"));
        assert_eq!(turns.len(), REQUEST_MESSAGE_WINDOW - 1);
    }

    #[test]
    fn channel_model_prefers_the_override_and_refuses_to_invent_one() {
        assert_eq!(channel_model(Some("glm-5.2"), Some("glm-5"), "x").unwrap(), "glm-5.2");
        assert_eq!(channel_model(None, Some("glm-5"), "x").unwrap(), "glm-5");
        assert!(channel_model(Some("  "), None, "合成渠道")
            .unwrap_err()
            .contains("合成渠道"));
    }

    #[test]
    fn deltas_never_leak_a_token_split_across_chunks() {
        let fake = format!("sk-split-{}", "z".repeat(30));
        let (head, tail) = fake.split_at(12);
        let mut emitter = DeltaEmitter::default();
        let mut emitted: Vec<String> = Vec::new();
        emitter.push(head, &mut |text: &str| emitted.push(text.to_string()));
        assert!(emitted.is_empty(), "未终结的串要扣住，不能先投递前缀");
        emitter.push(tail, &mut |text: &str| emitted.push(text.to_string()));
        emitter.flush(&mut |text: &str| emitted.push(text.to_string()));
        let joined = emitted.concat();
        assert!(!joined.contains(&"z".repeat(30)), "{joined}");
        assert!(!joined.contains(head), "{joined}");
        assert!(joined.contains(redact::MASK), "{joined}");

        // 普通文本原样通过，不因为扣字而丢内容
        let mut plain = DeltaEmitter::default();
        let mut text: Vec<String> = Vec::new();
        plain.push("你好，世界", &mut |piece: &str| text.push(piece.to_string()));
        plain.push("！再见", &mut |piece: &str| text.push(piece.to_string()));
        plain.flush(&mut |piece: &str| text.push(piece.to_string()));
        assert_eq!(text.concat(), "你好，世界！再见");
    }
}
