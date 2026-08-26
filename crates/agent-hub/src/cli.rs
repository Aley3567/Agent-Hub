//! CLI 薄壳：clap 分发 + 输出格式化。业务逻辑在 `db`（M1）/ services（M2 起）。

use crate::db;
use anyhow::Result;
use clap::{Parser, Subcommand};
use std::io::IsTerminal;

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
        ProviderCommands::List { app, json } => print_list(app.as_deref(), json),
        ProviderCommands::Current { json } => {
            let conn = db::open_readonly(&db::default_db_path()?)?;
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
    let conn = db::open_readonly(&db::default_db_path()?)?;
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
