//! 渠道读取与本地覆盖写入。
//!
//! 读：CC Switch 数据库（只读）+ `claude1-config.json` 的本地覆盖 + `claude1-mru.json`。
//! 写：只碰 `claude1-config.json`，绝不写数据库（CONTRACT.md 3 节 set_channel_override）。
//! 凭证按白名单取字段：只挑端点、模型名、上下文窗口这些明确安全的键，
//! 凭证本身连读都不往结构体里放。

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::db;
use crate::error;
use crate::paths;
use crate::redact;

/// 四个模型槽位的固定顺序。
pub const SLOT_ORDER: [&str; 4] = ["fable", "opus", "sonnet", "haiku"];

/// effort 五档里的四个有效值（第五档「未设置」用 `None` 表达）。
pub const EFFORT_LEVELS: [&str; 4] = ["low", "medium", "high", "xhigh"];

/// settings_config 里固定子代理模型的键，体检要报它。
pub const SUBAGENT_MODEL_KEY: &str = "CLAUDE_CODE_SUBAGENT_MODEL";

/// claude1 的保留命令词，不能当渠道别名（与 claude-provider-once.py 的
/// RESERVED_SELECTOR_WORDS 一致）。
const RESERVED_ALIAS_WORDS: [&str; 15] = [
    "any",
    "anyrouter",
    "cc",
    "current",
    "direct",
    "hub",
    "config",
    "doctor",
    "errors",
    "help",
    "list",
    "usage",
    "accounts",
    "use",
    "version",
];

/// `claude1-config.json` 要求的版本。低于它就说明还没被 claude1 迁移过。
const REQUIRED_CONFIG_VERSION: i64 = 3;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub alias: Option<String>,
    pub api_format: &'static str,
    pub endpoint: Option<String>,
    pub credential: &'static str,
    pub is_current: bool,
    pub in_failover_queue: bool,
    pub hidden: bool,
    pub model_override: Option<String>,
    pub effort_override: Option<String>,
    pub declared_model: Option<String>,
    pub slot_models: BTreeMap<String, String>,
    pub context_window: Option<i64>,
    pub compatibility: &'static str,
    pub compatibility_reason: Option<String>,
    pub pins_subagent_model: bool,
    pub category: Option<String>,
    pub notes: Option<String>,
    pub icon_color: Option<String>,
    pub last_used_at: Option<i64>,
    pub sort_index: i64,
}

/// `claude1-config.json` 的全量内容。写回时以它为底，未知键因此原样保留。
pub struct LocalConfig {
    pub root: Map<String, Value>,
    pub path: PathBuf,
    pub existed: bool,
}

impl LocalConfig {
    pub fn load() -> Result<Self, String> {
        let path = paths::config_path()?;
        match paths::read_json_object(&path)? {
            Some(root) => Ok(Self {
                root,
                path,
                existed: true,
            }),
            None => {
                let mut root = Map::new();
                root.insert("version".into(), Value::from(REQUIRED_CONFIG_VERSION));
                root.insert("providers".into(), Value::Object(Map::new()));
                Ok(Self {
                    root,
                    path,
                    existed: false,
                })
            }
        }
    }

    pub fn version(&self) -> i64 {
        self.root
            .get("version")
            .and_then(|value| value.as_i64())
            .unwrap_or(1)
    }

    pub fn providers(&self) -> Option<&Map<String, Value>> {
        self.root.get("providers")?.as_object()
    }

    pub fn provider(&self, id: &str) -> Option<&Map<String, Value>> {
        self.providers()?.get(id)?.as_object()
    }
}

/// 读全部 claude 渠道（含 hidden，前端自己过滤）。
pub fn list_channels() -> Result<Vec<Channel>, String> {
    let rows = db::claude_provider_rows()?;
    let config = LocalConfig::load()?;
    let mru = load_mru();
    let mut out = Vec::with_capacity(rows.len());
    for (ordinal, row) in rows.iter().enumerate() {
        out.push(build_channel(row, ordinal, &config, &mru));
    }
    Ok(out)
}

