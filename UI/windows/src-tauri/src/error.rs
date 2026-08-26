//! 统一的中文错误文本。
//!
//! AGENTS.md 要求错误原样暴露、绝不伪装成功，所以这里只做两件事：
//! 把路径写短（主目录换成 `~`），把底层原因原文带上，不包装成「操作失败」。

use std::io;
use std::path::Path;

use crate::paths;
use crate::redact;

/// 把主目录前缀换成 `~`，让路径在界面上短而可读。
/// 分隔符用 `std::path::MAIN_SEPARATOR`，所以 Windows 上拼出来的是 `~\.cc-switch\...`，
/// 不会出现 `~/.cc-switch\logs` 这种半边斜杠的路径。
pub fn tilde(path: &Path) -> String {
    if let Ok(home) = paths::home_dir() {
        if let Ok(rest) = path.strip_prefix(&home) {
            let text = rest.to_string_lossy();
            if text.is_empty() {
                return "~".to_string();
            }
            return format!("~{}{}", std::path::MAIN_SEPARATOR, text);
        }
    }
    path.to_string_lossy().into_owned()
}

/// 读写文件失败。底层 `io::Error` 原文保留，只额外过一遍凭证清洗。
pub fn io_error(action: &str, path: &Path, err: &io::Error) -> String {
    redact::redact_text(&format!("{}{} 失败：{}", action, tilde(path), err))
}

/// JSON 解析失败。行列信息由 serde_json 自带，不重复拼。
pub fn json_error(path: &Path, err: &serde_json::Error) -> String {
    redact::redact_text(&format!("{} 不是合法 JSON：{}", tilde(path), err))
}

/// 顶层不是 JSON 对象。
pub fn not_object(path: &Path) -> String {
    format!("{} 的顶层必须是 JSON 对象", tilde(path))
}

/// 数据库缺失。这条文案是 CONTRACT.md 指定的原文，不要改写。
pub fn missing_db(path: &Path) -> String {
    format!(
        "找不到 CC Switch 数据库：{}，请先安装并运行一次 CC Switch",
        tilde(path)
    )
}
