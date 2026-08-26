//! hub 配置的读取与槽位写入。
//!
//! 读：`claude-hubs.json` 注册表 + `claude-hub.json` / `hubs/<name>.json`。
//! 写：只改目标键，先读全量 JSON 再原子替换，未知键全部保留。
//!
//! 凭证：hub 配置里带着 `local_token`（真凭证）。构造返回值时先整棵树过
//! `redact::strip_sensitive`，只把 `local_token_env`（环境变量名，不是值）按
//! 环境变量的形状白名单放回来。写回时用的是未脱敏的原始 JSON，token 因此不会被写坏。

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::channels::{self, Channel, EFFORT_LEVELS, SLOT_ORDER};
use crate::error;
use crate::paths;
use crate::redact;

/// 默认 hub 的 id。
pub const DEFAULT_HUB_ID: &str = "claude-hub";

/// `local_token_env` 缺省值，同 claude-provider-once.py 的 DEFAULT_HUB_TOKEN_ENV。
const DEFAULT_TOKEN_ENV: &str = "CLAUDE_HUB_LOCAL_TOKEN";

/// 端口探测超时。只探回环，不发任何外部请求。
const PROBE_TIMEOUT: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubChannel {
    pub name: String,
    pub provider: String,
    pub resolved_channel_id: Option<String>,
    pub api_format: Option<&'static str>,
    pub models: Vec<String>,
    pub proxy: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RouteTarget {
    pub channel: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SlotBinding {
    pub channel: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubConfig {
    pub name: String,
    pub is_default: bool,
    pub version: i64,
    pub port: Option<i64>,
    pub local_token_env: Option<String>,
    pub default_channel: Option<String>,
    pub launch_slot: Option<String>,
    pub slots: BTreeMap<String, Option<SlotBinding>>,
    pub effort_by_slot: BTreeMap<String, String>,
    pub channels: Vec<HubChannel>,
    pub routes: BTreeMap<String, Vec<RouteTarget>>,
    pub running: bool,
    pub config_path: String,
}

/// 注册表里一个 hub 的身份与文件位置。
#[derive(Debug, Clone)]
pub struct HubRef {
    pub id: String,
    pub display_name: String,
    pub is_default: bool,
    pub config_path: PathBuf,
    pub usage_path: PathBuf,
    pub lock_path: PathBuf,
}

/// 枚举全部 hub：默认 hub 加命名 hub。注册表缺失时只有默认 hub。
pub fn hub_refs() -> Result<Vec<HubRef>, String> {
    let dir = paths::cc_switch_dir()?;
    let catalog_path = paths::hub_catalog_path()?;
    let catalog = paths::read_json_object(&catalog_path)?;

    let default_id = catalog
        .as_ref()
        .and_then(|root| root.get("default_hub"))
        .and_then(|value| value.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_HUB_ID.to_string());

    let mut ordered: Vec<String> = Vec::new();
    if let Some(Value::Array(order)) = catalog.as_ref().and_then(|root| root.get("order")) {
        for item in order {
            if let Some(id) = item.as_str() {
                if !ordered.iter().any(|seen| seen == id) {
                    ordered.push(id.to_string());
                }
            }
        }
    }
    let entries = catalog
        .as_ref()
        .and_then(|root| root.get("hubs"))
        .and_then(|value| value.as_object());
    if let Some(entries) = entries {
        for id in entries.keys() {
            if !ordered.iter().any(|seen| seen == id) {
                ordered.push(id.clone());
            }
        }
    }
    if ordered.is_empty() {
        ordered.push(default_id.clone());
    }

    let mut refs: Vec<HubRef> = Vec::new();
    for id in ordered {
        let entry = entries
            .and_then(|entries| entries.get(&id))
            .and_then(|value| value.as_object());
        let is_default = id == default_id;
        let display_name = entry
            .and_then(|entry| entry.get("name"))
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| id.clone());
        let config_rel = entry
            .and_then(|entry| entry.get("config"))
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if is_default {
                    "claude-hub.json".to_string()
                } else {
                    format!("hubs/{id}.json")
                }
            });
        let usage_rel = entry
            .and_then(|entry| entry.get("usage"))
            .and_then(|value| value.as_str())
            .map(str::to_string)
            .unwrap_or_else(|| {
                if is_default {
                    "logs/claude-hub-usage.jsonl".to_string()
                } else {
                    format!("logs/hubs/{id}-usage.jsonl")
                }
            });
        let lock_path = if is_default {
            paths::default_hub_lock()?
        } else {
            paths::named_hub_lock(&id)?
        };
        refs.push(HubRef {
            id,
            display_name,
            is_default,
            config_path: resolve_relative(&dir, &config_rel),
            usage_path: resolve_relative(&dir, &usage_rel),
            lock_path,
        });
    }
    Ok(refs)
}

