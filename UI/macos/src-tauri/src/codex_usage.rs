//! Reads counters only from Codex session journals; never returns conversation content.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::{
    collections::HashSet,
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
};
#[derive(Clone)]
struct Cached {
    size: u64,
    modified: Option<std::time::SystemTime>,
    rows: Vec<(String, UsageRow)>,
}
static CACHE: OnceLock<Mutex<BTreeMap<PathBuf, Cached>>> = OnceLock::new();
use crate::journal::{self, UsageRow};

fn files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|_| "无法读取 Codex 用量目录")? {
        let entry = entry.map_err(|_| "无法读取 Codex 用量目录条目")?;
        let kind = entry
            .file_type()
            .map_err(|_| "无法读取 Codex 用量文件类型")?;
        if kind.is_dir() {
            files(&entry.path(), out)?;
        } else if kind.is_file() && entry.path().extension().is_some_and(|v| v == "jsonl") {
            out.push(entry.path());
        }
    }
    Ok(())
}

pub fn read(from: i64, to: i64) -> Result<Vec<UsageRow>, String> {
    let root = std::env::var_os("CODEX1_CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or(crate::paths::home_dir()?.join(".codex"));
    let mut paths = Vec::new();
    files(&root.join("sessions"), &mut paths)?;
    paths.sort();
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut cache = CACHE
        .get_or_init(|| Mutex::new(BTreeMap::new()))
        .lock()
        .map_err(|_| "Codex 用量缓存不可用")?;
    cache.retain(|p, _| paths.contains(p));
    for path in paths {
        let meta = fs::metadata(&path).map_err(|_| "无法读取 Codex 用量文件状态")?;
        if let Some(entry) = cache
            .get(&path)
            .filter(|e| e.size == meta.len() && e.modified == meta.modified().ok())
        {
            for (identity, row) in &entry.rows {
                if row.ts >= from && row.ts <= to && seen.insert(identity.clone()) {
                    out.push(row.clone());
                }
            }
            continue;
        }
        let mut normalized = Vec::new();
        let handle = fs::File::open(&path).map_err(|_| "无法读取 Codex 用量文件")?;
        let mut decoder = Decoder::default();
        for line in BufReader::new(handle).lines() {
            let line = line.map_err(|_| "无法读取 Codex 用量记录")?;
            if !["\"session_meta\"", "\"turn_context\"", "\"token_count\""]
                .iter()
                .any(|key| line.contains(key))
            {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some((identity, row)) = decoder.consume(&v) {
                if row.ts >= from && row.ts <= to && seen.insert(identity.clone()) {
                    out.push(row.clone());
                }
                normalized.push((identity, row));
            }
        }
        cache.insert(
            path,
            Cached {
                size: meta.len(),
                modified: meta.modified().ok(),
                rows: normalized,
            },
        );
    }
    Ok(out)
}

#[derive(Default)]
struct Decoder {
    session: String,
    provider: String,
    model: String,
    previous: Option<Value>,
}
impl Decoder {
    fn consume(&mut self, v: &Value) -> Option<(String, UsageRow)> {
        let p = &v["payload"];
        match v["type"].as_str()? {
            "session_meta" => {
                self.session = p["id"].as_str().unwrap_or("").into();
                self.provider = p["model_provider"].as_str().unwrap_or("unknown").into();
                return None;
            }
            "turn_context" => {
                self.model = p["model"].as_str().unwrap_or("").into();
                return None;
            }
            "event_msg" if p["type"] == "token_count" => {}
            _ => return None,
        }
        let total = &p["info"]["total_token_usage"];
        if !total.is_object() {
            return None;
        }
        let old = self.previous.replace(total.clone());
        let keys = [
            "input_tokens",
            "output_tokens",
            "cached_input_tokens",
            "cache_write_input_tokens",
            "total_tokens",
        ];
        let delta = |key: &str| -> Option<i64> {
            let n = total[key].as_i64()?;
            let before = old.as_ref().map(|v| v[key].as_i64()).unwrap_or(Some(0))?;
            n.checked_sub(before).filter(|v| *v >= 0)
        };
        // Repeated cumulative snapshots do not represent another request.
        if old.as_ref() == Some(total) {
            return None;
        }
        let counters: Vec<Option<i64>> = keys.iter().map(|k| delta(k)).collect();
        if counters.iter().all(Option::is_none) {
            return None;
        }
        let ts = chrono::DateTime::parse_from_rfc3339(v["timestamp"].as_str()?)
            .ok()?
            .timestamp();
        let (raw_input, output, cr, cw, all) = (
            counters[0],
            counters[1],
            counters[2],
            counters[3],
            counters[4],
        );
        // Prove inclusive input using the native total, then subtract cached subsets once.
        let input = match (raw_input, output, cr, cw, all) {
            (Some(i), Some(o), Some(r), Some(w), Some(t)) if i + o == t => {
                i.checked_sub(r)?.checked_sub(w).filter(|n| *n >= 0)
            }
            (Some(i), Some(o), Some(r), Some(w), Some(t)) if i + o + r + w == t => Some(i),
            _ => None,
        };
        let provider = self
            .provider
            .strip_prefix("agenthub_")
            .and_then(decode_id)
            .unwrap_or_else(|| "unknown".into());
        let row=journal::parse_usage_line(&json!({"ts":ts,"channel":"Codex","harness":"codex","provider_app":"codex","provider_id":provider,"model":self.model,"format":"codex_session","source":"codex-session","in":input,"out":output,"cr":cr,"cw":cw}).to_string())?;
        let identity = format!("{}:{}:{}", self.session, v["timestamp"], total);
        Some((identity, row))
    }
}
fn decode_id(raw: &str) -> Option<String> {
    if raw.len() % 2 != 0 {
        return None;
    }
    let bytes = (0..raw.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(raw.get(i..i + 2)?, 16).ok())
        .collect::<Option<Vec<_>>>()?;
    String::from_utf8(bytes).ok()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_or_reset_counters_do_not_create_negative_tokens() {
        let mut d = Decoder::default();
        let v = json!({"type":"event_msg","timestamp":"2026-09-09T01:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10,"cached_input_tokens":40,"total_tokens":999}}}});
        let row = d.consume(&v).unwrap().1;
        assert!(row.input.is_none());
        assert!(row.cw.is_none());
        let mut reset = v.clone();
        reset["payload"]["info"]["total_token_usage"]["input_tokens"] = json!(1);
        assert!(d.consume(&reset).unwrap().1.input.is_none());
    }
    #[test]
    fn inclusive_input_is_not_double_counted_and_snapshots_deduplicate() {
        let mut d = Decoder::default();
        d.consume(
            &json!({"type":"session_meta","payload":{"id":"s","model_provider":"agenthub_7031"}}),
        );
        let v = json!({"type":"event_msg","timestamp":"2026-09-09T01:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100,"output_tokens":10,"cached_input_tokens":40,"cache_write_input_tokens":0,"total_tokens":110}}}});
        let (_, r) = d.consume(&v).unwrap();
        assert_eq!(r.input, Some(60));
        assert_eq!(r.cr, Some(40));
        assert_eq!(r.provider_id, "p1");
        assert!(d.consume(&v).is_none());
        let mut next = v.clone();
        next["payload"]["info"]["total_token_usage"]["input_tokens"] = json!(150);
        next["payload"]["info"]["total_token_usage"]["total_tokens"] = json!(160);
        assert_eq!(d.consume(&next).unwrap().1.input, Some(50));
    }
}
