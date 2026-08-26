//! 凭证脱敏，fail-closed（CONTRACT.md 1.2 节）。
//!
//! 三条规则：
//! 1. 键名命中敏感子串的字段一律剔除，只留「已配置 / 未配置」布尔；
//! 2. 端点 URL 保留主机与路径，剥掉 userinfo 与查询串；
//! 3. 自由文本（notes、错误 message）里长度 ≥ 24 的 `[A-Za-z0-9_-]` 串换成固定占位。
//!
//! 这些函数是返回值离开 Rust 之前的最后一道闸门；宁可多剥，不可漏出。

use serde_json::{Map, Value};

/// 命中即视为凭证字段（大小写不敏感、子串匹配）。
pub const SENSITIVE_KEY_FRAGMENTS: [&str; 9] = [
    "key",
    "token",
    "secret",
    "password",
    "auth",
    "credential",
    "cookie",
    "authorization",
    "bearer",
];

/// 被剥掉的自由文本片段统一显示成这个占位。
pub const MASK: &str = "••••";

/// 长串阈值：24 个字符以上的 token 形状串一律当凭证处理。
const TOKEN_MIN_LEN: usize = 24;

/// 键名是否属于凭证字段。
pub fn is_sensitive_key(key: &str) -> bool {
    let lowered = key.to_ascii_lowercase();
    SENSITIVE_KEY_FRAGMENTS
        .iter()
        .any(|fragment| lowered.contains(fragment))
}

/// 一个值是否算「已配置」。空串、空对象、空数组、null、false 都算未配置。
pub fn is_configured_value(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(_) => true,
        Value::String(text) => !text.trim().is_empty(),
        Value::Array(items) => !items.is_empty(),
        Value::Object(fields) => !fields.is_empty(),
    }
}

/// 把自由文本里的长 token 形状串换成占位。
///
/// 只认 ASCII 的 `[A-Za-z0-9_-]`，所以中文说明与短模型名不会被误伤。
pub fn redact_text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut run = String::new();
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            run.push(ch);
            continue;
        }
        flush_run(&mut run, &mut out);
        out.push(ch);
    }
    flush_run(&mut run, &mut out);
    out
}

fn flush_run(run: &mut String, out: &mut String) {
    if run.is_empty() {
        return;
    }
    if run.chars().count() >= TOKEN_MIN_LEN {
        out.push_str(MASK);
    } else {
        out.push_str(run);
    }
    run.clear();
}

/// `Option<String>` 版本的自由文本清洗。空串归一成 `None`。
pub fn redact_opt(input: Option<&str>) -> Option<String> {
    let text = input?.trim();
    if text.is_empty() {
        return None;
    }
    Some(redact_text(text))
}

/// 端点 URL 只保留 scheme + 主机 + 路径：`https://u:p@h/x?k=v` → `https://h/x`。（u/p/h 为占位符）secret-guard: allow embedded-url-credential
pub fn sanitize_endpoint(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (scheme, rest) = match trimmed.find("://") {
        Some(idx) => (Some(&trimmed[..idx]), &trimmed[idx + 3..]),
        None => (None, trimmed),
    };
    // 先切掉查询串与片段，再切 userinfo，避免 query 里的 `@` 干扰
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let (authority, path) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, ""),
    };
    let host = match authority.rfind('@') {
        Some(idx) => &authority[idx + 1..],
        None => authority,
    };
    if host.is_empty() {
        return None;
    }
    let mut out = String::new();
    if let Some(scheme) = scheme {
        out.push_str(scheme);
        out.push_str("://");
    }
    out.push_str(host);
    out.push_str(path.trim_end_matches('/'));
    Some(out)
}