fn resolve_relative(base: &Path, raw: &str) -> PathBuf {
    let candidate = PathBuf::from(raw);
    if candidate.is_absolute() {
        candidate
    } else {
        base.join(candidate)
    }
}

/// 按 hub 名（id 或注册表里的显示名）找到它的身份。
pub fn resolve_hub(name: &str) -> Result<HubRef, String> {
    let refs = hub_refs()?;
    let needle = name.trim();
    if needle.is_empty() {
        return refs
            .into_iter()
            .find(|item| item.is_default)
            .ok_or_else(|| {
                "没有可用的 hub：~/.cc-switch 里既没有 claude-hub.json 也没有注册表".to_string()
            });
    }
    let folded = needle.to_lowercase();
    if let Some(found) = refs.iter().find(|item| item.id == needle) {
        return Ok(found.clone());
    }
    if let Some(found) = refs
        .iter()
        .find(|item| item.id.to_lowercase() == folded || item.display_name.to_lowercase() == folded)
    {
        return Ok(found.clone());
    }
    let known: Vec<&str> = refs.iter().map(|item| item.id.as_str()).collect();
    Err(format!(
        "找不到名为 {needle} 的 hub；本机已注册的是：{}",
        known.join("、")
    ))
}

/// 默认 hub 的用量流水路径。
pub fn default_usage_path() -> Result<PathBuf, String> {
    paths::default_usage_journal()
}

/// 按 hub 名给出用量流水路径；名字为空时用默认 hub。
pub fn usage_path_for(name: Option<&str>) -> Result<PathBuf, String> {
    match name.map(str::trim).filter(|name| !name.is_empty()) {
        Some(name) => Ok(resolve_hub(name)?.usage_path),
        None => default_usage_path(),
    }
}

/// 读全部 hub 配置。
///
/// 配置文件缺失或坏掉的 hub 会被跳过——一个坏掉的命名 hub 不该让整个槽位视图空掉。
/// 这些 hub 由 `run_doctor` 逐个报出来，所以不是把问题藏起来。
pub fn list_hubs() -> Result<Vec<HubConfig>, String> {
    // 渠道解析是增强信息：数据库读不到时 resolvedChannelId 为 null，界面显示「未解析」。
    let channel_list = channels::list_channels().unwrap_or_default();
    let mut out: Vec<HubConfig> = Vec::new();
    for hub in hub_refs()? {
        let Ok(Some(raw)) = paths::read_json_object(&hub.config_path) else {
            continue;
        };
        out.push(build_hub(&hub, &raw, &channel_list));
    }
    Ok(out)
}

/// 读一个 hub 配置的解析结果，供体检逐个报错用。
pub fn inspect_hub(hub: &HubRef) -> Result<Option<Map<String, Value>>, String> {
    paths::read_json_object(&hub.config_path)
}

