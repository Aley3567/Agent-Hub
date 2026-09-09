//! CLI 薄壳：clap 分发 + 输出格式化。业务逻辑在 `db`（M1）/ services（M2 起）。

use crate::{db, provider_store};
use anyhow::Result;
use clap::{Parser, Subcommand};
use std::io::IsTerminal;
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "agent-hub",
    version,
    about = "Agent-Hub：统一渠道管理（TUI + CLI 双模式）"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// 渠道管理
    Provider {
        #[command(subcommand)]
        command: ProviderCommands,
    },
}

#[derive(Subcommand)]
enum ProviderCommands {
    /// 初始化独立 provider 存储
    Init,
    /// 从 CC Switch 或 version:1 JSON 文件显式导入
    Import {
        #[arg(long, conflicts_with = "file")]
        cc_switch: bool,
        #[arg(long)]
        file: Option<PathBuf>,
        #[arg(long)]
        source_db: Option<PathBuf>,
        #[arg(long)]
        replace: bool,
        #[arg(long)]
        preview: bool,
    },
    /// 交互添加 provider（API key 隐藏输入）
    Add,
    /// 删除一个本地 provider
    Remove {
        id: String,
        #[arg(long)]
        app: String,
    },
    /// 列出渠道（只读）
    List {
        /// 只列某个 app：claude / codex
        #[arg(long)]
        app: Option<String>,
        /// JSON 输出
        #[arg(long)]
        json: bool,
    },
    /// 显示各 app 当前激活渠道
    Current {
        /// JSON 输出
        #[arg(long)]
        json: bool,
    },
}

/// 入口：有子命令走 CLI，裸命令进 TUI（非 TTY 退化为只读列表）。
pub fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Some(Commands::Provider { command }) => run_provider(command),
        None => {
            if std::io::stdout().is_terminal() && std::io::stdin().is_terminal() {
                crate::tui::run()
            } else {
                print_list(None, false)
            }
        }
    }
}

fn run_provider(command: ProviderCommands) -> Result<()> {
    match command {
        ProviderCommands::Init => {
            provider_store::open(&db::default_db_path()?)?;
            println!("Provider 存储已就绪");
            Ok(())
        }
        ProviderCommands::Add => crate::provider_form::add(),
        ProviderCommands::Remove { id, app } => {
            let mut conn = provider_store::open(&db::default_db_path()?)?;
            let tx = conn.transaction()?;
            let n = tx.execute(
                "DELETE FROM providers WHERE id=?1 AND app_type=?2",
                rusqlite::params![id, app],
            )?;
            tx.execute(
                "DELETE FROM provider_sources WHERE id=?1 AND app_type=?2",
                rusqlite::params![id, app],
            )?;
            tx.commit()?;
            println!("已删除 {n} 个 provider");
            Ok(())
        }
        ProviderCommands::Import {
            cc_switch,
            file,
            source_db,
            replace,
            preview,
        } => {
            let providers = if cc_switch {
                let path = source_db.unwrap_or(
                    dirs::home_dir()
                        .ok_or_else(|| anyhow::anyhow!("HOME unavailable"))?
                        .join(".cc-switch/cc-switch.db"),
                );
                provider_store::read_cc(&path)?
            } else if let Some(path) = file {
                provider_store::read_file(&path)?
            } else {
                anyhow::bail!("请选择 --cc-switch 或 --file PATH");
            };
            let mut conn = provider_store::open(&db::default_db_path()?)?;
            let (changed, skipped) = provider_store::import(
                &mut conn,
                &providers,
                if cc_switch { "cc-switch" } else { "file" },
                replace,
                preview,
            )?;
            println!(
                "{} {changed} 个，保留已有 {skipped} 个",
                if preview { "将导入" } else { "已导入" }
            );
            Ok(())
        }
        ProviderCommands::List { app, json } => print_list(app.as_deref(), json),
        ProviderCommands::Current { json } => {
            let conn = provider_store::open(&db::default_db_path()?)?;
            let providers = db::current_providers(&conn)?;
            if json {
                println!("{}", serde_json::to_string_pretty(&providers)?);
            } else if providers.is_empty() {
                println!("（没有激活的渠道）");
            } else {
                for p in &providers {
                    println!("{}\t{}", p.app_type, p.name);
                }
            }
            Ok(())
        }
    }
}

fn print_list(app: Option<&str>, json: bool) -> Result<()> {
    let conn = provider_store::open(&db::default_db_path()?)?;
    let providers = db::list_providers(&conn, app)?;
    if json {
        println!("{}", serde_json::to_string_pretty(&providers)?);
        return Ok(());
    }
    println!(
        "{:<2} {:<24} {:<8} {:<12} {}",
        "", "名称", "APP", "类别", "ID"
    );
    for p in &providers {
        let marker = if p.is_current { "*" } else { "" };
        println!(
            "{:<2} {:<24} {:<8} {:<12} {}",
            marker,
            p.name,
            p.app_type,
            p.category.as_deref().unwrap_or("-"),
            p.id,
        );
    }
    println!("共 {} 个渠道（* = 当前激活）", providers.len());
    Ok(())
}
