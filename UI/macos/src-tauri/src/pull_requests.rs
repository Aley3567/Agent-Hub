//! Read-only GitHub PR inbox through the user's existing gh authentication.
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub repository: Repository,
    pub author: Author,
    pub state: String,
    pub is_draft: bool,
    pub updated_at: String,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Repository { pub name_with_owner: String }
#[derive(Debug, Deserialize, Serialize)]
pub struct Author { pub login: String }

fn arguments(filter: &str, repository: &str) -> Result<Vec<String>, String> {
    let selector = match filter {
        "all" => "--involves",
        "review" => "--review-requested",
        "authored" => "--author",
        _ => return Err("不支持的 PR 筛选 / Unsupported PR filter".into()),
    };
    let mut args: Vec<String> = ["search", "prs", selector, "@me", "--state", "open", "--sort", "updated", "--limit", "100", "--json", "number,title,url,repository,author,state,isDraft,updatedAt"].iter().map(|s| s.to_string()).collect();
    let repository = repository.trim();
    if !repository.is_empty() {
        let parts: Vec<_> = repository.split('/').collect();
        if parts.len() != 2 || parts.iter().any(|p| p.is_empty() || p.starts_with('-') || !p.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))) {
            return Err("仓库格式应为 owner/repository / Use owner/repository".into());
        }
        args.extend(["--repo".into(), repository.into()]);
    }
    Ok(args)
}

pub fn list(filter: &str, repository: &str) -> Result<Vec<PullRequest>, String> {
    let args = arguments(filter, repository)?;
    let binary = crate::launch::which("gh").or_else(|| {
        ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"].iter().map(std::path::PathBuf::from).find(|p| p.is_file())
    }).ok_or("未找到 GitHub CLI；请安装 gh 并在终端执行 gh auth login / Install gh and sign in from your terminal")?;
    let mut child = Command::new(binary).args(args).env("GH_HOST", "github.com").env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()
        .map_err(|_| "无法启动 gh / Could not start gh".to_string())?;
    let stdout = child.stdout.take().ok_or("gh stdout unavailable")?;
    let stderr = child.stderr.take().ok_or("gh stderr unavailable")?;
    let output = std::thread::spawn(move || { let mut bytes = Vec::new(); stdout.take(2_000_000).read_to_end(&mut bytes).map(|_| bytes) });
    let errors = std::thread::spawn(move || { let mut bytes = Vec::new(); stderr.take(64_000).read_to_end(&mut bytes).map(|_| bytes) });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < Duration::from_secs(20) => std::thread::sleep(Duration::from_millis(50)),
            _ => { let _ = child.kill(); let _ = child.wait(); return Err("GitHub 请求超时或中断 / GitHub request timed out or was interrupted".into()); }
        }
    };
    let bytes = output.join().map_err(|_| "gh output reader failed")?.map_err(|_| "gh output unavailable")?;
    let error_bytes = errors.join().map_err(|_| "gh error reader failed")?.map_err(|_| "gh error unavailable")?;
    if !status.success() {
        // Preserve actionable diagnostics after credential redaction, never echo command env.
        return Err(format!("GitHub CLI: {}", crate::redact::redact_text(&String::from_utf8_lossy(&error_bytes))));
    }
    serde_json::from_slice(&bytes).map_err(|_| "GitHub 返回的 PR 数据无法解析 / Invalid GitHub PR response".into())
}

pub fn open(url: &str) -> Result<(), String> {
    if !valid_url(url) { return Err("仅支持 github.com Pull Request 链接 / Only github.com pull request links are supported".into()); }
    #[cfg(target_os = "windows")]
    let status = Command::new("rundll32.exe").args(["url.dll,FileProtocolHandler", url]).status();
    #[cfg(not(target_os = "windows"))]
    let status = Command::new("/usr/bin/open").arg(url).status();
    match status { Ok(s) if s.success() => Ok(()), _ => Err("无法打开 PR 链接 / Could not open PR link".into()) }
}
fn valid_url(url: &str) -> bool {
    let Some(path) = url.strip_prefix("https://github.com/") else { return false };
    let parts: Vec<_> = path.split('/').collect();
    parts.len() == 4 && parts[2] == "pull" && parts[3].parse::<u64>().is_ok_and(|n| n > 0)
        && parts[..2].iter().all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn filters_are_read_only_and_repository_is_one_validated_argument() {
        for (filter, flag) in [("all", "--involves"), ("review", "--review-requested"), ("authored", "--author")] {
            let args = arguments(filter, "owner/repo").unwrap();
            assert_eq!(&args[..2], ["search", "prs"]);
            assert!(args.iter().any(|s| s == flag));
            assert_eq!(args.last().unwrap(), "owner/repo");
        }
        for repo in ["--help", "owner/repo --state closed", "a/b/c", "a/$(whoami)"] { assert!(arguments("all", repo).is_err()); }
        assert!(arguments("merge", "").is_err());
    }
    #[test]
    fn only_pr_https_links_can_be_opened() {
        assert!(valid_url("https://github.com/owner/repo/pull/12"));
        for url in ["javascript:alert(1)", "https://github.com.evil/a/b/pull/1", "https://github.com/a/b/pull/1?token=x", "file:///tmp/a", "https://github.com/a/b/issues/1"] { assert!(!valid_url(url)); }
    }
    #[test]
    fn parses_search_shape_and_preserves_user_text() {
        let rows: Vec<PullRequest> = serde_json::from_str(r#"[{"number":1,"title":"中英 title","url":"https://github.com/a/b/pull/1","repository":{"nameWithOwner":"a/b"},"author":{"login":"author"},"state":"open","isDraft":true,"updatedAt":"2026-09-16T00:00:00Z"}]"#).unwrap();
        assert_eq!(rows[0].title, "中英 title");
        assert!(rows[0].is_draft);
    }
}