fn build_hub(hub: &HubRef, raw: &Map<String, Value>, channel_list: &[Channel]) -> HubConfig {
    // 先整棵树剥凭证，后面所有字段都从这份安全副本里取。
    let safe = redact::strip_sensitive(&Value::Object(raw.clone()));
    let safe = safe.as_object().cloned().unwrap_or_default();

    let port = safe
        .get("port")
        .and_then(|value| value.as_i64())
        .filter(|port| (1..=65_535).contains(port));

    // 白名单例外：这个键存的是环境变量名，不是 token 值。用环境变量的形状卡一道。
    let local_token_env = raw
        .get("local_token_env")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|name| is_env_var_name(name))
        .map(str::to_string)
        .or_else(|| Some(DEFAULT_TOKEN_ENV.to_string()));

    let raw_channels = safe
        .get("channels")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let mut hub_channels: Vec<HubChannel> = Vec::new();
    for (alias, definition) in &raw_channels {
        let definition = definition.as_object().cloned().unwrap_or_default();
        let provider = definition
            .get("provider")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let resolved = resolve_provider_selector(&provider, channel_list);
        let declared_format = definition
            .get("api_format")
            .and_then(|value| value.as_str())
            .and_then(channels::canonical_api_format);
        let api_format = declared_format.or_else(|| {
            resolved
                .as_ref()
                .and_then(|id| channel_list.iter().find(|channel| &channel.id == id))
                .map(|channel| channel.api_format)
        });
        let models = definition
            .get("models")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str())
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<String>>()
            })
            .unwrap_or_default();
        hub_channels.push(HubChannel {
            name: alias.clone(),
            provider,
            resolved_channel_id: resolved,
            api_format,
            models,
            proxy: definition
                .get("proxy")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .filter(|proxy| !proxy.is_empty())
                .map(str::to_string),
        });
    }

    let raw_slots = safe
        .get("model_slots")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let mut slots: BTreeMap<String, Option<SlotBinding>> = BTreeMap::new();
    for slot in SLOT_ORDER {
        let binding = raw_slots
            .get(slot)
            .and_then(|value| value.as_str())
            .and_then(parse_slot_selector);
        slots.insert(slot.to_string(), binding);
    }

    let raw_efforts = safe
        .get("effort_by_slot")
        .and_then(|value| value.as_object())
        .cloned()
        .unwrap_or_default();
    let mut effort_by_slot: BTreeMap<String, String> = BTreeMap::new();
    for slot in SLOT_ORDER {
        if let Some(effort) = raw_efforts
            .get(slot)
            .and_then(|value| value.as_str())
            .filter(|effort| EFFORT_LEVELS.contains(effort))
        {
            effort_by_slot.insert(slot.to_string(), effort.to_string());
        }
    }

    HubConfig {
        name: hub.id.clone(),
        is_default: hub.is_default,
        version: safe
            .get("version")
            .and_then(|value| value.as_i64())
            .unwrap_or(1),
        port,
        local_token_env,
        default_channel: safe
            .get("default_channel")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string),
        launch_slot: safe
            .get("launch_slot")
            .and_then(|value| value.as_str())
            .map(|slot| slot.trim().to_lowercase())
            .filter(|slot| SLOT_ORDER.contains(&slot.as_str())),
        slots,
        effort_by_slot,
        channels: hub_channels,
        routes: parse_routes(safe.get("routes")),
        running: is_running(&hub.lock_path, port),
        config_path: hub.config_path.to_string_lossy().into_owned(),
    }
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

/// `"<渠道>,<模型>"` → 结构。任一半为空就当未绑定。
pub fn parse_slot_selector(raw: &str) -> Option<SlotBinding> {
    let (channel, model) = raw.split_once(',')?;
    let channel = channel.trim();
    let model = model.trim();
    if channel.is_empty() || model.is_empty() {
        return None;
    }
    Some(SlotBinding {
        channel: channel.to_lowercase(),
        model: model.to_string(),
    })
}

/// hub 渠道的 `provider` 选择器 → CC Switch 渠道 id。
///
/// 支持 `id:<provider-id>` 与 provider 名（大小写不敏感），解析不到就是 `None`。
fn resolve_provider_selector(selector: &str, channel_list: &[Channel]) -> Option<String> {
    let selector = selector.trim();
    if selector.is_empty() {
        return None;
    }
    if let Some(id) = selector.strip_prefix("id:") {
        let id = id.trim();
        return channel_list
            .iter()
            .find(|channel| channel.id == id)
            .map(|channel| channel.id.clone());
    }
    let folded = selector.to_lowercase();
    channel_list
        .iter()
        .find(|channel| {
            channel.name.to_lowercase() == folded
                || channel
                    .alias
                    .as_deref()
                    .map(|alias| alias.to_lowercase() == folded)
                    .unwrap_or(false)
        })
        .map(|channel| channel.id.clone())
}

