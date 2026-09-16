#!/usr/bin/env python3
"""Assemble the macOS app, CLI and runtime in a fresh, traceable release kit."""
import argparse
import hashlib
import json
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path


def package(root: Path, output: Path) -> Path:
    version = json.loads((root / "UI/macos/package.json").read_text())["version"]
    config = json.loads((root / "UI/macos/src-tauri/tauri.conf.json").read_text())
    if config["version"] != version:
        raise SystemExit("macOS package and Tauri versions must match")
    architecture = platform.machine()
    name = f"Agent-Hub-{version}-macOS-{architecture}"
    output.mkdir(parents=True, exist_ok=True)
    release = output / name
    archive = output / (name + ".zip")
    if release.exists() or archive.exists():
        raise SystemExit(f"Release already exists in {output}; choose a fresh output directory")
    app = root / "UI/macos/src-tauri/target/release/bundle/macos/Agent Hub.app"
    cli = root / "target/release/agent-hub"
    if not app.is_dir() or not cli.is_file():
        raise SystemExit("Build UI/macos (npm run build) and the CLI (cargo build --release --locked) first")
    manifest = json.loads((root / "package.json").read_text())
    for filename in manifest["files"]:
        if not (root / filename).exists():
            raise SystemExit(f"Runtime source missing: {filename}")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
    dirty = subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], cwd=root, text=True).strip()
    if dirty:
        raise SystemExit("Commit tracked source changes before packaging")
    with tempfile.TemporaryDirectory(prefix=".package-", dir=output) as staging:
        kit = Path(staging) / name
        kit.mkdir()
        bundled_app = kit / "Agent Hub.app"
        subprocess.run(["ditto", str(app), str(bundled_app)], check=True)
        # Sign the copy, leaving the build output untouched.
        subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(bundled_app)], check=True)
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(bundled_app)], check=True)
        shutil.copy2(cli, kit / "agent-hub")
        runtime = kit / "runtime"
        runtime.mkdir()
        for filename in manifest["files"]:
            source, target = root / filename, runtime / filename
            if source.is_dir():
                shutil.copytree(source, target, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
        shutil.copy2(root / "LICENSE", kit / "LICENSE")
        shutil.copy2(root / "docs/provider-management.md", kit / "Provider导入指南.md")
        installer = kit / "Install.command"
        installer.write_text('''#!/bin/zsh
set -e
KIT_DIR="${0:A:h}"
# Finder does not inherit the terminal's Homebrew PATH.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
/bin/sh "$KIT_DIR/runtime/install.sh"
mkdir -p "$HOME/.local/bin"
if [[ -f "$HOME/.local/bin/agent-hub" ]]; then
  cp "$HOME/.local/bin/agent-hub" "$HOME/.local/bin/agent-hub.backup-$(date +%Y%m%d%H%M%S)"
fi
cp "$KIT_DIR/agent-hub" "$HOME/.local/bin/agent-hub"
chmod 755 "$HOME/.local/bin/agent-hub"
"$HOME/.local/bin/agent-hub" provider init
print 'TUI 与运行时安装完成。运行 ~/.local/bin/agent-hub 管理 provider。'
print '桌面端：打开本目录 Agent Hub.app，或将它复制到 Applications。'
''')
        installer.chmod(0o755)
        (kit / "先读我.txt").write_text(f'''Agent Hub {version} — macOS {architecture}

这是 macOS 首次公开预览版，仅支持 Apple Silicon；最低系统版本见 release.json。
安装前准备 Python 3.11+、Claude Code CLI；协议网关还需要 uv，Codex 会话需要 Codex CLI。

1. 解压整个 ZIP。双击 Install.command 安装 TUI 和 Python 运行时。
   安装器会更新 ~/.claude、~/.codex 下的运行脚本和 ~/.zshrc；被替换文件会备份。
2. 将 Agent Hub.app 复制到 Applications 后打开。DMG 只含桌面 App，不代替运行时安装。
3. 桌面渠道页可新增/编辑、预览导入 Claude/Codex/CC Switch/JSON；也可运行 ~/.local/bin/agent-hub。
4. Provider 元数据保存在 ~/.agent-hub/providers.db；macOS 新写入凭证保存到系统 Keychain。
   不自动迁移旧凭证，不要求安装 CC Switch。启动过程仍可能使用私有临时认证文件。
5. 桌面对话需要可用的本地 Hub；定时任务只在 App 运行时执行，创建任务后请核对启用状态。

本包采用 ad-hoc 签名，没有 Apple Developer ID 签名或公证。首次打开可能被 Gatekeeper 拦截；
确认来源及 SHA-256 后，可在系统设置「隐私与安全性」中批准打开。不要关闭系统全局安全检查。

首版验收范围及已知限制见随 Release 提供的发布说明；不包含 Windows/Intel Mac 安装包。
本安装包不含个人数据库、账号、日志或凭证，不自动切换或重启已有网关。
''')
        (kit / "release.json").write_text(json.dumps({
            "product": "Agent Hub", "version": version, "commit": commit,
            "platform": "macOS", "architecture": architecture,
            "minimumSystemVersion": config["bundle"]["macOS"]["minimumSystemVersion"],
            "signing": "ad-hoc", "notarized": False,
        }, indent=2) + "\n")
        checksums = []
        for path in sorted(kit.rglob("*")):
            if path.is_file():
                digest = hashlib.sha256(path.read_bytes()).hexdigest()
                checksums.append(f"{digest}  {path.relative_to(kit)}")
        (kit / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n")
        staged_archive = Path(staging) / archive.name
        subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(kit), str(staged_archive)], check=True)
        kit.rename(release)
        staged_archive.rename(archive)
    archive.with_suffix(".zip.sha256").write_text(f"{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n")
    return archive


if __name__ == "__main__":
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=root / "dist")
    args = parser.parse_args()
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        parser.error("This release kit is validated for Apple Silicon macOS only")
    print(package(root, args.output_dir.resolve()))
