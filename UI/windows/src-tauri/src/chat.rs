//! 对话（本轮恒为演示实现，CONTRACT.md §3 list_chat_sessions / send_chat_message）。
//!
//! 不连任何上游：内置 3 个演示会话存在内存里，`send_chat_message` 把用户消息追加进
//! 会话并返回一条模板化的演示回复。会话与消息的字段形状对齐 Anthropic 兼容的
//! POST /v1/messages（role + 文本 content），真后端接入时 IPC 签名与形状不变。
//!
//! 演示态的已知边界：进程退出后会话重置回内置数据，追加的消息不持久化。

use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::channels;
use crate::redact;

/// 演示降级提示，会话的 system 消息与回复里都用这一句。
const DEMO_NOTICE: &str = "当前为演示数据，未连接真实后端；接入 claude-hub 后这里会返回真实回复。";

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
}

/// 演示会话的内存存储。进程级单例，`send_chat_message` 的追加只在本次运行内可见。
static SESSIONS: OnceLock<Mutex<Vec<ChatSession>>> = OnceLock::new();

fn store() -> &'static Mutex<Vec<ChatSession>> {
    SESSIONS.get_or_init(|| Mutex::new(demo_sessions()))
}

fn now_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|span| span.as_secs() as i64)
        .unwrap_or(0)
}

fn message(role: &str, content: &str, ts: i64) -> ChatMessage {
    ChatMessage {
        role: role.to_string(),
        content: content.to_string(),
        ts,
    }
}

/// 渠道与模型的绑定：能读到真实渠道就用真实 Channel.id 与声明模型，读不到就 null。
fn demo_binding(prefer_current: bool) -> (Option<String>, String) {
    let channels = channels::list_channels().unwrap_or_default();
    let picked = if prefer_current {
        channels.iter().find(|channel| channel.is_current)
    } else {
        None
    };
    let picked = picked.or_else(|| channels.first());
    match picked {
        Some(channel) => {
            let model = channel
                .model_override
                .clone()
                .or_else(|| channel.declared_model.clone())
                .unwrap_or_else(|| "claude-sonnet-4-5".to_string());
            (Some(channel.id.clone()), model)
        }
        None => (None, "claude-sonnet-4-5".to_string()),
    }
}

/// 内置的 3 个演示会话。
fn demo_sessions() -> Vec<ChatSession> {
    let now = now_ts();
    let (channel_a, model_a) = demo_binding(true);
    vec![
        ChatSession {
            id: "demo-current-channel".to_string(),
            title: "当前渠道冒烟对话".to_string(),
            channel_id: channel_a,
            model: model_a,
            created_at: now - 3_600,
            updated_at: now - 1_800,
            messages: vec![
                message("system", DEMO_NOTICE, now - 3_600),
                message(
                    "user",
                    "你好，帮我确认一下这条渠道是不是真的通了。",
                    now - 3_540,
                ),
                message(
                    "assistant",
                    "（演示回复）这条消息没有真的发到任何上游。等接入 claude-hub 后，这个问题会带着你选的渠道与模型走一遍真实请求，通不通一看回复就知道。",
                    now - 3_500,
                ),
                message("user", "那这个会话现在是在哪个模型上？", now - 1_860),
                message(
                    "assistant",
                    "（演示回复）看会话头部的模型名，它来自所选渠道在 CC Switch 里声明的默认模型或你的本地覆盖。",
                    now - 1_800,
                ),
            ],
        },
        ChatSession {
            id: "demo-slot-compare".to_string(),
            title: "槽位模型对比".to_string(),
            channel_id: None,
            model: "claude-sonnet-4-5".to_string(),
            created_at: now - 7_200,
            updated_at: now - 7_000,
            messages: vec![
                message("system", DEMO_NOTICE, now - 7_200),
                message("user", "sonnet 槽位和 opus 槽位各绑了哪个渠道？", now - 7_100),
                message(
                    "assistant",
                    "（演示回复）真实的槽位绑定看「模型槽位」那一页，那里读的是 claude-hub.json 的真值。这里的对话只是演示，不接真后端。",
                    now - 7_000,
                ),
            ],
        },
        ChatSession {
            id: "demo-free-chat".to_string(),
            title: "未绑定渠道的自由会话".to_string(),
            channel_id: None,
            model: "claude-sonnet-4-5".to_string(),
            created_at: now - 86_400,
            updated_at: now - 86_000,
            messages: vec![
                message("system", DEMO_NOTICE, now - 86_400),
                message("user", "没绑渠道的会话会走哪里？", now - 86_300),
                message(
                    "assistant",
                    "（演示回复）演示态哪儿也不走。接入真实后端后，未绑定渠道的会话会回落到默认 hub 的 default channel。",
                    now - 86_000,
                ),
            ],
        },
    ]
}

pub fn list_chat_sessions() -> Result<Vec<ChatSession>, String> {
    let sessions = store()
        .lock()
        .map_err(|_| "演示会话的内存存储已损坏（锁中毒），请重启应用".to_string())?;
    Ok(sessions.clone())
}