/// `routes` 目前不在实际配置里出现，按前向兼容读：既接受对象数组，也接受
/// `"<渠道>,<模型>"` 字符串数组。
fn parse_routes(raw: Option<&Value>) -> BTreeMap<String, Vec<RouteTarget>> {
    let mut out: BTreeMap<String, Vec<RouteTarget>> = BTreeMap::new();
    let Some(Value::Object(routes)) = raw else {
        return out;
    };
    for (key, value) in routes {
        let Value::Array(items) = value else { continue };
        let mut targets: Vec<RouteTarget> = Vec::new();
        for item in items {
            match item {
                Value::String(selector) => {
                    if let Some(binding) = parse_slot_selector(selector) {
                        targets.push(RouteTarget {
                            channel: binding.channel,
                            model: binding.model,
                        });
                    }
                }
                Value::Object(fields) => {
                    let channel = fields
                        .get("channel")
                        .and_then(|value| value.as_str())
                        .map(str::trim)
                        .unwrap_or("");
                    let model = fields
                        .get("model")
                        .and_then(|value| value.as_str())
                        .map(str::trim)
                        .unwrap_or("");
                    if !channel.is_empty() && !model.is_empty() {
                        targets.push(RouteTarget {
                            channel: channel.to_lowercase(),
                            model: model.to_string(),
                        });
                    }
                }
                _ => {}
            }
        }
        if !targets.is_empty() {
            out.insert(key.clone(), targets);
        }
    }
    out
}

/// 是否有活着的进程：锁文件存在（说明启动过）且回环端口能连上。
///
/// 只连 127.0.0.1，绝不发任何外部请求，也不带 token 做健康检查。
fn is_running(lock_path: &Path, port: Option<i64>) -> bool {
    if !lock_path.exists() {
        return false;
    }
    let Some(port) = port else { return false };
    let Ok(port) = u16::try_from(port) else {
        return false;
    };
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    TcpStream::connect_timeout(&address, PROBE_TIMEOUT).is_ok()
}

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

pub fn set_hub_slot(
    hub_name: &str,
    slot: &str,
    channel: Option<&str>,
    model: Option<&str>,
) -> Result<(), String> {
    let slot = normalize_slot(slot)?;
    let hub = resolve_hub(hub_name)?;
    let mut raw = read_hub_raw(&hub)?;

    let channel = channel.map(str::trim).filter(|text| !text.is_empty());
    let model = model.map(str::trim).filter(|text| !text.is_empty());

    let selector = match (channel, model) {
        (None, None) => None,
        (Some(_), None) | (None, Some(_)) => {
            return Err(format!(
                "槽位 {slot} 必须同时给出渠道与模型，或者两个都留空表示清除绑定"
            ))
        }
        (Some(channel), Some(model)) => {
            let alias = resolve_hub_channel_alias(&raw, channel)?;
            let declared = hub_channel_models(&raw, &alias);
            if !declared.iter().any(|item| item == model) {
                return Err(format!(
                    "hub 渠道 {alias} 没有声明模型 {model}；它当前声明的是：{}。请先在 claude1 里给该渠道加上这个模型",
                    if declared.is_empty() {
                        "（一个都没有）".to_string()
                    } else {
                        declared.join("、")
                    }
                ));
            }
            Some(format!("{alias},{model}"))
        }
    };

    let slots = ensure_object(&mut raw, "model_slots")?;
    match selector {
        Some(selector) => {
            slots.insert(slot.clone(), Value::String(selector));
        }
        None => {
            slots.remove(&slot);
        }
    }
    write_hub_raw(&hub, raw)
}

pub fn set_hub_slot_effort(hub_name: &str, slot: &str, effort: Option<&str>) -> Result<(), String> {
    let slot = normalize_slot(slot)?;
    if let Some(effort) = effort {
        if !EFFORT_LEVELS.contains(&effort) {
            return Err(format!(
                "effort 只能是 low、medium、high 或 xhigh，收到：{effort}"
            ));
        }
    }
    let hub = resolve_hub(hub_name)?;
    let mut raw = read_hub_raw(&hub)?;
    let efforts = ensure_object(&mut raw, "effort_by_slot")?;
    match effort {
        Some(effort) => {
            efforts.insert(slot.clone(), Value::String(effort.to_string()));
        }
        None => {
            efforts.remove(&slot);
        }
    }
    write_hub_raw(&hub, raw)
}

