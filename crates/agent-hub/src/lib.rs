//! Agent-Hub：统一渠道管理器（TUI + CLI 双模式）。
//!
//! 分层纪律（继承 cc-switch-cli，见 `docs/agent-hub-design.md`）：
//! `cli` 与 `tui` 都是薄壳，业务逻辑只许住在 services/db 层；
//! M1 全库只读，`providers.settings_config` 含凭证，任何输出永不打印该字段。

pub mod cli;
pub mod db;
pub mod tui;
