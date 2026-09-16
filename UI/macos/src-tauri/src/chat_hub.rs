//! hub 上游：`POST {hub}/v1/messages` 的目标解析、请求组装与真 SSE 流式消费。
//!
//! 三件事：解析目标 hub（端口 + 凭证）、按 Anthropic 形状组装请求体、逐 chunk 消费
//! SSE 流并区分「收到终态」与「干净结束但没终态（截断）」。
//!
//! 凭证：token 只以局部 `String` 存在，绝不进任何 `Serialize` 结构体、事件 payload
//! 或日志。所有 `Err` 出口都过 `redact::redact_text`；上游/中间层把
//! `Authorization: Bearer <token>` 回显进错误页时，另有一条显式整行打码规则——
//! 24 字符阈值能吃掉完整 token，但 `Bearer` 之后的**前缀片段**可能短于阈值。

use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use crate::error;
use crate::hubs;
use crate::paths;
use crate::redact;
use crate::sse;

/// `max_tokens` 硬编码：本仓库的对话入口不做长度调参。
pub const MAX_TOKENS: i64 = 8192;

/// 端口覆盖变量，同 claude-hub.py / claude1_hub_config.py 的 ENV_PORT。
const PORT_ENV: &str = "CLAUDE_HUB_PORT";

/// `local_token_env` 的缺省值，同 claude-provider-once.py 的 DEFAULT_HUB_TOKEN_ENV。
const DEFAULT_TOKEN_ENV: &str = "CLAUDE_HUB_LOCAL_TOKEN";

/// 连接超时。本机回环连不上就是没起来，2 秒够用。
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// 整条流的 deadline，在 chunk 之间检查。
///
/// 不用 reqwest 的全局 `.timeout()`：那是「整条响应必须在 N 秒内结束」，会把正常的长
/// 回复腰斩，而且客户端只看到一句超时，看不出是被截断。
const STREAM_DEADLINE: Duration = Duration::from_secs(600);

/// 两个 chunk 之间允许的最长静默。reqwest 的 `read_timeout` 正是这个语义（单次读的超时）。
///
/// 没有它，上游收下连接后彻底不吐字节时 `chunk()` 会一直等，上面那条「在 chunk 之间
/// 检查」的 deadline 永远轮不到——界面会永久停在流式态，且没有任何错误可报。
///
/// 取值依据本仓库既有的静默窗实测（docs/sse-truncation-fix-2026-08-26.md 第九节）：
/// 真 Claude Code 对 75 秒纯静默耐受无恙，hub 自身的上游保护窗是 45 秒。所以这里要
/// 明显大于 75 秒，好让 hub 先按它的窗口收尾、发出真实终态帧，而不是被客户端抢先把
/// 一次合法的长思考判成失败。
const STREAM_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// 错误页最多回显这么多字符，再长也不给下游。
const ERROR_BODY_LIMIT: usize = 500;

/// 解析好的目标 hub。
pub struct HubTarget {
    /// hub id（注册表里的名字）
    pub name: String,
    /// 恒为回环：宿主固定 127.0.0.1，端口来自 hub 配置或 `CLAUDE_HUB_PORT`
    pub base_url: String,
    /// 本地令牌。私有：只在请求头里用，不出现在任何返回值或事件里
    token: String,
}

impl HubTarget {
    pub fn endpoint(&self) -> String {
        format!("{}/v1/messages", self.base_url)
    }
}