pub fn send_chat_message(session_id: &str, content: &str) -> Result<ChatMessage, String> {
    let content = content.trim();
    if content.is_empty() {
        return Err("消息内容为空，没有可发送的文本".to_string());
    }
    let mut sessions = store()
        .lock()
        .map_err(|_| "演示会话的内存存储已损坏（锁中毒），请重启应用".to_string())?;
    let session = sessions
        .iter_mut()
        .find(|session| session.id == session_id)
        .ok_or_else(|| {
            format!("找不到会话 {session_id}：演示态重启后会话会重置，请刷新会话列表重试")
        })?;

    let now = now_ts();
    // 用户输入是自由文本，入会话前过一遍长串清洗（CONTRACT.md §1.2 对 ChatMessage.content 的要求）。
    // 回复模板引用的也是这份脱敏文本——摘要把原始输入嵌进回复回显，等于绕过同一道闸。
    let sanitized = redact::redact_text(content);
    session.messages.push(message("user", &sanitized, now));

    let reply = message("assistant", &demo_reply(session, &sanitized), now);
    session.messages.push(reply.clone());
    session.updated_at = now;
    Ok(reply)
}

/// 模板化的演示回复：提到所选渠道与模型名，并明确这是演示。
fn demo_reply(session: &ChatSession, content: &str) -> String {
    let channel_name = session
        .channel_id
        .as_deref()
        .and_then(|id| {
            channels::list_channels()
                .ok()
                .and_then(|rows| rows.into_iter().find(|row| row.id == id))
                .map(|row| row.name)
        })
        .unwrap_or_else(|| "（未绑定渠道）".to_string());
    let excerpt: String = content.chars().take(40).collect();
    let ellipsis = if content.chars().count() > 40 { "…" } else { "" };
    format!(
        "（演示回复）你刚才说：「{excerpt}{ellipsis}」。这个会话绑定渠道「{channel_name}」、模型 {}。{DEMO_NOTICE}",
        session.model
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demo_sessions_have_three_roles_and_the_notice() {
        let sessions = demo_sessions();
        assert_eq!(sessions.len(), 3);
        let all: Vec<&ChatMessage> = sessions.iter().flat_map(|s| s.messages.iter()).collect();
        for role in ["user", "assistant", "system"] {
            assert!(all.iter().any(|m| m.role == role), "缺 {role} 角色");
        }
        assert!(all.iter().any(|m| m.content.contains("演示数据")));
    }

    #[test]
    fn send_appends_user_message_and_returns_demo_reply() {
        let sessions = list_chat_sessions().unwrap();
        let session = sessions
            .iter()
            .find(|s| s.id == "demo-free-chat")
            .unwrap()
            .clone();
        let before = session.messages.len();

        let reply = send_chat_message("demo-free-chat", "测试一下").unwrap();
        assert_eq!(reply.role, "assistant");
        assert!(reply.content.contains("演示回复"), "{}", reply.content);
        assert!(reply.content.contains("测试一下"));

        let after = list_chat_sessions().unwrap();
        let session = after.iter().find(|s| s.id == "demo-free-chat").unwrap();
        assert_eq!(session.messages.len(), before + 2);
        assert_eq!(session.messages[before].role, "user");
        assert_eq!(session.messages[before].content, "测试一下");
        assert_eq!(session.updated_at, reply.ts);
    }

    #[test]
    fn send_rejects_empty_content_and_unknown_session() {
        assert!(send_chat_message("demo-free-chat", "   ")
            .unwrap_err()
            .contains("为空"));
        assert!(send_chat_message("no-such-session", "hi")
            .unwrap_err()
            .contains("找不到会话"));
    }

    #[test]
    fn long_token_like_input_is_masked_in_stored_message() {
        // 高熵 key 字面量不入库：现场拼一个 24+ 字符的 token 形状串
        let fake = format!("sk-demo-{}", "x".repeat(30));
        send_chat_message("demo-slot-compare", &fake).unwrap();
        let sessions = list_chat_sessions().unwrap();
        let session = sessions.iter().find(|s| s.id == "demo-slot-compare").unwrap();
        let stored = &session.messages[session.messages.len() - 2];
        assert!(!stored.content.contains(&"x".repeat(30)));
        assert!(stored.content.contains(redact::MASK));
    }

    #[test]
    fn long_token_like_input_is_masked_in_demo_reply_too() {
        // demo_reply 会把输入前 40 字符嵌进回复：摘录必须取脱敏后文本，
        // 否则用户气泡有掩码、助手回复却原样回显（CONTRACT.md §1.2）。
        let fake = format!("sk-demo-{}", "x".repeat(30));
        let reply = send_chat_message("demo-slot-compare", &fake).unwrap();
        assert!(!reply.content.contains(&"x".repeat(30)), "{}", reply.content);
        assert!(reply.content.contains(redact::MASK));
    }
}
