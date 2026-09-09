//! Hub-owned provider storage. External sources are read only during explicit import.
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OpenFlags};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::Path};

pub const SCHEMA: &str = include_str!("../../../provider-schema.sql");

pub fn open(path: &Path) -> Result<Connection> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if path.is_symlink() {
        bail!("provider database must not be a symbolic link");
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if fs::metadata(path)?.permissions().mode() & 0o077 != 0 {
            bail!("provider database requires 0600 permissions");
        }
    }
    let conn = Connection::open(path)?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

#[derive(Deserialize)]
pub struct ImportDocument {
    pub version: u32,
    pub providers: Vec<ImportProvider>,
}
#[derive(Deserialize)]
pub struct ImportProvider {
    pub id: String,
    pub app_type: String,
    pub name: String,
    pub settings_config: Value,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub provider_type: Option<String>,
    #[serde(default)]
    pub sort_index: Option<i64>,
    #[serde(default)]
    pub is_current: bool,
    #[serde(default = "empty_object")]
    pub meta: Value,
}
fn empty_object() -> Value {
    json!({})
}

fn validate(p: &ImportProvider) -> Result<()> {
    if p.id.trim().is_empty()
        || p.name.trim().is_empty()
        || !["claude", "codex"].contains(&p.app_type.as_str())
    {
        bail!("provider requires id, name and app_type (claude/codex)");
    }
    if !p.settings_config.is_object() || !p.meta.is_object() {
        bail!("provider configuration must be an object");
    }
    Ok(())
}

/// Existing IDs are preserved by default. Explicit replace is required to update them.
pub fn import(
    conn: &mut Connection,
    providers: &[ImportProvider],
    source: &str,
    replace: bool,
    preview: bool,
) -> Result<(usize, usize)> {
    let mut seen = std::collections::HashSet::new();
    for p in providers {
        validate(p)?;
        if !seen.insert((&p.id, &p.app_type)) {
            bail!("duplicate provider identity in import");
        }
    }
    let tx = conn.transaction()?;
    let (mut changed, mut skipped) = (0, 0);
    for p in providers {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM providers WHERE id=?1 AND app_type=?2)",
            params![p.id, p.app_type],
            |r| r.get(0),
        )?;
        if exists && !replace {
            skipped += 1;
            continue;
        }
        changed += 1;
        if preview {
            continue;
        }
        tx.execute("INSERT INTO providers(id,app_type,name,settings_config,meta,category,provider_type,sort_index,is_current) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(id,app_type) DO UPDATE SET name=excluded.name, settings_config=excluded.settings_config, meta=excluded.meta, category=excluded.category, provider_type=excluded.provider_type, sort_index=excluded.sort_index", params![p.id,p.app_type,p.name,p.settings_config.to_string(),p.meta.to_string(),p.category,p.provider_type,p.sort_index,p.is_current])?;
        tx.execute("INSERT INTO provider_sources(id,app_type,source,imported_at) VALUES(?1,?2,?3,strftime('%s','now')) ON CONFLICT(id,app_type) DO UPDATE SET source=excluded.source, imported_at=excluded.imported_at", params![p.id,p.app_type,source])?;
    }
    if !preview {
        tx.commit()?;
    }
    Ok((changed, skipped))
}

pub fn read_file(path: &Path) -> Result<Vec<ImportProvider>> {
    let text = fs::read_to_string(path).context("cannot read provider import file")?;
    let doc: ImportDocument = serde_json::from_str(&text).map_err(|_| {
        anyhow::anyhow!("invalid provider document (expected version:1, providers:[])")
    })?;
    if doc.version != 1 {
        bail!("unsupported provider document version");
    }
    Ok(doc.providers)
}

pub fn read_cc(path: &Path) -> Result<Vec<ImportProvider>> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .context("cannot read CC Switch source")?;
    let columns = conn
        .prepare("PRAGMA table_info(providers)")?
        .query_map([], |r| r.get::<_, String>(1))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let fields = [
        "id",
        "app_type",
        "name",
        "settings_config",
        "meta",
        "category",
        "provider_type",
        "sort_index",
        "is_current",
    ];
    let selected: Vec<&str> = fields
        .into_iter()
        .filter(|f| columns.iter().any(|c| c == f))
        .collect();
    let mut stmt = conn.prepare(&format!(
        "SELECT {} FROM providers WHERE app_type IN ('claude','codex')",
        selected.join(",")
    ))?;
    let rows = stmt
        .query_map([], |row| {
            let mut value = serde_json::Map::new();
            for (i, key) in selected.iter().enumerate() {
                use rusqlite::types::ValueRef;
                let v = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => {
                        if *key == "is_current" {
                            json!(n != 0)
                        } else {
                            json!(n)
                        }
                    }
                    ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into()),
                    _ => Value::Null,
                };
                value.insert((*key).into(), v);
            }
            Ok(value)
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    rows.into_iter()
        .map(|mut row| {
            for key in ["settings_config", "meta"] {
                let value = match row.remove(key) {
                    Some(Value::String(text)) => serde_json::from_str(&text)
                        .map_err(|_| anyhow::anyhow!("invalid source provider JSON"))?,
                    Some(Value::Null) | None => json!({}),
                    Some(v) => v,
                };
                row.insert(key.into(), if value.is_null() { json!({}) } else { value });
            }
            serde_json::from_value(Value::Object(row))
                .map_err(|_| anyhow::anyhow!("invalid source provider fields"))
        })
        .collect()
}

