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
    let mut conn = store::open(&db::default_db_path()?)?;
    let exists = db::list_providers(&conn, Some(&p.app_type))?
        .iter()
        .any(|r| r.id == p.id);
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
    store::import(&mut conn, &[p], "manual", exists, false)?;
    println!("已保存");
    Ok(())
}

pub fn import_prompt(cc: bool) -> Result<()> {
    let entries = if cc {
        store::read_cc(
            &dirs::home_dir()
                .ok_or_else(|| anyhow::anyhow!("HOME unavailable"))?
                .join(".cc-switch/cc-switch.db"),
        )?
    } else {
        store::read_file(std::path::Path::new(&prompt("JSON 文件绝对路径", false)?))?
    };
    for (i, p) in entries.iter().enumerate() {
        println!("{}  {}  {}", i + 1, p.app_type, p.name);
    }
    let choice = prompt("导入序号（逗号分隔，all 全选，空白取消）", false)?;
    if choice.is_empty() {
        return Ok(());
    }
    let selected = if choice == "all" {
        entries
    } else {
        let indexes = choice
            .split(',')
            .map(|s| s.trim().parse::<usize>())
            .collect::<std::result::Result<Vec<_>, _>>()?;
        if indexes.iter().any(|i| *i == 0 || *i > entries.len()) {
            bail!("序号超出范围");
        }
        entries
            .into_iter()
            .enumerate()
            .filter_map(|(i, p)| indexes.contains(&(i + 1)).then_some(p))
            .collect()
    };
    let mut conn = store::open(&db::default_db_path()?)?;
    let preview = store::import(&mut conn, &selected, "preview", false, true)?;
    println!(
        "新增 {} 个，已有 {} 个默认保留。源中删除的条目不会删除本地记录。",
        preview.0, preview.1
    );
    let action = prompt(
        "输入 yes 导入新增；replace 明确覆盖所选已有配置；其他取消",
        false,
    )?;
    if action != "yes" && action != "replace" {
        return Ok(());
    }
    let (n, skip) = store::import(
        &mut conn,
        &selected,
        if cc { "cc-switch" } else { "file" },
        action == "replace",
        false,
    )?;
    println!("已导入 {n} 个，保留 {skip} 个");
    Ok(())
}
