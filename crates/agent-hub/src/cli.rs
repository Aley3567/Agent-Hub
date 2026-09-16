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
        #[arg(long, conflicts_with_all = ["file", "cc_switch", "codex_settings"])]
        claude_settings: Option<PathBuf>,
        #[arg(long, conflicts_with_all = ["file", "cc_switch", "claude_settings"])]
        codex_settings: Option<PathBuf>,
        #[arg(long, requires = "codex_settings")]
        auth_file: Option<PathBuf>,
        #[arg(long, requires = "codex_settings")]
        profile: Option<String>,
        #[arg(long, requires = "cc_switch")]
        source_db: Option<PathBuf>,
        #[arg(long)]
        replace: bool,
        #[arg(long)]
        preview: bool,
    },
    /// 查看旧凭证数量（只读）或显式迁移到系统凭证库
    MigrateCredentials {
        #[arg(long)]
        apply: bool,
    },
    /// 重试本库持久清理清单
    RecoverCredentials,
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
        ProviderCommands::MigrateCredentials { apply } => {
            let path = db::default_db_path()?;
            if apply {
                println!(
                    "{}",
                    serde_json::to_string(&provider_store::native::migrate(&path)?)?
                );
            } else {
                println!(
                    "{}",
                    serde_json::to_string(&provider_store::migration::status(&path)?)?
                );
            }
            Ok(())
        }
        ProviderCommands::RecoverCredentials => {
            println!(
                "待清理 {} 项",
                provider_store::native::recover(&db::default_db_path()?)?
            );
            Ok(())
        }
        ProviderCommands::Add => crate::provider_form::add(),
        ProviderCommands::Remove { id, app } => {
            let result = provider_store::native::remove(&db::default_db_path()?, &app, &id)?;
            println!("{}", serde_json::to_string(&result)?);
            Ok(())
        }
        ProviderCommands::Import {
            cc_switch,
            file,
            source_db,
            claude_settings,
            codex_settings,
            auth_file,
            profile,
            replace,
            preview,
        } => {
            let target = db::default_db_path()?;
            use provider_store::plan::{Plan, Source};
            let source = if cc_switch {
                Source::CcSwitch {
                    path: source_db.unwrap_or(provider_store::paths::cc_source_path()?),
                }
            } else if let Some(path) = file {
                Source::Json { path }
            } else if let Some(path) = claude_settings {
                Source::Claude { path }
            } else if let Some(config) = codex_settings {
                let auth = auth_file.unwrap_or_else(|| config.with_file_name("auth.json"));
                Source::Codex {
                    config,
                    auth,
                    profile,
                }
            } else {
                anyhow::bail!("请选择 --cc-switch / --file / --claude-settings / --codex-settings");
            };
            let mut plan = Plan::prepare(source, &target, |name| std::env::var(name).ok())?;
            let preview_data = plan.preview();
            if preview {
                println!("{}", serde_json::to_string(&preview_data)?);
                return Ok(());
            }
            let selected: Vec<_> = preview_data
                .candidates
                .iter()
                .filter(|c| c.blocked_reason.is_none())
                .map(|c| c.candidate_id.clone())
                .collect();
            let counts = plan.select(&selected, replace)?;
            if selected.is_empty() {
                println!("{}", serde_json::to_string(&preview_data)?);
            } else {
                let result = provider_store::native::apply_plan(&plan, &selected, replace)?;
                println!("{}", serde_json::to_string(&result)?);
            }
            if counts.skipped != 0 {
                println!("保留已有 {} 个", counts.skipped);
            }
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