fn normalize_slot(slot: &str) -> Result<String, String> {
    let folded = slot.trim().to_lowercase();
    if !SLOT_ORDER.contains(&folded.as_str()) {
        return Err(format!(
            "槽位只能是 fable、opus、sonnet 或 haiku，收到：{slot}"
        ));
    }
    Ok(folded)
}

/// 读未脱敏的原始配置。只用于「读全量 → 改键 → 写回」，不进任何返回值。
fn read_hub_raw(hub: &HubRef) -> Result<Map<String, Value>, String> {
    paths::read_json_object(&hub.config_path)?.ok_or_else(|| {
        format!(
            "hub {} 的配置不存在：{}",
            hub.id,
            error::tilde(&hub.config_path)
        )
    })
}

fn write_hub_raw(hub: &HubRef, raw: Map<String, Value>) -> Result<(), String> {
    paths::write_json_atomic(&hub.config_path, &Value::Object(raw))
}

fn ensure_object<'a>(
    raw: &'a mut Map<String, Value>,
    key: &str,
) -> Result<&'a mut Map<String, Value>, String> {
    if !raw.get(key).map(|value| value.is_object()).unwrap_or(false) {
        raw.insert(key.to_string(), Value::Object(Map::new()));
    }
    raw.get_mut(key)
        .and_then(|value| value.as_object_mut())
        .ok_or_else(|| format!("hub 配置的 {key} 必须是对象"))
}

/// 把界面传来的渠道标识对到 hub 渠道别名。
///
/// 依次尝试：别名本身、`provider` 选择器全等、`id:<x>` 的裸 id。都对不上就报错并
/// 列出可用别名——比静默写一个 claude1 读不懂的选择器诚实得多。
fn resolve_hub_channel_alias(raw: &Map<String, Value>, wanted: &str) -> Result<String, String> {
    let channels_map = raw
        .get("channels")
        .and_then(|value| value.as_object())
        .ok_or_else(|| "hub 配置缺少 channels，无法绑定槽位".to_string())?;
    let folded = wanted.trim().to_lowercase();
    if channels_map.contains_key(&folded) {
        return Ok(folded);
    }
    let mut matches: Vec<String> = Vec::new();
    for (alias, definition) in channels_map {
        let Some(provider) = definition
            .as_object()
            .and_then(|definition| definition.get("provider"))
            .and_then(|value| value.as_str())
        else {
            continue;
        };
        let provider = provider.trim();
        let bare = provider.strip_prefix("id:").unwrap_or(provider);
        if provider.eq_ignore_ascii_case(wanted.trim()) || bare.eq_ignore_ascii_case(wanted.trim())
        {
            matches.push(alias.clone());
        }
    }
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => {
            let known: Vec<&str> = channels_map.keys().map(String::as_str).collect();
            Err(format!(
                "hub 里没有叫 {wanted} 的渠道；可用的渠道别名是：{}",
                known.join("、")
            ))
        }
        _ => Err(format!(
            "{wanted} 同时对应 hub 渠道 {}，请直接用渠道别名指定",
            matches.join("、")
        )),
    }
}