/// 递归剔除对象里的凭证字段，替换为「已配置 / 未配置」布尔。
///
/// 用在需要整体转手一份外部 JSON 的地方（例如 hub 配置里带着 `local_token`），
/// 保证即使上游以后加了新的凭证键，也不会因为桌面端不认识就漏出去。
pub fn strip_sensitive(value: &Value) -> Value {
    match value {
        Value::Object(fields) => {
            let mut out = Map::with_capacity(fields.len());
            for (key, item) in fields {
                if is_sensitive_key(key) {
                    out.insert(key.clone(), Value::Bool(is_configured_value(item)));
                } else {
                    out.insert(key.clone(), strip_sensitive(item));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(strip_sensitive).collect()),
        other => other.clone(),
    }
}

/// 环境变量里是否存在已配置的凭证。只看键名与是否非空，从不读值本身。
pub fn has_configured_credential(env: &Map<String, Value>) -> bool {
    env.iter()
        .any(|(key, value)| is_sensitive_key(key) && is_configured_value(value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sensitive_key_matches_substring_case_insensitively() {
        for key in [
            "ANTHROPIC_API_KEY",
            "anthropic_auth_token",
            "Secret",
            "USER_PASSWORD",
            "auth_mode",
            "MY_CREDENTIAL",
            "Cookie",
            "Authorization",
            "BEARER_X",
            "local_token",
        ] {
            assert!(is_sensitive_key(key), "{key} 应该被判定为凭证键");
        }
        for key in [
            "ANTHROPIC_BASE_URL",
            "model",
            "effortLevel",
            "context_window",
        ] {
            assert!(!is_sensitive_key(key), "{key} 不该被判定为凭证键");
        }
    }

    #[test]
    fn long_runs_are_masked_and_short_text_survives() {
        // 高熵 key 字面量不入库：用重复字符现场拼出同样形态的假 key，仍能命中掩码正则
        let fake_key = format!("sk-nry-{}", "k".repeat(40));
        let masked = redact_text(&format!("notes: {fake_key}"));
        assert!(!masked.contains(&"k".repeat(40)));
        assert!(masked.contains(MASK));
        assert_eq!(
            redact_text("模型 glm-5.2 走 openai_chat"),
            "模型 glm-5.2 走 openai_chat"
        );
        // 恰好 24 个字符要命中，23 个不命中
        assert_eq!(redact_text(&"a".repeat(24)), MASK);
        assert_eq!(redact_text(&"a".repeat(23)), "a".repeat(23));
    }

    #[test]
    fn endpoint_drops_userinfo_and_query() {
        assert_eq!(
            sanitize_endpoint("https://u:p@h/x?k=v").as_deref(), // secret-guard: allow embedded-url-credential（u/p/h 为占位符）
            Some("https://h/x")
        );
        assert_eq!(
            sanitize_endpoint("https://router.bynara.id/").as_deref(),
            Some("https://router.bynara.id")
        );
        assert_eq!(
            sanitize_endpoint("http://127.0.0.1:18317/v1?token=abc").as_deref(),
            Some("http://127.0.0.1:18317/v1")
        );
        assert_eq!(sanitize_endpoint("  ").as_deref(), None);
    }

    #[test]
    fn nested_credentials_collapse_to_bool() {
        let raw = json!({
            "port": 18787,
            "local_token": "hub-local-fake",
            "env": { "ANTHROPIC_API_KEY": "", "ANTHROPIC_BASE_URL": "https://h" },
            "list": [ { "authorization": "Bearer x" } ]
        });
        let safe = strip_sensitive(&raw);
        assert_eq!(safe["local_token"], json!(true));
        assert_eq!(safe["env"]["ANTHROPIC_API_KEY"], json!(false));
        assert_eq!(safe["env"]["ANTHROPIC_BASE_URL"], json!("https://h"));
        assert_eq!(safe["list"][0]["authorization"], json!(true));
        assert_eq!(safe["port"], json!(18787));
        // 原始文本一个字都不许出现在结果里
        let dumped = safe.to_string();
        assert!(!dumped.contains("hub-local"));
        assert!(!dumped.contains("Bearer"));
    }

    #[test]
    fn credential_state_only_reads_key_and_emptiness() {
        let mut env = Map::new();
        assert!(!has_configured_credential(&env));
        env.insert("ANTHROPIC_AUTH_TOKEN".into(), json!(""));
        assert!(!has_configured_credential(&env));
        env.insert("ANTHROPIC_API_KEY".into(), json!("sk-live"));
        assert!(has_configured_credential(&env));
    }

    #[test]
    fn blank_free_text_becomes_none() {
        assert_eq!(redact_opt(None), None);
        assert_eq!(redact_opt(Some("   ")), None);
        assert_eq!(redact_opt(Some(" 备注 ")).as_deref(), Some("备注"));
    }
}