/// 解析目标 hub：`None` / 空串是默认 hub。
///
/// 路径规则复用 `hubs::resolve_hub`；默认 hub 的配置文件位置再用
/// `paths::default_hub_config_path()` 过一道（它认 `CLAUDE_HUB_CONFIG`，与
/// claude-hub.py、claude-provider-once.py 同源）。
pub fn resolve_target(hub_name: Option<&str>) -> Result<HubTarget, String> {
    let hub = hubs::resolve_hub(hub_name.map(str::trim).unwrap_or(""))?;
    let config_path = if hub.is_default {
        paths::default_hub_config_path()?
    } else {
        hub.config_path.clone()
    };
    let config = paths::read_json_object(&config_path)?.ok_or_else(|| {
        format!(
            "找不到 hub {} 的配置文件：{}。请先用 claude1 启动过这个 hub，或设置 CLAUDE_HUB_CONFIG 指向它",
            hub.id,
            error::tilde(&config_path)
        )
    })?;

    let port = resolve_port(&config, std::env::var_os(PORT_ENV).map(|raw| raw.to_string_lossy().into_owned()).as_deref())
        .map_err(|reason| format!("hub {} {reason}（配置：{}）", hub.id, error::tilde(&config_path)))?;
    let token_env = resolve_token_env(&config);
    let token = resolve_token(
        std::env::var_os(&token_env).map(|raw| raw.to_string_lossy().into_owned()).as_deref(),
        &config,
        &token_env,
        &config_path,
    )?;

    Ok(HubTarget {
        name: hub.id,
        base_url: format!("http://127.0.0.1:{port}"),
        token,
    })
}

/// 端口：非空的环境变量覆盖优先，其次 hub 配置的 `port`。**没有兜底默认值**。
///
/// 缺端口时报中文错误而不是自己编一个：编一个就等于把「hub 没配好」伪装成
/// 「连不上」，用户会去查网络。
fn resolve_port(config: &Map<String, Value>, env_override: Option<&str>) -> Result<u16, String> {
    let from_env = env_override.map(str::trim).filter(|raw| !raw.is_empty());
    if let Some(raw) = from_env {
        return raw
            .parse::<u16>()
            .ok()
            .filter(|port| *port > 0)
            .ok_or_else(|| format!("的端口无效：环境变量 {PORT_ENV}={raw} 不是 1-65535 的整数"));
    }
    match config.get("port") {
        Some(value) => value
            .as_i64()
            .and_then(|port| u16::try_from(port).ok())
            .filter(|port| *port > 0)
            .ok_or_else(|| "的端口无效：配置里的 port 不是 1-65535 的整数".to_string()),
        None => Err(format!(
            "没有可用的端口：配置里没有 port，环境变量 {PORT_ENV} 也没有设置。请先给 hub 配置端口"
        )),
    }
}

/// 令牌所在的环境变量名：配置里的 `local_token_env`，形状不合法就回落缺省名。
///
/// 这个键存的是**变量名**不是值，所以可以按环境变量的形状白名单放行（同 hubs.rs）。
fn resolve_token_env(config: &Map<String, Value>) -> String {
    config
        .get("local_token_env")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|name| is_env_var_name(name))
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_TOKEN_ENV.to_string())
}

fn is_env_var_name(raw: &str) -> bool {
    let mut chars = raw.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// 令牌：非空的环境变量优先，其次配置里的 `local_token`；两者皆无就报错。
///
/// fail-closed：缺令牌时绝不发一个不带 `Authorization` 的请求——那会把「没配好」
/// 变成上游的 401/403，看起来像凭证错了。
fn resolve_token(
    env_value: Option<&str>,
    config: &Map<String, Value>,
    env_name: &str,
    config_path: &Path,
) -> Result<String, String> {
    // 空串按「没设置」处理，与 claude1_hub_config.py 的 `env.get(token_env) or raw[...]` 一致
    let from_env = env_value.map(str::trim).filter(|value| !value.is_empty());
    if let Some(token) = from_env {
        return Ok(token.to_string());
    }
    let from_file = config
        .get("local_token")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    from_file.map(str::to_string).ok_or_else(|| {
        format!(
            "没有可用的本地令牌：环境变量 {env_name} 为空，{} 里也没有 local_token。请把令牌写进该环境变量，或在 hub 配置里写上 local_token",
            error::tilde(config_path)
        )
    })
}

/// 一条待发送的消息：角色 + 文本。
pub type Turn = (String, String);

/// 组装 Anthropic 形状的请求体。
///
/// `system` 提到**顶层字段**：会话里的 system 消息是会话级设定，不是一轮对话。
/// 数组里留一条 `role:"system"` 会被上游直接 400，所以这里把它摘干净（调用方多给了
/// 也照样摘）。连续同角色的消息合并成一条，避免上游拒绝「两条 user 挨着」——
/// 上一次发送失败时不会落盘 assistant 消息，这种相邻是常态而非异常。
pub fn build_request_body(model: &str, system: Option<&str>, messages: &[Turn]) -> Value {
    let mut system_parts: Vec<String> = Vec::new();
    if let Some(system) = system.map(str::trim).filter(|text| !text.is_empty()) {
        system_parts.push(system.to_string());
    }

    let mut turns: Vec<(String, String)> = Vec::new();
    for (role, content) in messages {
        let role = role.trim().to_ascii_lowercase();
        if role == "system" {
            let text = content.trim();
            if !text.is_empty() {
                system_parts.push(text.to_string());
            }
            continue;
        }
        if !matches!(role.as_str(), "user" | "assistant") {
            continue;
        }
        if content.trim().is_empty() {
            continue;
        }
        match turns.last_mut() {
            Some((last_role, last)) if *last_role == role => {
                last.push_str("\n\n");
                last.push_str(content);
            }
            _ => turns.push((role, content.clone())),
        }
    }

    let messages: Vec<Value> = turns
        .into_iter()
        .map(|(role, content)| json!({ "role": role, "content": content }))
        .collect();

    let mut body = json!({
        "model": model,
        "max_tokens": MAX_TOKENS,
        "messages": messages,
        "stream": true,
    });
    if !system_parts.is_empty() {
        if let Some(fields) = body.as_object_mut() {
            fields.insert("system".to_string(), Value::String(system_parts.join("\n\n")));
        }
    }
    body
}

/// 一条流的终态。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// 收到上游的 `message_stop`（唯一的真终态）
    Complete,
    /// 流干净结束，但没有终态帧：上游断了，内容不可信
    Truncated,
}

