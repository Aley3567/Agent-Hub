//! TUI 薄壳：M1 只有只读渠道列表页。j/k 或方向键导航，q/Esc 退出。
//!
//! 反例警示：cc-switch-cli 的 `tui/data.rs` 是 7k 行上帝文件——
//! 本层按页面拆模块（M2 起每页一个文件），禁止堆叠。

use crate::db::{self, Provider};
use anyhow::Result;
use crossterm::event::{self, Event, KeyCode, KeyEventKind};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::prelude::*;
use ratatui::widgets::{Block, Borders, List, ListItem, ListState};
use std::io::{self, Stdout};

/// panic 或提前返回时也要把终端还给用户。
struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> Result<(Self, Terminal<CrosstermBackend<Stdout>>)> {
        enable_raw_mode()?;
        let mut stdout = io::stdout();
        execute!(stdout, EnterAlternateScreen)?;
        let terminal = Terminal::new(CrosstermBackend::new(stdout))?;
        Ok((Self, terminal))
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = disable_raw_mode();
        let _ = execute!(io::stdout(), LeaveAlternateScreen);
    }
}

pub fn run() -> Result<()> {
    let conn = db::open_readonly(&db::default_db_path()?)?;
    let providers = db::list_providers(&conn, None)?;

    let (_guard, mut terminal) = TerminalGuard::enter()?;
    let mut state = ListState::default();
    if !providers.is_empty() {
        state.select(Some(0));
    }

    loop {
        terminal.draw(|frame| draw(frame, &providers, &mut state))?;
        if let Event::Key(key) = event::read()? {
            if key.kind != KeyEventKind::Press {
                continue;
            }
            match key.code {
                KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                KeyCode::Char('j') | KeyCode::Down => {
                    move_selection(&mut state, providers.len(), 1)
                }
                KeyCode::Char('k') | KeyCode::Up => move_selection(&mut state, providers.len(), -1),
                _ => {}
            }
        }
    }
}

fn move_selection(state: &mut ListState, len: usize, delta: isize) {
    if len == 0 {
        return;
    }
    let current = state.selected().unwrap_or(0) as isize;
    let next = (current + delta).rem_euclid(len as isize) as usize;
    state.select(Some(next));
}

fn draw(frame: &mut Frame, providers: &[Provider], state: &mut ListState) {
    let items: Vec<ListItem> = providers
        .iter()
        .map(|p| {
            let marker = if p.is_current { "*" } else { " " };
            let line = format!(
                "{} {:<24} {:<8} {}",
                marker,
                p.name,
                p.app_type,
                p.category.as_deref().unwrap_or("-")
            );
            let style = if p.is_current {
                Style::default().fg(Color::Green)
            } else {
                Style::default()
            };
            ListItem::new(line).style(style)
        })
        .collect();

    let title = format!(
        "Agent-Hub 渠道（共 {}，* = 激活，j/k 移动，q 退出）",
        providers.len()
    );
    let list = List::new(items)
        .block(Block::default().title(title).borders(Borders::ALL))
        .highlight_symbol("> ")
        .highlight_style(Style::default().add_modifier(Modifier::REVERSED));

    frame.render_stateful_widget(list, frame.area(), state);
}
