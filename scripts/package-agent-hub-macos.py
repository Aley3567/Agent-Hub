#!/usr/bin/env python3
"""Assemble the tested macOS app, headless runtime and TUI into a local release kit."""
import json
import platform
import shutil
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "UI/macos/package.json").read_text())["version"]
architecture = platform.machine()
release = root / "dist" / f"Agent-Hub-{version}-macOS-{architecture}"
release.mkdir(parents=True, exist_ok=True)
app = root / "UI/macos/src-tauri/target/release/bundle/macos/Agent Hub.app"
if not app.is_dir():
    raise SystemExit("Build UI/macos with npm run build first")
subprocess.run(["codesign", "--force", "--deep", "--sign", "-", str(app)], check=True)
subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
subprocess.run(["ditto", str(app), str(release / "Agent Hub.app")], check=True)
shutil.copy2(root / "target/release/agent-hub", release / "agent-hub")
runtime = release / "runtime"
runtime.mkdir(exist_ok=True)
manifest = json.loads((root / "package.json").read_text())
for name in manifest["files"]:
    source = root / name
    target = runtime / name
    if source.is_dir():
        shutil.copytree(source, target, dirs_exist_ok=True, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
shutil.copy2(root / "docs/provider-management.md", release / "Provider导入指南.md")
installer = release / "Install.command"
installer.write_text('''#!/bin/zsh
set -e
KIT_DIR="${0:A:h}"
mkdir -p "$HOME/.local/bin"
if [[ -f "$HOME/.local/bin/agent-hub" ]]; then
  cp "$HOME/.local/bin/agent-hub" "$HOME/.local/bin/agent-hub.backup-$(date +%Y%m%d%H%M%S)"
fi
cp "$KIT_DIR/agent-hub" "$HOME/.local/bin/agent-hub"
chmod 755 "$HOME/.local/bin/agent-hub"
/bin/sh "$KIT_DIR/runtime/install.sh"
"$HOME/.local/bin/agent-hub" provider init
print 'TUI 与运行时安装完成。运行 ~/.local/bin/agent-hub 管理 provider。'
print '桌面端：打开本目录 Agent Hub.app，或将它复制到 Applications。'
''')
installer.chmod(0o755)
(release / "先读我.txt").write_text(f'''Agent Hub {version} — macOS {architecture}

1. 打开 Agent Hub.app 观察用量图表。可将 App 复制到 Applications。
2. 双击 Install.command 安装新版 TUI 和 Python 运行时；已有文件由安装器备份。
3. 终端运行 ~/.local/bin/agent-hub：a 添加/更新，i 从 CC Switch 批量导入，f 从 JSON 文件导入。
4. 导入后 provider 存在 ~/.agent-hub/providers.db，日常运行不读取 CC Switch 数据库。

桌面图：最近 24 小时、7 天、30 天、自定义；小时/天；Harness、Provider、Token 构成与估算费用。
Codex 蓝色、Claude Code 橙色、未记录灰色。旧 Claude Code 网关流水按已确认来源归属；无证据的 provider 显示未记录。缺失计量或定价显示未知。
用量记录数不是 HTTP 请求总数；明细表合并两种来源，跟随时间范围，20 行分页，点击查看完整详情。

本包为本机编译、ad-hoc 签名版本，没有 Apple Developer ID 公证。
保留现有路由、账号池和日志目录。不会自动切换或重启你正在运行的网关。
''')
archive = release.parent / (release.name + ".zip")
subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(release), str(archive)], check=True)
print(archive)
