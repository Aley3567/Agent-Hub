//! 路径解析、白名单校验与本地 JSON 的原子读写。
//!
//! 数据源全部位于 `~/.cc-switch/`（Windows 上就是 `%USERPROFILE%\.cc-switch`，
//! `dirs::home_dir()` 在 Windows 上读的正是 `%USERPROFILE%`），可被环境变量覆盖
//! （CONTRACT.md 1 节的覆盖变量列）。
//! `open_path` / `reveal_in_folder` 只允许该目录下的路径，所以校验必须先规范化再比前缀，
//! 防止 `..` 或符号链接（Windows 上是 junction / 符号链接）逃逸。
//!
//! Windows 侧与 macOS 侧的两处实现差异：
//! 1. `canonicalize` 在 Windows 上返回 `\\?\C:\...` 这种 verbatim 形式，
//!    `explorer.exe` 与 `cmd /c start` 都不认它，所以规范化之后必须把前缀去掉；
//! 2. Windows 没有 unix 权限位，落盘时不再 `chmod`——原因写在 `write_json_atomic` 上。

use std::ffi::OsString;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value};

use crate::error;

/// `~/.cc-switch`，全部本地状态的根。
const CC_SWITCH_DIR: &str = ".cc-switch";

pub fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "无法确定当前用户的主目录，请检查系统环境变量 HOME".to_string())
}

fn env_path(name: &str) -> Option<PathBuf> {
    let raw = std::env::var_os(name)?;
    if raw.is_empty() {
        return None;
    }
    Some(PathBuf::from(raw))
}

pub fn cc_switch_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(CC_SWITCH_DIR))
}

/// CC Switch 的 SQLite。只读打开，见 `db.rs`。
pub fn db_path() -> Result<PathBuf, String> {
    match env_path("CLAUDE1_DB_PATH") {
        Some(path) => Ok(path),
        None => Ok(cc_switch_dir()?.join("cc-switch.db")),
    }
}

/// claude1 本地覆盖配置。桌面端唯一允许写的渠道级文件。
pub fn config_path() -> Result<PathBuf, String> {
    match env_path("CLAUDE1_CONFIG_PATH") {
        Some(path) => Ok(path),
        None => Ok(cc_switch_dir()?.join("claude1-config.json")),
    }
}

/// 最近使用记录，只读。
pub fn mru_path() -> Result<PathBuf, String> {
    match env_path("CLAUDE1_MRU_PATH") {
        Some(path) => Ok(path),
        None => Ok(cc_switch_dir()?.join("claude1-mru.json")),
    }
}

/// 默认 hub 配置。
pub fn default_hub_config_path() -> Result<PathBuf, String> {
    Ok(cc_switch_dir()?.join("claude-hub.json"))
}

/// 命名 hub 注册表。
pub fn hub_catalog_path() -> Result<PathBuf, String> {
    Ok(cc_switch_dir()?.join("claude-hubs.json"))
}

/// 账号池定义，首版只读。
pub fn account_pool_path() -> Result<PathBuf, String> {
    match env_path("CLAUDE1_ACCOUNT_POOL_CONFIG") {
        Some(path) => Ok(path),
        None => Ok(cc_switch_dir()?.join("claude1-account-pools.json")),
    }
}

/// 价格表。`models` 为空时不显示成本。
pub fn pricing_path() -> Result<PathBuf, String> {
    Ok(cc_switch_dir()?.join("model-pricing.json"))
}

/// 桌面端自有的计划任务清单（`ScheduledTask[]`），唯一新增的可写文件。
pub fn tasks_path() -> Result<PathBuf, String> {
    match env_path("AGENT_HUB_TASKS_PATH") {
        Some(path) => Ok(path),
        None => Ok(cc_switch_dir()?.join("agent-hub-tasks.json")),
    }
}

pub fn logs_dir() -> Result<PathBuf, String> {
    Ok(cc_switch_dir()?.join("logs"))
}

/// 默认 hub 的用量流水。
pub fn default_usage_journal() -> Result<PathBuf, String> {
    Ok(logs_dir()?.join("claude-hub-usage.jsonl"))
}

/// 默认 hub 的错误流水。
pub fn default_errors_journal() -> Result<PathBuf, String> {
    Ok(logs_dir()?.join("claude-hub-errors.jsonl"))
}

/// 默认 hub 的启动锁；存在说明这个 hub 至少被启动过一次。
pub fn default_hub_lock() -> Result<PathBuf, String> {
    Ok(logs_dir()?.join("claude-hub.lock"))
}

/// 命名 hub 的启动锁，命名规则来自 claude-provider-once.py 的 `_hub_start_lock`。
pub fn named_hub_lock(hub_id: &str) -> Result<PathBuf, String> {
    Ok(logs_dir()?
        .join("hubs")
        .join(format!("claude-hub-{hub_id}.lock")))
}

