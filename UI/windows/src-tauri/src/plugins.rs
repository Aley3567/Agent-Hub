//! 插件（Claude Code 配置扩展点）的聚合读取与启用开关。
//!
//! 聚合三个来源（CONTRACT.md §3 list_plugins）：
//! - 全局：`~/.claude/settings.json` 的 hooks / outputStyle / statusLine / permissions，
//!   以及 `~/.claude.json` 的 mcpServers。**只读探测，读不到就跳过**，绝不写这两个文件。
//! - 渠道级：各渠道 settings_config 里的同名扩展点。存在 CC Switch 数据库里，
//!   一律 `scope: 'channel'` 只读展示。
//! - 启用状态：只落 `claude1-config.json` 的本地覆盖（`plugins.<id>.enabled`），
//!   这是桌面端唯一允许写的文件。
//!
//! `detail` 字段一律先 `redact::strip_sensitive` 再 `redact::redact_text`，fail-closed。

use serde::Serialize;
use serde_json::{Map, Value};

use crate::channels::{LocalConfig, REQUIRED_CONFIG_VERSION};
use crate::db;
use crate::error;
use crate::paths;
use crate::redact;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginItem {
    pub id: String,
    /// 'hook' | 'outputStyle' | 'statusLine' | 'permissions' | 'mcp'
    pub kind: String,
    pub name: String,
    /// 'global' = 全局配置；'channel' = 渠道级（来自 settings_config，只读）
    pub scope: String,
    /// scope 为 'channel' 时是 Channel.id，否则为 None
    pub channel_id: Option<String>,
    pub enabled: bool,
    /// 一行人话说明这是什么
    pub summary: String,
    /// 展开的原始配置摘要（已剥离凭证），无则 None
    pub detail: Option<String>,
}

// ---------------------------------------------------------------------------
// 读取与聚合
// ---------------------------------------------------------------------------

pub fn list_plugins() -> Result<Vec<PluginItem>, String> {
    let mut items = global_items();
    items.extend(channel_items()?);
    // 全局两个来源可能登记同一个 MCP server（settings.json 的 mcpServers/mcp 与
    // ~/.claude.json 的 mcpServers），id 都是 `global:mcp:{name}`——不去重的话前端
    // 拿到重复 React key，一次开关翻转两行。settings.json 先入列，故保留它那份。
    let mut seen = std::collections::HashSet::new();
    items.retain(|item| seen.insert(item.id.clone()));
    apply_enabled_overrides(&mut items)?;
    Ok(items)
}

/// 只读探测一个 JSON 文件：不存在、读不了、解析失败都返回 None（跳过这个来源）。
fn probe_json_object(path: &std::path::Path) -> Option<Map<String, Value>> {
    paths::read_json_object(path).ok().flatten()
}

/// 全局来源：`~/.claude/settings.json` 与 `~/.claude.json`。
fn global_items() -> Vec<PluginItem> {
    let mut out = Vec::new();
    let Ok(home) = paths::home_dir() else {
        return out;
    };
    if let Some(settings) = probe_json_object(&home.join(".claude").join("settings.json")) {
        collect_extension_points(&settings, "global", None, &mut out);
    }
    // MCP 服务器登记在 ~/.claude.json 的 mcpServers
    if let Some(claude_json) = probe_json_object(&home.join(".claude.json")) {
        if let Some(servers) = claude_json.get("mcpServers").and_then(Value::as_object) {
            for (name, config) in servers {
                out.push(PluginItem {
                    id: format!("global:mcp:{name}"),
                    kind: "mcp".to_string(),
                    name: name.clone(),
                    scope: "global".to_string(),
                    channel_id: None,
                    enabled: true,
                    summary: format!("全局 MCP 服务器「{name}」"),
                    detail: detail_of(config),
                });
            }
        }
    }
    out
}

/// 渠道级来源：CC Switch 数据库里每个渠道 settings_config 的扩展点，只读。
fn channel_items() -> Result<Vec<PluginItem>, String> {
    let mut out = Vec::new();
    for row in db::claude_provider_rows()? {
        let Some(settings) = parse_settings(row.settings_config.as_deref()) else {
            continue;
        };
        collect_extension_points(&settings, "channel", Some(&row), &mut out);
    }
    Ok(out)
}