/// 最近使用记录是尽力而为的辅助信息：坏了就当没有，不阻断渠道列表
/// （与 claude-provider-once.py 的 load_mru 一致）。
fn load_mru() -> BTreeMap<String, f64> {
    let Ok(path) = paths::mru_path() else {
        return BTreeMap::new();
    };
    let Ok(Some(root)) = paths::read_json_object(&path) else {
        return BTreeMap::new();
    };
    root.into_iter()
        .filter_map(|(key, value)| value.as_f64().map(|seconds| (key, seconds)))
        .collect()
}

fn build_channel(
    row: &db::ProviderRow,
    ordinal: usize,
    config: &LocalConfig,
    mru: &BTreeMap<String, f64>,
) -> Channel {
    let settings = parse_object(row.settings_config.as_deref());
    let meta = parse_object(row.meta.as_deref());
    let env = settings
        .as_ref()
        .and_then(|settings| settings.get("env"))
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();

    let local = config.provider(&row.id);
    let (compatibility, compatibility_reason) = resolve_compatibility(local);

    let endpoint =
        string_field(&env, "ANTHROPIC_BASE_URL").and_then(|raw| redact::sanitize_endpoint(&raw));
    let credential = if redact::has_configured_credential(&env) {
        "configured"
    } else {
        "missing"
    };

    let mut slot_models = BTreeMap::new();
    for slot in SLOT_ORDER {
        let upper = slot.to_ascii_uppercase();
        let model = string_field(&env, &format!("ANTHROPIC_DEFAULT_{upper}_MODEL"))
            .or_else(|| string_field(&env, &format!("ANTHROPIC_DEFAULT_{upper}_MODEL_NAME")));
        if let Some(model) = model {
            slot_models.insert(slot.to_string(), model);
        }
    }

    let context_window = settings
        .as_ref()
        .and_then(|settings| settings.get("claude1_capabilities"))
        .and_then(|value| value.as_object())
        .and_then(|caps| caps.get("context_window"))
        .and_then(|value| value.as_i64())
        .filter(|window| *window > 0);

    let last_used_at = mru
        .get(&row.id)
        .or_else(|| mru.get(&row.name))
        .map(|seconds| *seconds as i64);

    Channel {
        id: row.id.clone(),
        name: row.name.clone(),
        alias: local
            .and_then(|entry| entry.get("alias"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|alias| !alias.is_empty())
            .map(str::to_string),
        api_format: resolve_api_format(&settings, &meta, row.provider_type.as_deref()),
        endpoint,
        credential,
        is_current: row.is_current,
        in_failover_queue: row.in_failover_queue,
        hidden: local
            .and_then(|entry| entry.get("hidden"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false),
        model_override: local
            .and_then(|entry| entry.get("model"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|model| !model.is_empty())
            .map(str::to_string),
        effort_override: local
            .and_then(|entry| entry.get("effort"))
            .and_then(|value| value.as_str())
            .filter(|effort| EFFORT_LEVELS.contains(effort))
            .map(str::to_string),
        declared_model: string_field(&env, "ANTHROPIC_MODEL"),
        slot_models,
        context_window,
        compatibility,
        compatibility_reason,
        pins_subagent_model: env
            .get(SUBAGENT_MODEL_KEY)
            .map(redact::is_configured_value)
            .unwrap_or(false),
        category: row
            .category
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string),
        // notes 是自由文本，用户可能往里粘过 key，必须过一遍长串清洗。
        notes: redact::redact_opt(row.notes.as_deref()),
        icon_color: row
            .icon_color
            .as_deref()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string),
        last_used_at,
        sort_index: row.sort_index.unwrap_or(ordinal as i64),
    }
}

fn parse_object(raw: Option<&str>) -> Option<Map<String, Value>> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

fn string_field(map: &Map<String, Value>, key: &str) -> Option<String> {
    let text = map.get(key)?.as_str()?.trim();
    if text.is_empty() {
        return None;
    }
    Some(text.to_string())
}

/// 协议格式判定，优先级与 claude1_protocol.provider_api_format 完全一致。
///
/// 唯一的偏离：`settings_config` 整段解析不出来时返回 `unknown`，而不是像 CLI
/// 那样 fail-closed 到 `anthropic`——界面上「不知道」和「原生」必须区分开。
pub fn resolve_api_format(
    settings: &Option<Map<String, Value>>,
    meta: &Option<Map<String, Value>>,
    provider_type: Option<&str>,
) -> &'static str {
    let effective_type = provider_type
        .map(str::to_string)
        .or_else(|| {
            meta.as_ref()
                .and_then(|meta| meta.get("providerType"))
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .filter(|text| !text.trim().is_empty());
    if effective_type.as_deref() == Some("codex_oauth") {
        return "openai_responses";
    }
    if let Some(format) = meta
        .as_ref()
        .and_then(|meta| meta.get("apiFormat"))
        .and_then(|value| value.as_str())
        .and_then(canonical_api_format)
    {
        return format;
    }
    if let Some(format) = settings
        .as_ref()
        .and_then(|settings| settings.get("api_format"))
        .and_then(|value| value.as_str())
        .and_then(canonical_api_format)
    {
        return format;
    }
    if let Some(legacy) = settings
        .as_ref()
        .and_then(|settings| settings.get("openrouter_compat_mode"))
    {
        let enabled = legacy.as_bool() == Some(true)
            || legacy.as_i64() == Some(1)
            || matches!(
                legacy
                    .as_str()
                    .map(|text| text.trim().to_ascii_lowercase())
                    .as_deref(),
                Some("1") | Some("true")
            );
        if enabled {
            return "openai_chat";
        }
    }
    if settings.is_none() {
        return "unknown";
    }
    "anthropic"
}

pub fn canonical_api_format(raw: &str) -> Option<&'static str> {
    match raw.trim() {
        "anthropic" => Some("anthropic"),
        "openai_chat" => Some("openai_chat"),
        "openai_responses" => Some("openai_responses"),
        _ => None,
    }
}

/// Claude Code 语义兼容性闸门。评估结果存在 `claude1-config.json`，不在数据库里。
///
/// `unknown:not_assessed` 是所有未评估渠道的默认值，此时 reason 返回 `None`——
/// 每行都重复这句默认值只会淹掉真正带信息的结论（仓库刚有一次提交专门修这个）。
fn resolve_compatibility(local: Option<&Map<String, Value>>) -> (&'static str, Option<String>) {
    let assessment = local
        .and_then(|entry| entry.get("claude_code_compatibility"))
        .and_then(|value| value.as_object());
    let Some(assessment) = assessment else {
        return ("unassessed", None);
    };
    let raw_status = assessment
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or("unknown");
    let raw_reason = assessment
        .get("reason_code")
        .and_then(|value| value.as_str())
        .filter(|reason| is_reason_code(reason))
        .unwrap_or("not_assessed");
    let status = match raw_status {
        "verified" => "compatible",
        "incompatible" => "incompatible",
        _ => "unassessed",
    };
    if status == "unassessed" && raw_reason == "not_assessed" {
        return ("unassessed", None);
    }
    (status, Some(reason_text(raw_reason)))
}

/// reason_code 的形状：`^[a-z0-9][a-z0-9_.-]{0,63}$`（同 CLI 的正则）。
fn is_reason_code(raw: &str) -> bool {
    let mut chars = raw.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    if raw.chars().count() > 64 {
        return false;
    }
    chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || matches!(ch, '_' | '.' | '-'))
}