/// 把 `~` 前缀展开成主目录。Windows 上两种分隔符都要认：
/// 界面里显示的短路径是 `~\...`，而从配置或命令行贴进来的常常是 `~/...`。
fn expand_tilde(raw: &str) -> Result<PathBuf, String> {
    if raw == "~" {
        return home_dir();
    }
    if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        return Ok(home_dir()?.join(rest));
    }
    Ok(PathBuf::from(raw))
}

/// 纯词法规范化：吃掉 `.`，用 `..` 弹栈，越过根目录就报错。
fn lexical_normalize(path: &Path) -> Result<PathBuf, String> {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    return Err("路径里的 .. 越过了根目录".to_string());
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    Ok(out)
}

/// 去掉 Windows `canonicalize` 加上的 verbatim 前缀。
///
/// `canonicalize(r"C:\Users\me")` 返回的是 `\\?\C:\Users\me`：这个形式能绕过 260 字符上限，
/// 但 `explorer.exe /select,` 与 `cmd /c start` 都不认，界面上也没人想看它，
/// 所以统一在这里剥掉。UNC 路径（`\\?\UNC\server\share`）要还原成 `\\server\share`，
/// 顺序上必须先判 UNC，否则会被普通分支切成 `UNC\server\share`。
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    path
}

/// 对已存在的那一段做 `canonicalize`（解掉符号链接与 junction），剩下的尾巴原样拼回。
///
/// 只做词法规范化不足以防住「`~\.cc-switch\x` 是指向 `C:\Windows` 的符号链接」这种逃逸。
fn resolve_existing_prefix(path: &Path) -> PathBuf {
    let mut existing = path.to_path_buf();
    let mut tail: Vec<OsString> = Vec::new();
    while !existing.exists() {
        match existing.file_name() {
            Some(name) => {
                tail.push(name.to_os_string());
                if !existing.pop() {
                    break;
                }
            }
            None => break,
        }
    }
    let mut real = strip_verbatim(existing.canonicalize().unwrap_or(existing));
    for part in tail.iter().rev() {
        real.push(part);
    }
    real
}

/// 校验一个用户给的路径确实落在 `base` 之内，返回规范化后的绝对路径。
pub fn ensure_inside(base: &Path, raw: &str) -> Result<PathBuf, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("路径为空，没有可打开的目标".to_string());
    }
    let expanded = expand_tilde(trimmed)?;
    if !expanded.is_absolute() {
        return Err(format!("只接受绝对路径，收到：{trimmed}"));
    }
    let normalized = lexical_normalize(&expanded)?;
    let real = resolve_existing_prefix(&normalized);
    let real_base = resolve_existing_prefix(base);
    if real != real_base && !real.starts_with(&real_base) {
        return Err(format!(
            "路径超出允许范围：桌面端只允许打开 {} 下的文件，收到 {}",
            error::tilde(&real_base),
            error::tilde(&real)
        ));
    }
    if !real.exists() {
        return Err(format!("路径不存在：{}", error::tilde(&real)));
    }
    Ok(real)
}

/// `ensure_inside` 的 `~/.cc-switch` 版本。
pub fn ensure_inside_cc_switch(raw: &str) -> Result<PathBuf, String> {
    let base = cc_switch_dir()?;
    ensure_inside(&base, raw)
}