pub fn custom(
    id: String,
    app: String,
    name: String,
    url: &str,
    key: &str,
    model: &str,
    protocol: &str,
) -> Result<ImportProvider> {
    if !(url.starts_with("https://") || url.starts_with("http://"))
        || key.trim().is_empty()
        || model.trim().is_empty()
    {
        bail!("URL, API key and model are required");
    }
    if !["anthropic", "openai_chat", "openai_responses"].contains(&protocol) {
        bail!("unsupported protocol");
    }
    let settings_config = if app == "codex" {
        if protocol != "openai_responses" {
            bail!("Codex providers require openai_responses");
        }
        json!({"auth":{"OPENAI_API_KEY":key}, "config":format!("model = {}\nmodel_provider = \"agent_hub\"\n[model_providers.agent_hub]\nname = \"Agent Hub\"\nbase_url = {}\nwire_api = \"responses\"\nrequires_openai_auth = true\n",serde_json::to_string(model)?,serde_json::to_string(url)?)})
    } else {
        json!({"env":{"ANTHROPIC_BASE_URL":url,"ANTHROPIC_AUTH_TOKEN":key,"ANTHROPIC_MODEL":model,"ANTHROPIC_DEFAULT_OPUS_MODEL":model,"ANTHROPIC_DEFAULT_SONNET_MODEL":model,"ANTHROPIC_DEFAULT_HAIKU_MODEL":model},"apiFormat":protocol})
    };
    let p = ImportProvider {
        id,
        app_type: app,
        name,
        settings_config,
        category: None,
        provider_type: None,
        sort_index: None,
        is_current: false,
        meta: json!({"apiFormat":protocol}),
    };
    validate(&p)?;
    Ok(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch(SCHEMA).unwrap();
        c
    }
    fn provider() -> ImportProvider {
        custom(
            "p1".into(),
            "claude".into(),
            "Example".into(),
            "https://example.com",
            "test-only-key",
            "model",
            "anthropic",
        )
        .unwrap()
    }
    #[test]
    fn import_is_explicit_idempotent_and_preserves_edits() {
        let mut c = fixture();
        let mut p = provider();
        assert_eq!(
            import(&mut c, &[provider()], "cc-switch", false, true).unwrap(),
            (1, 0)
        );
        assert_eq!(crate::db::list_providers(&c, None).unwrap().len(), 0);
        import(&mut c, &[provider()], "cc-switch", false, false).unwrap();
        p.name = "Changed".into();
        assert_eq!(
            import(&mut c, &[p], "cc-switch", false, false).unwrap(),
            (0, 1)
        );
        assert_eq!(
            crate::db::list_providers(&c, None).unwrap()[0].name,
            "Example"
        );
        assert!(
            !serde_json::to_string(&crate::db::list_providers(&c, None).unwrap())
                .unwrap()
                .contains("test-only-key")
        );
    }
    #[test]
    fn imported_provider_survives_source_changes_and_removal() {
        let path = std::env::temp_dir().join(format!(
            "agenthub-import-test-{}-{}.db",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut source = open(&path).unwrap();
        import(&mut source, &[provider()], "manual", false, false).unwrap();
        let records = read_cc(&path).unwrap();
        let mut target = fixture();
        import(&mut target, &records, "cc-switch", false, false).unwrap();
        source
            .execute("UPDATE providers SET name='Edited externally'", [])
            .unwrap();
        drop(source);
        std::fs::remove_file(&path).unwrap();
        assert_eq!(
            crate::db::list_providers(&target, None).unwrap()[0].name,
            "Example"
        );
    }

    #[test]
    fn invalid_batch_is_atomic() {
        let mut c = fixture();
        let mut p = provider();
        p.id = "".into();
        assert!(import(&mut c, &[provider(), p], "file", false, false).is_err());
        assert_eq!(crate::db::list_providers(&c, None).unwrap().len(), 0);
    }
}