/// 流式消费的结果。
#[derive(Debug, Clone)]
pub struct StreamResult {
    pub outcome: Outcome,
    /// 上游原文的累积。落盘或进 IPC 前**必须**过 `redact::redact_text`（chat.rs 负责）
    pub text: String,
    /// 上游在 `message_delta` 里给的 stop_reason（`end_turn` / `max_tokens` / …）
    pub stop_reason: Option<String>,
}

/// 发一次流式请求，把每个文本增量交给 `on_delta`。
///
/// 失败一律是 `Err`：连接失败、非 2xx、流中断、上游 `error` 事件、超过 deadline。
/// 只有 `Ok` 里的 `Outcome` 才说明「收到过终态」。
pub async fn stream_message<F>(
    target: &HubTarget,
    body: &Value,
    mut on_delta: F,
) -> Result<StreamResult, String>
where
    F: FnMut(&str),
{
    let client = reqwest::Client::builder()
        // 本机跑着 Clash：默认会连 127.0.0.1 一起代理出去，表现为莫名其妙的连接失败。
        // 同 Python 侧 claude-provider-once.py 的 `build_opener(ProxyHandler({}))`。
        .no_proxy()
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(STREAM_IDLE_TIMEOUT)
        .build()
        .map_err(|err| format!("无法创建 HTTP 客户端：{}", redact::redact_text(&err.to_string())))?;

    let started = Instant::now();
    let mut response = client
        .post(target.endpoint())
        .bearer_auth(&target.token)
        .json(body)
        .send()
        .await
        .map_err(|err| {
            format!(
                "无法连接 hub {}（{}）：{}",
                target.name,
                target.base_url,
                redact::redact_text(&err.to_string())
            )
        })?;

    let status = response.status();
    if !status.is_success() {
        let raw = response.text().await.unwrap_or_default();
        return Err(format!(
            "hub {} 返回 HTTP {}：{}",
            target.name,
            status.as_u16(),
            sanitize_error_body(&raw)
        ));
    }

    let mut parser = sse::Parser::new();
    let mut text = String::new();
    let mut stop_reason: Option<String> = None;
    let mut stopped = false;
    let mut failure: Option<String> = None;

    'stream: loop {
        if started.elapsed() >= STREAM_DEADLINE {
            return Err(format!(
                "hub {} 的回复超过 {} 分钟仍未结束，已放弃（收到 {} 个字符）",
                target.name,
                STREAM_DEADLINE.as_secs() / 60,
                text.chars().count()
            ));
        }
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(err) => {
                return Err(format!(
                    "hub {} 的回复流中断：{}",
                    target.name,
                    redact::redact_text(&err.to_string())
                ))
            }
        };
        for event in parser.feed(&chunk) {
            // 事件类型：SSE 的 `event:` 是权威；上游只给 data 时退回 JSON 里的 `type`
            let payload: Value = serde_json::from_str(&event.data).unwrap_or(Value::Null);
            let kind = if event.event.is_empty() || event.event == "message" {
                payload
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or(event.event.as_str())
                    .to_string()
            } else {
                event.event.clone()
            };
            match kind.as_str() {
                "content_block_delta" => {
                    if let Some(delta) = payload
                        .get("delta")
                        .and_then(|delta| delta.get("text"))
                        .and_then(Value::as_str)
                    {
                        text.push_str(delta);
                        on_delta(delta);
                    }
                }
                "message_delta" => {
                    if let Some(reason) = payload
                        .pointer("/delta/stop_reason")
                        .and_then(Value::as_str)
                    {
                        stop_reason = Some(reason.to_string());
                    }
                }
                "message_stop" => stopped = true,
                "error" => {
                    failure = Some(format!(
                        "hub {} 报错：{}",
                        target.name,
                        redact::redact_text(error_event_message(&payload, &event.data))
                    ));
                }
                _ => {}
            }
            // 上游已经报错时不再等它自己断流：终态永远不会来了
            if failure.is_some() {
                break 'stream;
            }
        }
    }
    parser.finish();

    if let Some(failure) = failure {
        return Err(failure);
    }

    Ok(StreamResult {
        outcome: if stopped {
            Outcome::Complete
        } else {
            Outcome::Truncated
        },
        text,
        stop_reason,
    })
}

