//! Agent-Hub：统一渠道管理器（TUI + CLI 双模式）。
//!
//! CLI/TUI own interaction; provider-store owns Hub persistence and import rules.
//! Secret-bearing records never enter serialized list output.

pub mod cli;
pub mod db;
pub mod tui;

pub mod provider_form;
pub mod provider_store;