/// 已知 reason_code 的中文说明；没收录的原样返回，绝不吞掉。
fn reason_text(code: &str) -> String {
    match code {
        "not_assessed" => "尚未评估".to_string(),
        "manual_fixture_passed" => "人工用例已通过".to_string(),
        "smoke_pending" => "冒烟验证还没跑完".to_string(),
        "no_tool_support" => "上游不支持工具调用".to_string(),
        "agent_state_failed" => "子代理状态用例失败".to_string(),
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// 写入：只碰 claude1-config.json
// ---------------------------------------------------------------------------

pub fn set_channel_hidden(id: &str, hidden: bool) -> Result<(), String> {
    mutate_provider(id, |entry| {
        entry.insert("hidden".into(), Value::Bool(hidden));
        Ok(())
    })
}

pub fn set_channel_alias(id: &str, alias: Option<&str>) -> Result<(), String> {
    let candidate = alias.map(str::trim).filter(|text| !text.is_empty());
    let Some(candidate) = candidate else {
        return mutate_provider(id, |entry| {
            entry.remove("alias");
            Ok(())
        });
    };
    if candidate.starts_with('-') {
        return Err("别名不能以「-」开头，否则会被当成 claude1 的命令参数".to_string());
    }
    let folded = candidate.to_lowercase();
    if RESERVED_ALIAS_WORDS.contains(&folded.as_str()) {
        return Err(format!(
            "「{candidate}」是 claude1 的保留命令，请换一个别名"
        ));
    }
    if let Some(owner) = alias_conflict(id, &folded)? {
        return Err(format!("别名「{candidate}」已经被 {owner} 占用"));
    }
    let candidate = candidate.to_string();
    mutate_provider(id, move |entry| {
        entry.insert("alias".into(), Value::String(candidate));
        Ok(())
    })
}

pub fn set_channel_override(
    id: &str,
    model: Option<&str>,
    effort: Option<&str>,
) -> Result<(), String> {
    let model = model.map(str::trim).filter(|text| !text.is_empty());
    if let Some(effort) = effort {
        if !EFFORT_LEVELS.contains(&effort) {
            return Err(format!(
                "effort 只能是 low、medium、high 或 xhigh，收到：{effort}"
            ));
        }
    }
    let model = model.map(str::to_string);
    let effort = effort.map(str::to_string);
    mutate_provider(id, move |entry| {
        match model {
            Some(model) => {
                entry.insert("model".into(), Value::String(model));
            }
            None => {
                entry.remove("model");
            }
        }
        match effort {
            Some(effort) => {
                entry.insert("effort".into(), Value::String(effort));
            }
            None => {
                entry.remove("effort");
            }
        }
        Ok(())
    })
}

/// 别名冲突检查：撞上别的渠道的名字或别名都算冲突（同 CLI 的 `_alias_conflict`）。
fn alias_conflict(current_id: &str, folded: &str) -> Result<Option<String>, String> {
    let rows = db::claude_provider_rows()?;
    let config = LocalConfig::load()?;
    for row in &rows {
        if row.id == current_id {
            continue;
        }
        if row.name.to_lowercase() == folded {
            return Ok(Some(row.name.clone()));
        }
    }
    if let Some(providers) = config.providers() {
        for (id, entry) in providers {
            if id == current_id {
                continue;
            }
            let Some(entry) = entry.as_object() else {
                continue;
            };
            let display = entry
                .get("name")
                .and_then(|value| value.as_str())
                .unwrap_or(id.as_str())
                .to_string();
            let terms = [
                entry.get("name").and_then(|value| value.as_str()),
                entry.get("alias").and_then(|value| value.as_str()),
            ];
            for term in terms.into_iter().flatten() {
                if term.trim().to_lowercase() == folded {
                    return Ok(Some(display));
                }
            }
        }
    }
    Ok(None)
}

/// 读全量 → 改一个 provider 条目 → 原子写回。未知键与其他渠道的设置全部保留。
fn mutate_provider<F>(id: &str, apply: F) -> Result<(), String>
where
    F: FnOnce(&mut Map<String, Value>) -> Result<(), String>,
{
    let rows = db::claude_provider_rows()?;
    let row = rows
        .iter()
        .find(|row| row.id == id)
        .ok_or_else(|| format!("CC Switch 里找不到渠道 id：{id}"))?;

    let mut config = LocalConfig::load()?;
    if config.existed && config.version() < REQUIRED_CONFIG_VERSION {
        return Err(format!(
            "{} 还是旧版（version {}），键是渠道名而不是稳定 id；请先运行一次 claude1 让它迁移到 version {}，桌面端不代做迁移",
            error::tilde(&config.path),
            config.version(),
            REQUIRED_CONFIG_VERSION
        ));
    }
    if !config.root.contains_key("version") {
        config
            .root
            .insert("version".into(), Value::from(REQUIRED_CONFIG_VERSION));
    }
    if !config
        .root
        .get("providers")
        .map(|value| value.is_object())
        .unwrap_or(false)
    {
        config
            .root
            .insert("providers".into(), Value::Object(Map::new()));
    }
    let providers = config
        .root
        .get_mut("providers")
        .and_then(|value| value.as_object_mut())
        .ok_or_else(|| format!("{} 的 providers 必须是对象", error::tilde(&config.path)))?;
    if !providers
        .get(id)
        .map(|value| value.is_object())
        .unwrap_or(false)
    {
        providers.insert(id.to_string(), Value::Object(Map::new()));
    }
    let entry = providers
        .get_mut(id)
        .and_then(|value| value.as_object_mut())
        .ok_or_else(|| format!("{} 里 {id} 的条目必须是对象", error::tilde(&config.path)))?;
    // claude1 依赖 name 与 hidden 这两个键始终存在（sync_config 的不变量）。
    entry.insert("name".into(), Value::String(row.name.clone()));
    if !entry.contains_key("hidden") {
        entry.insert("hidden".into(), Value::Bool(false));
    }
    apply(entry)?;

    let path = config.path.clone();
    paths::write_json_atomic(&path, &Value::Object(config.root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn object(raw: Value) -> Option<Map<String, Value>> {
        match raw {
            Value::Object(map) => Some(map),
            _ => None,
        }
    }

    #[test]
    fn api_format_precedence_matches_the_cli() {
        // meta.apiFormat 优先
        assert_eq!(
            resolve_api_format(
                &object(json!({ "api_format": "anthropic" })),
                &object(json!({ "apiFormat": "openai_chat" })),
                None
            ),
            "openai_chat"
        );
        // codex_oauth 永远是 responses
        assert_eq!(
            resolve_api_format(
                &object(json!({})),
                &object(json!({ "apiFormat": "anthropic" })),
                Some("codex_oauth")
            ),
            "openai_responses"
        );
        // legacy 开关
        assert_eq!(
            resolve_api_format(
                &object(json!({ "openrouter_compat_mode": "true" })),
                &None,
                None
            ),
            "openai_chat"
        );
        // 什么都没有就是原生 anthropic
        assert_eq!(
            resolve_api_format(&object(json!({})), &None, None),
            "anthropic"
        );
        // settings_config 解析不出来才是 unknown
        assert_eq!(resolve_api_format(&None, &None, None), "unknown");
    }

    #[test]
    fn unassessed_default_carries_no_reason() {
        let local = object(json!({})).unwrap();
        assert_eq!(resolve_compatibility(Some(&local)), ("unassessed", None));

        let local = object(json!({
            "claude_code_compatibility": { "status": "unknown", "reason_code": "not_assessed" }
        }))
        .unwrap();
        assert_eq!(resolve_compatibility(Some(&local)), ("unassessed", None));
    }

    #[test]
    fn incompatible_keeps_a_chinese_reason() {
        let local = object(json!({
            "claude_code_compatibility": { "status": "incompatible", "reason_code": "no_tool_support" }
        }))
        .unwrap();
        let (status, reason) = resolve_compatibility(Some(&local));
        assert_eq!(status, "incompatible");
        assert_eq!(reason.as_deref(), Some("上游不支持工具调用"));
    }

    #[test]
    fn unknown_reason_code_is_surfaced_verbatim() {
        let local = object(json!({
            "claude_code_compatibility": { "status": "verified", "reason_code": "brand.new-code_9" }
        }))
        .unwrap();
        let (status, reason) = resolve_compatibility(Some(&local));
        assert_eq!(status, "compatible");
        assert_eq!(reason.as_deref(), Some("brand.new-code_9"));
    }

    #[test]
    fn malformed_reason_code_falls_back_to_not_assessed() {
        let local = object(json!({
            "claude_code_compatibility": { "status": "incompatible", "reason_code": "UPPER CASE!" }
        }))
        .unwrap();
        let (status, reason) = resolve_compatibility(Some(&local));
        assert_eq!(status, "incompatible");
        assert_eq!(reason.as_deref(), Some("尚未评估"));
    }
}