fn hub_channel_models(raw: &Map<String, Value>, alias: &str) -> Vec<String> {
    raw.get("channels")
        .and_then(|value| value.as_object())
        .and_then(|channels_map| channels_map.get(alias))
        .and_then(|definition| definition.as_object())
        .and_then(|definition| definition.get("models"))
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|model| !model.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample() -> Map<String, Value> {
        match json!({
            "version": 2,
            "port": 18787,
            "local_token": "hub-local-fake",
            "local_token_env": "CLAUDE_HUB_LOCAL_TOKEN",
            "default_channel": "deepseek",
            "channels": {
                "grok": { "provider": "id:98bc43b6", "api_format": "openai_chat", "models": ["grok-4.5"] },
                "deepseek": { "provider": "deepseek", "models": ["deepseek-v4-flash-0731"] }
            },
            "model_slots": { "opus": "grok,grok-4.5", "haiku": "" },
            "launch_slot": "fable",
            "effort_by_slot": { "opus": "high", "sonnet": "nonsense" },
            "未来新键": { "keep": true }
        }) {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    fn hub_ref() -> HubRef {
        HubRef {
            id: "claude-hub".into(),
            display_name: "Claude-Hub".into(),
            is_default: true,
            config_path: PathBuf::from("/tmp/claude1-desktop-test/claude-hub.json"),
            usage_path: PathBuf::from("/tmp/claude1-desktop-test/usage.jsonl"),
            lock_path: PathBuf::from("/tmp/claude1-desktop-test/claude-hub.lock"),
        }
    }

    #[test]
    fn local_token_never_reaches_the_response() {
        let built = build_hub(&hub_ref(), &sample(), &[]);
        let dumped = serde_json::to_string(&built).unwrap();
        assert!(!dumped.contains("hub-local"));
        assert!(!dumped.contains("hub-local-fake"));
        assert_eq!(
            built.local_token_env.as_deref(),
            Some("CLAUDE_HUB_LOCAL_TOKEN")
        );
    }

    #[test]
    fn slots_and_efforts_drop_bad_values() {
        let built = build_hub(&hub_ref(), &sample(), &[]);
        assert_eq!(built.slots["opus"].as_ref().unwrap().channel, "grok");
        assert_eq!(built.slots["opus"].as_ref().unwrap().model, "grok-4.5");
        // 空选择器与缺失的槽位都是未绑定
        assert!(built.slots["haiku"].is_none());
        assert!(built.slots["fable"].is_none());
        assert_eq!(
            built.effort_by_slot.get("opus").map(String::as_str),
            Some("high")
        );
        assert!(!built.effort_by_slot.contains_key("sonnet"));
        assert_eq!(built.port, Some(18787));
        assert_eq!(built.version, 2);
    }

    #[test]
    fn hub_channel_format_prefers_the_declared_one() {
        let built = build_hub(&hub_ref(), &sample(), &[]);
        let grok = built.channels.iter().find(|c| c.name == "grok").unwrap();
        assert_eq!(grok.api_format, Some("openai_chat"));
        assert_eq!(grok.resolved_channel_id, None);
        let deepseek = built
            .channels
            .iter()
            .find(|c| c.name == "deepseek")
            .unwrap();
        assert_eq!(deepseek.models, vec!["deepseek-v4-flash-0731".to_string()]);
        assert_eq!(deepseek.api_format, None);
    }

    #[test]
    fn slot_selector_parsing() {
        let binding = parse_slot_selector("Grok,grok-4.5").unwrap();
        assert_eq!(binding.channel, "grok");
        assert_eq!(binding.model, "grok-4.5");
        assert!(parse_slot_selector("grok").is_none());
        assert!(parse_slot_selector("grok,").is_none());
        assert!(parse_slot_selector(",m").is_none());
    }

    #[test]
    fn alias_resolution_accepts_id_selector_and_alias() {
        let raw = sample();
        assert_eq!(resolve_hub_channel_alias(&raw, "GROK").unwrap(), "grok");
        assert_eq!(
            resolve_hub_channel_alias(&raw, "id:98bc43b6").unwrap(),
            "grok"
        );
        assert_eq!(resolve_hub_channel_alias(&raw, "98bc43b6").unwrap(), "grok");
        let err = resolve_hub_channel_alias(&raw, "nope").unwrap_err();
        assert!(err.contains("可用的渠道别名"), "{err}");
    }

    #[test]
    fn env_var_name_shape_guard() {
        assert!(is_env_var_name("CLAUDE_HUB_LOCAL_TOKEN"));
        assert!(is_env_var_name("_x1"));
        assert!(!is_env_var_name("1abc"));
        assert!(!is_env_var_name("has space"));
        assert!(!is_env_var_name(""));
    }

    #[test]
    fn routes_accept_both_shapes() {
        let raw = json!({
            "bare": ["grok,grok-4.5"],
            "structured": [{ "channel": "GLM", "model": "glm-5.2" }],
            "junk": [1, 2]
        });
        let routes = parse_routes(Some(&raw));
        assert_eq!(routes["bare"][0].channel, "grok");
        assert_eq!(routes["structured"][0].channel, "glm");
        assert!(!routes.contains_key("junk"));
    }
}