/// `error` 事件里那句人话。
fn error_event_message<'a>(payload: &'a Value, raw: &'a str) -> &'a str {
    payload
        .pointer("/error/message")
        .and_then(Value::as_str)
        .or_else(|| payload.get("message").and_then(Value::as_str))
        .unwrap_or(raw)
}

// ---------------------------------------------------------------------------
// 错误体脱敏
// ---------------------------------------------------------------------------

/// 上游/中间层的错误体：截断 → 显式打码 `Authorization` → 通用脱敏。
fn sanitize_error_body(raw: &str) -> String {
    let truncated: String = raw.chars().take(ERROR_BODY_LIMIT).collect();
    redact::redact_text(&mask_authorization_values(&truncated))
}

/// 把 `Authorization: Bearer <值>` 的值整段换成占位。
///
/// 通用脱敏只按 24 字符阈值吃串，`Bearer` 之后的片段可能短于阈值（`Bearer abc`），
/// 所以这条显式规则不能省。只吃掉冒号后的值，错误体其余部分照常显示。
fn mask_authorization_values(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some((value_start, value_end)) = find_authorization_value(rest) {
        out.push_str(&rest[..value_start]);
        out.push_str(redact::MASK);
        rest = &rest[value_end..];
    }
    out.push_str(rest);
    out
}

/// 找 `Authorization` 头（大小写不敏感）冒号后的值区间：`(start, end)` 字节下标。
fn find_authorization_value(text: &str) -> Option<(usize, usize)> {
    let lowered = text.to_ascii_lowercase();
    const NEEDLE: &str = "authorization";
    let mut search_from = 0usize;
    while let Some(offset) = lowered[search_from..].find(NEEDLE) {
        let name_at = search_from + offset;
        let after_name = name_at + NEEDLE.len();
        let rest = &text[after_name..];
        let spaced = rest.trim_start_matches([' ', '\t']);
        if spaced.starts_with(':') {
            let colon_at = after_name + (rest.len() - spaced.len());
            let value = &text[colon_at + 1..];
            let trimmed = value.trim_start_matches([' ', '\t']);
            let value_start = colon_at + 1 + (value.len() - trimmed.len());
            let value_end = value_start
                + text[value_start..]
                    .bytes()
                    .take_while(|byte| is_credential_byte(*byte))
                    .count();
            if value_end > value_start {
                return Some((value_start, value_end));
            }
        }
        search_from = name_at + 1;
    }
    None
}

