//! Terminal forms shared by CLI and TUI; secrets never echoed.
use crate::{db, provider_store as store};
use anyhow::{bail, Result};
use std::io::{self, Write};

pub fn prompt(label: &str, secret: bool) -> Result<String> {
    print!("{label}: ");
    io::stdout().flush()?;
    if !secret {
        let mut s = String::new();
        io::stdin().read_line(&mut s)?;
        return Ok(s.trim().to_owned());
    }
    struct RawGuard;
    impl Drop for RawGuard {
        fn drop(&mut self) {
            let _ = crossterm::terminal::disable_raw_mode();
        }
    }
    crossterm::terminal::enable_raw_mode()?;
    let _guard = RawGuard;
    let mut value = String::new();
    loop {
        if let crossterm::event::Event::Key(k) = crossterm::event::read()? {
            use crossterm::event::{KeyCode, KeyModifiers};
            match k.code {
                KeyCode::Enter => break,
                KeyCode::Esc => bail!("已取消"),
                KeyCode::Char('c') if k.modifiers.contains(KeyModifiers::CONTROL) => {
                    bail!("已取消")
                }
                KeyCode::Backspace => {
                    value.pop();
                }
                KeyCode::Char(c) => value.push(c),
                _ => {}
            }
        }
    }
    drop(_guard);
    println!();
    Ok(value)
}

pub fn add() -> Result<()> {
    println!("添加本地 provider（同 ID 更新需明确确认）");
    let app = prompt("Harness：claude / codex", false)?;
    let id = prompt("稳定 ID（修改时填写原 ID）", false)?;
    let name = prompt("显示名称", false)?;
    let url = prompt("API 地址", false)?;
    let protocol = prompt("协议：anthropic / openai_chat / openai_responses", false)?;
    let model = prompt("默认模型", false)?;
    let key = prompt("API key（隐藏输入）", true)?;
    let p = store::custom(id, app, name, &url, &key, &model, &protocol)?;
    let target = db::default_db_path()?;
    let existing = if target.exists() {
        ::provider_store::edit::view(&target, &p.app_type, &p.id).ok()
    } else {
        None
    };
    let exists = existing.is_some();
    if prompt(
        if exists {
            "已有此 ID，替换配置？输入 yes"
        } else {
            "保存？输入 yes"
        },
        false,
    )? != "yes"
    {
        println!("已取消");
        return Ok(());
    }
    store::native::save(
        &target,
        ::provider_store::edit::Input {
            app_type: p.app_type,
            id: p.id,
            name: p.name,
            expected_revision: existing.map(|v| v.revision),
            endpoint: Some(url),
            model: Some(model),
            protocol: Some(protocol),
            secret: Some(key),
            clear_secret: false,
        },
    )?;
    println!("已保存");
    Ok(())
}

pub fn import_prompt(cc: bool) -> Result<()> {
    let target = db::default_db_path()?;
    let source = if cc {
        store::paths::cc_source_path()?
    } else {
        std::path::PathBuf::from(prompt("JSON 文件绝对路径", false)?)
    };
    store::paths::ensure_distinct(&target, &source)?;
    use store::plan::{Plan, Source};
    let source = if cc {
        Source::CcSwitch { path: source }
    } else {
        Source::Json { path: source }
    };
    let mut plan = Plan::prepare(source, &target, |name| std::env::var(name).ok())?;
    let preview = plan.preview();
    for candidate in &preview.candidates {
        println!(
            "{}  {}  {}  {}",
            candidate.candidate_id,
            candidate.app_type,
            candidate.name,
            candidate.blocked_reason.unwrap_or("ready")
        );
    }
    for reason in &preview.blocked {
        println!("不可导入：{reason}");
    }
    let choice = prompt("导入候选 ID（逗号分隔，all 全选可用项，空白取消）", false)?;
    if choice.is_empty() {
        return Ok(());
    }
    let selected: Vec<String> = if choice == "all" {
        preview
            .candidates
            .iter()
            .filter(|c| c.blocked_reason.is_none())
            .map(|c| c.candidate_id.clone())
            .collect()
    } else {
        choice.split(',').map(|v| v.trim().to_owned()).collect()
    };
    let counts = plan.select(&selected, false)?;
    println!(
        "新增 {} 个，已有 {} 个默认保留",
        counts.added, counts.skipped
    );
    let action = prompt(
        "输入 yes 导入新增；replace 覆盖所选已有配置；其他取消",
        false,
    )?;
    if action != "yes" && action != "replace" {
        return Ok(());
    }
    let replace = action == "replace";
    plan.select(&selected, replace)?;
    let result = store::native::apply_plan(&plan, &selected, replace)?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
