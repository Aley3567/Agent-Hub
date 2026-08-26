//! 账号池，首版只读（README.md 状态段已写死）。
//!
//! 池文件只存 `id:` 选择器与调度规则，凭证仍然留在 CC Switch 里，所以这里没有任何
//! 需要脱敏的值；成员的最近使用与回合数从用量流水的 `account` 字段统计。

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::Value;

use crate::channels::{self, Channel};
use crate::hubs;
use crate::journal;
use crate::paths;

/// 池文件缺省的冷却参数，同 claude1_account_pool.py。
const DEFAULT_COOLDOWN_SECONDS: i64 = 60;
const DEFAULT_MAX_COOLDOWN_SECONDS: i64 = 3_600;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountMember {
    pub provider_ref: String,
    pub resolved_channel_id: Option<String>,
    pub display_name: String,
    pub weight: i64,
    pub priority: i64,
    pub enabled: bool,
    pub last_used_at: Option<i64>,
    pub turns: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountPool {
    pub provider_ref: String,
    pub resolved_channel_id: Option<String>,
    pub strategy: String,
    pub cooldown_seconds: Option<i64>,
    pub max_cooldown_seconds: Option<i64>,
    pub members: Vec<AccountMember>,
}

/// 从用量流水统计出的每个 account 的活动情况。
#[derive(Debug, Clone, Copy, Default)]
struct AccountActivity {
    last_used_at: i64,
    turns: i64,
}

/// 读全部账号池。池文件缺失返回空数组，不报错（CONTRACT.md 3 节）。
pub fn list_account_pools() -> Result<Vec<AccountPool>, String> {
    let path = paths::account_pool_path()?;
    let Some(root) = paths::read_json_object(&path)? else {
        return Ok(Vec::new());
    };
    let Some(providers) = root.get("providers").and_then(|value| value.as_object()) else {
        return Ok(Vec::new());
    };
    // 渠道名解析是增强信息，数据库读不到也要把池结构显示出来。
    let channel_list = channels::list_channels().unwrap_or_default();
    let activity = account_activity();

    let mut out: Vec<AccountPool> = Vec::new();
    for (primary, definition) in providers {
        let definition = definition.as_object().cloned().unwrap_or_default();
        let strategy = definition
            .get("strategy")
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|strategy| !strategy.is_empty())
            .unwrap_or("round_robin")
            .to_string();
        let mut members: Vec<AccountMember> = Vec::new();
        if let Some(raw_members) = definition.get("members").and_then(|value| value.as_array()) {
            for (index, raw) in raw_members.iter().enumerate() {
                if let Some(member) = build_member(raw, index, &channel_list, &activity) {
                    members.push(member);
                }
            }
        }
        out.push(AccountPool {
            resolved_channel_id: resolve_selector(primary, &channel_list),
            provider_ref: primary.clone(),
            strategy,
            cooldown_seconds: Some(
                definition
                    .get("cooldown_seconds")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(DEFAULT_COOLDOWN_SECONDS),
            ),
            max_cooldown_seconds: Some(
                definition
                    .get("max_cooldown_seconds")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(DEFAULT_MAX_COOLDOWN_SECONDS),
            ),
            members,
        });
    }
    out.sort_by(|left, right| left.provider_ref.cmp(&right.provider_ref));
    Ok(out)
}

fn build_member(
    raw: &Value,
    index: usize,
    channel_list: &[Channel],
    activity: &BTreeMap<String, AccountActivity>,
) -> Option<AccountMember> {
    let (selector, weight, priority, enabled) = match raw {
        Value::String(selector) => (selector.trim().to_string(), 1, 0, true),
        Value::Object(fields) => {
            let selector = fields
                .get("provider")
                .and_then(|value| value.as_str())
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            (
                selector,
                fields
                    .get("weight")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(1),
                fields
                    .get("priority")
                    .and_then(|value| value.as_i64())
                    .unwrap_or(0),
                fields
                    .get("enabled")
                    .and_then(|value| value.as_bool())
                    .unwrap_or(true),
            )
        }
        _ => return None,
    };
    if selector.is_empty() {
        return None;
    }
    let resolved = resolve_selector(&selector, channel_list);
    let display_name = resolved
        .as_ref()
        .and_then(|id| channel_list.iter().find(|channel| &channel.id == id))
        .map(|channel| channel.name.clone())
        .unwrap_or_else(|| format!("成员 {}（{}）", index + 1, selector));
    let stats = activity.get(&selector).copied().unwrap_or_default();
    Some(AccountMember {
        provider_ref: selector,
        resolved_channel_id: resolved,
        display_name,
        weight,
        priority,
        enabled,
        last_used_at: if stats.turns > 0 {
            Some(stats.last_used_at)
        } else {
            None
        },
        turns: stats.turns,
    })
}

fn resolve_selector(selector: &str, channel_list: &[Channel]) -> Option<String> {
    let selector = selector.trim();
    let bare = selector.strip_prefix("id:").unwrap_or(selector);
    channel_list
        .iter()
        .find(|channel| channel.id == bare)
        .map(|channel| channel.id.clone())
}

/// 扫描全部 hub 的用量流水，按 `account` 字段统计最近使用与回合数。
///
/// 账号是 provider 级的概念，跟哪个 hub 记的账无关，所以这里把所有 hub 都扫一遍。
fn account_activity() -> BTreeMap<String, AccountActivity> {
    let mut out: BTreeMap<String, AccountActivity> = BTreeMap::new();
    let mut journals: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(refs) = hubs::hub_refs() {
        for hub in refs {
            journals.extend(journal::journal_files(&hub.usage_path));
        }
    }
    if journals.is_empty() {
        if let Ok(primary) = paths::default_usage_journal() {
            journals.extend(journal::journal_files(&primary));
        }
    }
    let Ok((rows, _report)) = journal::scan_usage(&journals) else {
        return out;
    };
    for row in rows {
        let Some(account) = row.account else { continue };
        let entry = out.entry(account).or_default();
        entry.turns += 1;
        if row.ts > entry.last_used_at {
            entry.last_used_at = row.ts;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn member_accepts_string_and_object_shapes() {
        let activity = BTreeMap::new();
        let bare = build_member(&json!("id:abc"), 0, &[], &activity).unwrap();
        assert_eq!(bare.provider_ref, "id:abc");
        assert_eq!(bare.weight, 1);
        assert_eq!(bare.priority, 0);
        assert!(bare.enabled);
        assert_eq!(bare.turns, 0);
        assert!(bare.last_used_at.is_none());

        let full = build_member(
            &json!({ "provider": "id:def", "weight": 5, "priority": 2, "enabled": false }),
            1,
            &[],
            &activity,
        )
        .unwrap();
        assert_eq!(full.weight, 5);
        assert_eq!(full.priority, 2);
        assert!(!full.enabled);
        assert!(full.display_name.contains("id:def"));

        assert!(build_member(&json!(42), 0, &[], &activity).is_none());
        assert!(build_member(&json!({ "weight": 1 }), 0, &[], &activity).is_none());
    }
}