/// 凭证形状的字节：`Bearer` 这个词本身也在其中，所以整段一起被吃掉。
fn is_credential_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || b"-_./+=~".contains(&byte)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;

    /// 环境变量是进程级的，这些测试必须串行。
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    const TOKEN_ENV: &str = "PF_TEST_HUB_TOKEN";

    struct HubEnv {
        dir: std::path::PathBuf,
        config_path: std::path::PathBuf,
        _guard: std::sync::MutexGuard<'static, ()>,
        fake_token: String,
    }

    impl HubEnv {
        /// 写一份合成 hub 配置：token 值现场拼，不进仓库也不进日志。
        fn new(tag: &str) -> Self {
            // 一个测试断言失败不该让同进程的其他测试跟着报 PoisonError
            let guard = ENV_LOCK
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let dir = std::env::temp_dir().join(format!("claude1-desktop-chat-hub-{tag}"));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let config_path = dir.join("claude-hub.json");
            let fake_token = format!("hub-fake-{}", "k".repeat(30));
            std::fs::write(
                &config_path,
                json!({
                    "version": 2,
                    "port": 19999,
                    "local_token": fake_token,
                    "local_token_env": TOKEN_ENV,
                    "channels": {},
                    "model_slots": {},
                })
                .to_string(),
            )
            .unwrap();
            std::env::set_var("CLAUDE_HUB_CONFIG", &config_path);
            std::env::remove_var("CLAUDE_HUB_PORT");
            std::env::remove_var(TOKEN_ENV);
            HubEnv {
                dir,
                config_path,
                _guard: guard,
                fake_token,
            }
        }

        /// 换一份配置（默认 hub 的配置路径由 CLAUDE_HUB_CONFIG 决定）。
        fn write_config(&self, value: Value) {
            std::fs::write(&self.config_path, value.to_string()).unwrap();
        }
    }

    impl Drop for HubEnv {
        fn drop(&mut self) {
            std::env::remove_var("CLAUDE_HUB_CONFIG");
            std::env::remove_var("CLAUDE_HUB_PORT");
            std::env::remove_var(TOKEN_ENV);
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn config() -> Map<String, Value> {
        match json!({ "port": 18787, "local_token": "file-token", "local_token_env": TOKEN_ENV }) {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    /// 目标解析的失败文案。`HubTarget` 故意不实现 `Debug`（它带着 token），
    /// 所以测试里用这个而不是 `unwrap_err`。
    fn resolve_error(name: Option<&str>) -> String {
        match resolve_target(name) {
            Ok(_) => panic!("{name:?} 不该解析成功"),
            Err(error) => error,
        }
    }

    /// 读一次完整请求（头部 + Content-Length 指定的体），够假上游判形状用。
    fn read_request(stream: &mut std::net::TcpStream) -> String {
        stream.set_read_timeout(Some(Duration::from_millis(500))).ok();
        let mut buffer: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 1024];
        let header_end = loop {
            if let Some(index) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
            match stream.read(&mut chunk) {
                Ok(0) => break buffer.len(),
                Ok(read) => buffer.extend_from_slice(&chunk[..read]),
                Err(_) => break buffer.len(),
            }
        };
        let headers = String::from_utf8_lossy(&buffer[..header_end]).to_string();
        let length = headers
            .lines()
            .filter_map(|line| line.split_once(':'))
            .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, value)| value.trim().parse::<usize>().ok())
            .unwrap_or(0);
        while buffer.len() < header_end + length {
            match stream.read(&mut chunk) {
                Ok(0) => break,
                Ok(read) => buffer.extend_from_slice(&chunk[..read]),
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&buffer).to_string()
    }

    /// 起一个只服务一次的假上游，返回端口（请求内容丢弃）。
    fn serve_once(response: String) -> u16 {
        serve_once_capturing(response).0
    }

    /// 同上，但把收到的请求原文交回来，用于断言真发出去的是什么。
    fn serve_once_capturing(response: String) -> (u16, std::sync::mpsc::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let request = read_request(&mut stream);
                let _ = sender.send(request);
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        (port, receiver)
    }

    fn sse_response(body: &str) -> String {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
    }

    fn target(port: u16) -> HubTarget {
        HubTarget {
            name: "claude-hub".to_string(),
            base_url: format!("http://127.0.0.1:{port}"),
            token: "synthetic-token".to_string(),
        }
    }

    #[test]
    fn port_prefers_a_nonempty_override_and_has_no_fallback() {
        let config = config();
        assert_eq!(resolve_port(&config, Some("20001")).unwrap(), 20001);
        assert_eq!(resolve_port(&config, Some("  ")).unwrap(), 18787);
        assert_eq!(resolve_port(&config, None).unwrap(), 18787);
        assert!(resolve_port(&config, Some("abc"))
            .unwrap_err()
            .contains(PORT_ENV));
        assert!(resolve_port(&config, Some("70000")).is_err());
        let empty = Map::new();
        let err = resolve_port(&empty, None).unwrap_err();
        assert!(err.contains("没有可用的端口"), "{err}");
    }

    #[test]
    fn token_prefers_a_nonempty_env_then_the_file() {
        let config = config();
        let path = std::path::PathBuf::from("/tmp/synthetic-hub.json");
        assert_eq!(
            resolve_token(Some("from-env"), &config, TOKEN_ENV, &path).unwrap(),
            "from-env"
        );
        // 空串等价于没设置
        assert_eq!(
            resolve_token(Some("   "), &config, TOKEN_ENV, &path).unwrap(),
            "file-token"
        );
        assert_eq!(
            resolve_token(None, &config, TOKEN_ENV, &path).unwrap(),
            "file-token"
        );
        let empty = Map::new();
        let err = resolve_token(None, &empty, TOKEN_ENV, &path).unwrap_err();
        assert!(err.contains(TOKEN_ENV), "{err}");
        assert!(err.contains("local_token"), "{err}");
    }

    #[test]
    fn token_env_name_shape_is_guarded() {
        assert_eq!(resolve_token_env(&config()), TOKEN_ENV);
        assert_eq!(
            resolve_token_env(&json!({ "local_token_env": "1nope" }).as_object().unwrap().clone()),
            DEFAULT_TOKEN_ENV
        );
        assert_eq!(
            resolve_token_env(&json!({}).as_object().unwrap().clone()),
            DEFAULT_TOKEN_ENV
        );
    }

    #[test]
    fn authorization_echoes_in_an_error_body_are_masked() {
        let fake = format!("hub-fake-{}", "k".repeat(30));
        for body in [
            format!("401 Unauthorized\nAuthorization: Bearer {fake}\n"),
            format!("{{\"detail\":\"authorization: bearer {fake} rejected\"}}"),
            format!("AUTHORIZATION : Bearer {fake}"),
        ] {
            let safe = sanitize_error_body(&body);
            assert!(!safe.contains(&fake), "{safe}");
            assert!(!safe.contains("Bearer"), "{safe}");
            assert!(!safe.contains("bearer"), "{safe}");
            assert!(safe.contains(redact::MASK), "{safe}");
        }
        // 与凭证无关的错误照常显示，不因为打码规则整段吞掉
        let kept = sanitize_error_body("429 rate limited: retry later");
        assert_eq!(kept, "429 rate limited: retry later");
        // 超长错误体截断
        assert!(sanitize_error_body(&"x".repeat(2_000)).chars().count() <= ERROR_BODY_LIMIT);
    }

    #[test]
    fn system_messages_are_hoisted_out_of_the_messages_array() {
        let turns = vec![
            ("system".to_string(), "你是本地助手".to_string()),
            ("user".to_string(), "你好".to_string()),
            ("assistant".to_string(), "在的".to_string()),
            ("system".to_string(), "还有一条设定".to_string()),
        ];
        let body = build_request_body("glm-5.2", None, &turns);
        assert_eq!(body["system"], json!("你是本地助手\n\n还有一条设定"));
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert!(messages
            .iter()
            .all(|message| message["role"] != json!("system")));
        assert_eq!(messages[0]["role"], json!("user"));
        assert_eq!(messages[0]["content"], json!("你好"));
        assert_eq!(body["max_tokens"], json!(MAX_TOKENS));
        assert_eq!(body["stream"], json!(true));
        assert_eq!(body["model"], json!("glm-5.2"));
    }

    #[test]
    fn adjacent_same_role_messages_are_merged_and_junk_is_dropped() {
        let turns = vec![
            ("user".to_string(), "第一条".to_string()),
            ("user".to_string(), "第二条".to_string()),
            ("tool".to_string(), "不该出现".to_string()),
            ("assistant".to_string(), "   ".to_string()),
            ("assistant".to_string(), "回复".to_string()),
        ];
        let body = build_request_body("m", Some("设定"), &turns);
        let messages = body["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0]["content"], json!("第一条\n\n第二条"));
        assert_eq!(messages[1]["content"], json!("回复"));
        assert_eq!(body["system"], json!("设定"));
    }

    #[test]
    fn a_body_without_system_has_no_top_level_system_field() {
        let body = build_request_body("m", None, &[("user".to_string(), "hi".to_string())]);
        assert!(body.get("system").is_none());
    }

    #[test]
    fn a_complete_stream_reports_stop_and_accumulates_text() {
        let body = "event: message_start\ndata: {\"type\":\"message_start\"}\n\n\
event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"你\"}}\n\n\
event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"好\"}}\n\n\
event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}\n\n\
event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n";
        let port = serve_once(sse_response(body));
        let request = build_request_body("m", None, &[("user".to_string(), "hi".to_string())]);
        let mut deltas = Vec::new();
        let result = tauri::async_runtime::block_on(stream_message(&target(port), &request, |delta| {
            deltas.push(delta.to_string())
        }))
        .unwrap();
        assert_eq!(result.outcome, Outcome::Complete);
        assert_eq!(result.text, "你好");
        assert_eq!(result.stop_reason.as_deref(), Some("max_tokens"));
        assert_eq!(deltas, vec!["你".to_string(), "好".to_string()]);
    }

    #[test]
    fn a_clean_eof_without_message_stop_is_truncated() {
        let body = "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"半\"}}\n\n\
event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"句\"}}\n\n";
        let port = serve_once(sse_response(body));
        let request = build_request_body("m", None, &[("user".to_string(), "hi".to_string())]);
        let result =
            tauri::async_runtime::block_on(stream_message(&target(port), &request, |_| {})).unwrap();
        assert_eq!(result.outcome, Outcome::Truncated);
        assert_eq!(result.text, "半句");
        assert!(result.stop_reason.is_none());
    }

    #[test]
    fn an_error_event_fails_the_call_and_keeps_the_message() {
        let body = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"上游过载\"}}\n\n";
        let port = serve_once(sse_response(body));
        let request = build_request_body("m", None, &[("user".to_string(), "hi".to_string())]);
        let err = tauri::async_runtime::block_on(stream_message(&target(port), &request, |_| {}))
            .unwrap_err();
        assert!(err.contains("上游过载"), "{err}");
    }

    #[test]
    fn short_credentials_in_http_and_sse_errors_never_reach_the_caller() {
        let message = format!("upstream https://{}:{}@example.invalid/v1?api_key={} failed; token={}", "user", "shortpass", "shortkey", "tiny"); // secret-guard: allow embedded-url-credential (synthetic format placeholders)
        let event = json!({"type": "error", "error": {"message": message}});
        let responses = [
            format!("HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", message.len(), message),
            sse_response(&format!("event: error\ndata: {event}\n\n")),
        ];
        for response in responses {
            let port = serve_once(response);
            let request = build_request_body("m", None, &[("user".into(), "hi".into())]);
            let err = tauri::async_runtime::block_on(stream_message(&target(port), &request, |_| {})).unwrap_err();
            for secret in ["shortpass", "shortkey", "tiny"] {
                assert!(!err.contains(secret), "credential escaped in error");
            }
            assert!(err.contains("example.invalid/v1"));
        }
    }

    #[test]
    fn the_request_on_the_wire_carries_the_bearer_token_and_the_top_level_system() {
        let env = HubEnv::new("wire");
        let fake = env.fake_token.clone();
        std::env::set_var(TOKEN_ENV, &fake);
        let (port, requests) =
            serve_once_capturing(sse_response("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"));
        std::env::set_var("CLAUDE_HUB_PORT", port.to_string());
        let target = resolve_target(None).unwrap();
        let request = build_request_body(
            "合成模型",
            Some("会话设定"),
            &[("user".to_string(), "你好".to_string())],
        );
        tauri::async_runtime::block_on(stream_message(&target, &request, |_| {})).unwrap();

        let wire = requests.recv().unwrap();
        assert!(wire.starts_with("POST /v1/messages "), "路径不对");
        assert!(
            wire.to_ascii_lowercase().contains("authorization: bearer "),
            "缺 Authorization 头"
        );
        // 头里带的就是配置里的令牌（合成值）
        assert!(wire.contains(&fake), "请求头没带上配置的令牌");
        let body = wire.split("\r\n\r\n").nth(1).unwrap_or("");
        let parsed: Value = serde_json::from_str(body).expect("请求体是 JSON");
        assert_eq!(parsed["system"], json!("会话设定"));
        assert_eq!(parsed["max_tokens"], json!(MAX_TOKENS));
        assert_eq!(parsed["stream"], json!(true));
        assert_eq!(parsed["model"], json!("合成模型"));
        let messages = parsed["messages"].as_array().unwrap();
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0]["role"], json!("user"));
    }

    #[test]
    fn an_authorization_echo_in_the_error_page_never_reaches_the_caller() {
        let env = HubEnv::new("body-echo");
        let fake = env.fake_token.clone();
        let port = serve_once(format!(
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            format!("bad key: Authorization: Bearer {fake}").len(),
            format!("bad key: Authorization: Bearer {fake}")
        ));
        std::env::set_var("CLAUDE_HUB_PORT", port.to_string());
        let target = resolve_target(None).unwrap();
        let request = build_request_body("m", None, &[("user".to_string(), "hi".to_string())]);
        let err = tauri::async_runtime::block_on(stream_message(&target, &request, |_| {}))
            .unwrap_err();
        assert!(err.contains("401"), "{err}");
        assert!(!err.contains(&fake), "{err}");
        assert!(!err.contains("Bearer"), "{err}");
    }

    #[test]
    fn every_error_path_stays_free_of_the_configured_credential() {
        let env = HubEnv::new("no-leak");
        let fake = env.fake_token.clone();
        std::env::set_var(TOKEN_ENV, &fake);
        let errors: Vec<String> = vec![
            // 未知 hub
            resolve_error(Some("no-such-hub")),
            // 端口非法
            {
                std::env::set_var("CLAUDE_HUB_PORT", "not-a-port");
                let err = resolve_error(None);
                std::env::remove_var("CLAUDE_HUB_PORT");
                err
            },
            // 缺端口
            {
                env.write_config(json!({ "local_token": fake.clone(), "local_token_env": TOKEN_ENV }));
                resolve_error(None)
            },
            // 配置文件不存在
            {
                std::env::set_var("CLAUDE_HUB_CONFIG", env.dir.join("absent.json"));
                let err = resolve_error(None);
                std::env::set_var("CLAUDE_HUB_CONFIG", &env.config_path);
                err
            },
            // 连不上（没有监听者的端口）
            {
                env.write_config(json!({
                    "port": 1,
                    "local_token": fake.clone(),
                    "local_token_env": TOKEN_ENV,
                }));
                let target = resolve_target(None).unwrap();
                let request =
                    build_request_body("m", None, &[("user".to_string(), "hi".to_string())]);
                tauri::async_runtime::block_on(stream_message(&target, &request, |_| {}))
                    .unwrap_err()
            },
        ];
        for error in errors {
            assert!(!error.contains(&fake), "{error}");
            assert!(!error.contains("Bearer"), "{error}");
            assert!(!error.contains("bearer"), "{error}");
            assert!(!error.is_empty());
        }
        // 缺令牌的报错里点名环境变量与配置文件，但同样不含令牌值
        std::env::remove_var(TOKEN_ENV);
        env.write_config(json!({ "port": 19999, "local_token_env": TOKEN_ENV }));
        let err = resolve_error(None);
        assert!(err.contains(TOKEN_ENV), "{err}");
        assert!(!err.contains(&fake), "{err}");
    }

    #[test]
    fn a_missing_token_is_reported_before_any_request_is_sent() {
        let env = HubEnv::new("missing-token");
        std::env::remove_var(TOKEN_ENV);
        env.write_config(json!({ "port": 19999 }));
        let err = resolve_error(None);
        assert!(err.contains("没有可用的本地令牌"), "{err}");
        assert!(err.contains(error::tilde(&env.config_path).as_str()), "{err}");
    }
}