/// 读一个 JSON 对象。文件不存在返回 `None`；存在但坏了就报错，不假装成空配置。
pub fn read_json_object(path: &Path) -> Result<Option<Map<String, Value>>, String> {
    let text = match fs::read_to_string(path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(error::io_error("读取 ", path, &err)),
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    let value: Value = serde_json::from_str(&text).map_err(|err| error::json_error(path, &err))?;
    match value {
        Value::Object(map) => Ok(Some(map)),
        _ => Err(error::not_object(path)),
    }
}

/// 原子替换一个本地 JSON 文件：先写同目录临时文件，fsync，再 rename。
/// Windows 的 `fs::rename` 走 `MoveFileEx` 带 `MOVEFILE_REPLACE_EXISTING`，所以覆盖是原子的；
/// 目标文件正被别的进程独占打开时会失败，那种失败原样报出去，不重试也不改写成别的说法。
///
/// 调用方负责「读全量 → 改目标键 → 写回」，未知键因此天然保留。
///
/// **这里不设文件权限**：Windows 没有 unix 的权限位，访问控制是 ACL。
/// `%USERPROFILE%` 下新建的文件继承用户目录的 ACL，默认只有当前用户、SYSTEM 与
/// 管理员能访问，别的标准用户读不到——这已经等价于 macOS 侧 `chmod 600` 想要的效果。
/// 桌面端刻意不去调 `icacls` 再收一遍：那要解析本地化输出，失败还会把「权限没收紧」
/// 升级成「配置写不进去」。代价大于收益，而且这一点在体检里如实说明（doctor 的
/// file-permissions 一项会讲清楚它查不了 ACL），不冒充「已经检查过权限」。
pub fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("无法确定 {} 的所在目录", error::tilde(path)))?;
    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|err| error::io_error("创建目录 ", parent, &err))?;
    }
    let mut text = serde_json::to_string_pretty(value)
        .map_err(|err| format!("序列化 {} 失败：{}", error::tilde(path), err))?;
    text.push('\n');

    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config".to_string());
    let tmp = parent.join(format!(".{}.claude1-desktop.tmp", file_name));
    {
        let mut handle =
            File::create(&tmp).map_err(|err| error::io_error("创建临时文件 ", &tmp, &err))?;
        handle
            .write_all(text.as_bytes())
            .map_err(|err| error::io_error("写入临时文件 ", &tmp, &err))?;
        handle
            .sync_all()
            .map_err(|err| error::io_error("落盘临时文件 ", &tmp, &err))?;
    }
    fs::rename(&tmp, path).map_err(|err| {
        let _ = fs::remove_file(&tmp);
        error::io_error("替换 ", path, &err)
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn temp_base(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("claude1-desktop-paths-{tag}"));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(base.join("logs")).unwrap();
        base
    }

    #[test]
    fn accepts_a_path_inside_the_base() {
        let base = temp_base("inside");
        let target = base.join("logs");
        let checked = ensure_inside(&base, target.to_str().unwrap()).unwrap();
        assert!(checked.ends_with("logs"));
    }

    #[test]
    fn rejects_dotdot_escape() {
        let base = temp_base("escape");
        let raw = format!("{}/logs/../../etc/passwd", base.display());
        let err = ensure_inside(&base, &raw).unwrap_err();
        assert!(err.contains("超出允许范围"), "{err}");
    }

    #[test]
    fn rejects_relative_and_empty_paths() {
        let base = temp_base("relative");
        assert!(ensure_inside(&base, "logs")
            .unwrap_err()
            .contains("绝对路径"));
        assert!(ensure_inside(&base, "   ")
            .unwrap_err()
            .contains("路径为空"));
    }

    #[test]
    fn rejects_missing_path_inside_base() {
        let base = temp_base("missing");
        let raw = base.join("not-there.json");
        let err = ensure_inside(&base, raw.to_str().unwrap()).unwrap_err();
        assert!(err.contains("路径不存在"), "{err}");
    }

    #[test]
    fn atomic_write_preserves_unknown_keys() {
        let base = temp_base("write");
        let target = base.join("claude1-config.json");
        let original = json!({ "version": 3, "providers": {}, "未来新键": [1, 2] });
        write_json_atomic(&target, &original).unwrap();

        let mut root = read_json_object(&target).unwrap().unwrap();
        root.insert("providers".into(), json!({ "abc": { "hidden": true } }));
        write_json_atomic(&target, &Value::Object(root)).unwrap();

        let reread = read_json_object(&target).unwrap().unwrap();
        assert_eq!(reread["未来新键"], json!([1, 2]));
        assert_eq!(reread["providers"]["abc"]["hidden"], json!(true));
        // 临时文件必须已经被 rename 掉，目录里不该留下 .tmp 残骸
        let leftovers: Vec<String> = fs::read_dir(&base)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn tilde_accepts_both_separators() {
        let home = home_dir().unwrap();
        assert_eq!(expand_tilde("~").unwrap(), home);
        assert_eq!(expand_tilde("~/.cc-switch").unwrap(), home.join(".cc-switch"));
        assert_eq!(expand_tilde("~\\.cc-switch").unwrap(), home.join(".cc-switch"));
    }

    #[test]
    fn verbatim_prefix_is_stripped() {
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\C:\Users\me\.cc-switch")),
            PathBuf::from(r"C:\Users\me\.cc-switch")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"\\?\UNC\server\share\x")),
            PathBuf::from(r"\\server\share\x")
        );
        assert_eq!(
            strip_verbatim(PathBuf::from(r"C:\Users\me")),
            PathBuf::from(r"C:\Users\me")
        );
    }

    #[test]
    fn broken_json_is_reported_not_swallowed() {
        let base = temp_base("broken");
        let target = base.join("claude1-config.json");
        fs::write(&target, "{ not json").unwrap();
        let err = read_json_object(&target).unwrap_err();
        assert!(err.contains("不是合法 JSON"), "{err}");
        assert!(read_json_object(&base.join("nope.json")).unwrap().is_none());
    }
}