fn parse_settings(raw: Option<&str>) -> Option<Map<String, Value>> {
    let text = raw?.trim();
    if text.is_empty() {
        return None;
    }
    match serde_json::from_str::<Value>(text) {
        Ok(Value::Object(map)) => Some(map),
        _ => None,
    }
}

/// 四个同名扩展点（hooks / outputStyle / statusLine / permissions）的收集，
/// 全局与渠道级共用。mcp 的渠道级键是 `mcpServers`（兼容写成 `mcp` 的）。
fn collect_extension_points(
    settings: &Map<String, Value>,
    scope: &str,
    row: Option<&db::ProviderRow>,
    out: &mut Vec<PluginItem>,
) {
    let (prefix, channel_id, where_from) = match row {
        Some(row) => (
            format!("channel:{}", row.id),
            Some(row.id.clone()),
            format!("渠道「{}」", row.name),
        ),
        None => ("global".to_string(), None, "全局".to_string()),
    };
    let push = |out: &mut Vec<PluginItem>, kind: &str, key: &str, name: String, summary: String, detail: Option<String>| {
        out.push(PluginItem {
            id: format!("{prefix}:{kind}:{key}"),
            kind: kind.to_string(),
            name,
            scope: scope.to_string(),
            channel_id: channel_id.clone(),
            enabled: true,
            summary,
            detail,
        });
    };

    if let Some(hooks) = settings.get("hooks").and_then(Value::as_object) {
        for (event, rules) in hooks {
            let count = rules.as_array().map(Vec::len).unwrap_or(1);
            push(
                out,
                "hook",
                event,
                event.clone(),
                format!("{where_from}的 {event} 钩子，{count} 条规则"),
                detail_of(rules),
            );
        }
    }
    if let Some(style) = settings.get("outputStyle") {
        let name = style
            .as_str()
            .map(str::to_string)
            .or_else(|| {
                style
                    .as_object()
                    .and_then(|obj| obj.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| "outputStyle".to_string());
        push(
            out,
            "outputStyle",
            "outputStyle",
            name.clone(),
            format!("{where_from}的输出风格：{name}"),
            detail_of(style),
        );
    }
    if let Some(status_line) = settings.get("statusLine") {
        push(
            out,
            "statusLine",
            "statusLine",
            "statusLine".to_string(),
            format!("{where_from}的状态栏命令"),
            detail_of(status_line),
        );
    }
    if let Some(permissions) = settings.get("permissions") {
        push(
            out,
            "permissions",
            "permissions",
            "permissions".to_string(),
            format!("{where_from}的权限规则（allow / deny / ask）"),
            detail_of(permissions),
        );
    }
    let mcp_servers = settings
        .get("mcpServers")
        .or_else(|| settings.get("mcp"))
        .and_then(Value::as_object);
    if let Some(servers) = mcp_servers {
        for (name, config) in servers {
            push(
                out,
                "mcp",
                name,
                name.clone(),
                format!("{where_from}的 MCP 服务器「{name}」"),
                detail_of(config),
            );
        }
    }
}

/// detail 的最后一道闸门：先按键名剥离凭证字段，序列化后再过一遍长串清洗。
fn detail_of(value: &Value) -> Option<String> {
    let safe = redact::strip_sensitive(value);
    if safe.is_null() {
        return None;
    }
    let text = match serde_json::to_string_pretty(&safe) {
        Ok(text) => text,
        // 序列化失败宁可没有 detail，也不能把未剥离的原文放出去
        Err(_) => return None,
    };
    Some(redact::redact_text(&text))
}

/// 启用状态来自 `claude1-config.json` 的 `plugins.<id>.enabled`，默认 true。
/// 只对 global 作用域生效；channel 作用域恒为 true（只读展示，它的「开关」在 CC Switch 里）。
fn apply_enabled_overrides(items: &mut [PluginItem]) -> Result<(), String> {
    let config = LocalConfig::load()?;
    let Some(plugins) = config.root.get("plugins").and_then(Value::as_object) else {
        return Ok(());
    };
    for item in items.iter_mut() {
        if item.scope != "global" {
            continue;
        }
        if let Some(enabled) = plugins
            .get(&item.id)
            .and_then(|entry| entry.get("enabled"))
            .and_then(Value::as_bool)
        {
            item.enabled = enabled;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 写入：只碰 claude1-config.json 的 plugins 表
// ---------------------------------------------------------------------------

pub fn set_plugin_enabled(id: &str, enabled: bool) -> Result<(), String> {
    let items = list_plugins()?;
    let item = items
        .iter()
        .find(|item| item.id == id)
        .ok_or_else(|| format!("找不到插件项：{id}"))?;
    if item.scope == "channel" {
        return Err(format!(
            "「{}」是渠道级扩展点，来自 settings_config、存在 CC Switch 数据库里，桌面端只读不改；要调整请在 CC Switch 里编辑对应渠道",
            item.name
        ));
    }

    let mut config = LocalConfig::load()?;
    if config.existed && config.version() < REQUIRED_CONFIG_VERSION {
        return Err(format!(
            "{} 还是旧版（version {}），请先运行一次 claude1 让它迁移到 version {}，桌面端不代做迁移",
            error::tilde(&config.path),
            config.version(),
            REQUIRED_CONFIG_VERSION
        ));
    }
    if !config
        .root
        .get("plugins")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        config
            .root
            .insert("plugins".into(), Value::Object(Map::new()));
    }
    let plugins = config
        .root
        .get_mut("plugins")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("{} 的 plugins 必须是对象", error::tilde(&config.path)))?;
    if !plugins.get(id).map(Value::is_object).unwrap_or(false) {
        plugins.insert(id.to_string(), Value::Object(Map::new()));
    }
    let entry = plugins
        .get_mut(id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("{} 里 {id} 的条目必须是对象", error::tilde(&config.path)))?;
    entry.insert("enabled".into(), Value::Bool(enabled));

    let path = config.path.clone();
    paths::write_json_atomic(&path, &Value::Object(config.root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn detail_strips_credentials_fail_closed() {
        // 高熵 key 字面量不入库：现场拼假 key，形态足以命中掩码
        let fake_key = format!("sk-ant-{}", "z".repeat(30));
        let raw = json!({
            "command": "echo ok",
            "env": { "API_KEY": fake_key, "NOTE": "普通说明" },
            "free_text": format!("参考 {}", "t".repeat(28))
        });
        let detail = detail_of(&raw).unwrap();
        assert!(!detail.contains(&"z".repeat(30)));
        assert!(!detail.contains(&"t".repeat(28)));
        assert!(detail.contains("\"API_KEY\": true"));
        assert!(detail.contains("普通说明"));
    }

    #[test]
    fn detail_of_null_is_none() {
        assert_eq!(detail_of(&Value::Null), None);
    }

    #[test]
    fn collects_all_five_kinds_from_settings() {
        let settings = json!({
            "hooks": { "PreToolUse": [ { "matcher": "Bash" } ] },
            "outputStyle": "简洁",
            "statusLine": { "type": "command", "command": "st" },
            "permissions": { "allow": ["Bash(ls:*)"] },
            "mcpServers": { "docs": { "command": "docs-server" } }
        });
        let mut out = Vec::new();
        let settings = settings.as_object().unwrap().clone();
        collect_extension_points(&settings, "global", None, &mut out);
        let kinds: Vec<&str> = out.iter().map(|item| item.kind.as_str()).collect();
        for kind in ["hook", "outputStyle", "statusLine", "permissions", "mcp"] {
            assert!(kinds.contains(&kind), "缺 {kind}：{kinds:?}");
        }
        assert!(out.iter().all(|item| item.scope == "global"));
        assert!(out.iter().any(|item| item.id == "global:hook:PreToolUse"));
        assert!(out.iter().any(|item| item.id == "global:mcp:docs"));
    }
}
