#!/usr/bin/env python3
"""Create a double-click macOS installer from a verified release kit."""
import argparse
import json
import plistlib
import shutil
import subprocess
import tempfile
from pathlib import Path


USER_CONTEXT = r'''#!/bin/sh
set -eu
if [ "${3:-/}" != "/" ]; then
  echo "Agent Hub must be installed on the startup volume." >&2
  exit 1
fi
INSTALL_USER=$(/usr/bin/stat -f '%Su' /dev/console)
case "$INSTALL_USER" in
  root|loginwindow|_mbsetupuser|"")
    echo "Sign in to a regular macOS account before installing Agent Hub." >&2
    exit 1 ;;
esac
INSTALL_UID=$(/usr/bin/id -u "$INSTALL_USER")
INSTALL_USER_HOME=$(/usr/bin/dscl . -read "/Users/$INSTALL_USER" NFSHomeDirectory | /usr/bin/sed 's/^NFSHomeDirectory: //')
case "$INSTALL_USER_HOME" in
  /*) ;;
  *) echo "Cannot resolve the signed-in user's home directory." >&2; exit 1 ;;
esac
INSTALL_PATH="/opt/homebrew/bin:/usr/local/bin:$INSTALL_USER_HOME/.local/bin:$INSTALL_USER_HOME/.cargo/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Installer does not inherit the interactive shell's version-manager PATH.
for CLI_BIN in "$INSTALL_USER_HOME"/.nvm/versions/node/*/bin "$INSTALL_USER_HOME/.volta/bin" "$INSTALL_USER_HOME/.npm-global/bin"; do
  if [ -d "$CLI_BIN" ]; then INSTALL_PATH="$INSTALL_PATH:$CLI_BIN"; fi
done
run_as_user() {
  /bin/launchctl asuser "$INSTALL_UID" /usr/bin/sudo -u "$INSTALL_USER" \
    /usr/bin/env -i HOME="$INSTALL_USER_HOME" USER="$INSTALL_USER" LOGNAME="$INSTALL_USER" \
    PATH="$INSTALL_PATH" TMPDIR=/tmp "$@"
}
'''


def package(kit: Path, output: Path) -> Path:
    metadata = json.loads((kit / "release.json").read_text())
    if metadata["architecture"] != "arm64":
        raise SystemExit("Only the Apple Silicon release kit is supported")
    version = metadata["version"]
    output.mkdir(parents=True, exist_ok=True)
    result = output / f"Agent-Hub-{version}-macOS-arm64-setup.pkg"
    if result.exists():
        raise SystemExit(f"Installer already exists: {result}")
    subprocess.run(["codesign", "--verify", "--deep", "--strict", str(kit / "Agent Hub.app")], check=True)
    with tempfile.TemporaryDirectory(prefix="agent-hub-pkg-") as directory:
        work = Path(directory)
        payload, scripts = work / "payload", work / "scripts"
        app = payload / "Applications/Agent Hub.app"
        support = payload / "Library/Application Support/Agent Hub"
        app.parent.mkdir(parents=True)
        support.mkdir(parents=True)
        scripts.mkdir()
        subprocess.run(["ditto", str(kit / "Agent Hub.app"), str(app)], check=True)
        shutil.copytree(kit / "runtime", support / "runtime")
        for name in ("agent-hub", "Install.command", "release.json", "LICENSE"):
            shutil.copy2(kit / name, support / name)
        preinstall = scripts / "preinstall"
        preinstall.write_text(USER_CONTEXT + r'''
if [ "$(/usr/bin/uname -m)" != "arm64" ]; then
  echo "This installer requires an Apple Silicon Mac." >&2
  exit 1
fi
if /usr/bin/pgrep -u "$INSTALL_UID" -x claude1-desktop >/dev/null 2>&1; then
  echo "Quit Agent Hub before continuing the installation." >&2
  exit 1
fi
run_as_user /bin/sh -c 'command -v claude >/dev/null || { echo "Install Claude Code CLI before installing Agent Hub." >&2; exit 1; }; python3 -c "import sys; sys.exit(0 if sys.version_info >= (3,11) else 1)"'
''')
        postinstall = scripts / "postinstall"
        postinstall.write_text(USER_CONTEXT + r'''
run_as_user /bin/zsh -f "/Library/Application Support/Agent Hub/Install.command"
echo "Agent Hub is installed in Applications. Open it to get started."
''')
        for script in (preinstall, postinstall):
            script.chmod(0o755)
            subprocess.run(["/bin/sh", "-n", str(script)], check=True)
        components = work / "components.plist"
        subprocess.run(["pkgbuild", "--analyze", "--root", str(payload), str(components)], check=True)
        entries = plistlib.loads(components.read_bytes())
        for entry in entries:
            entry["BundleIsRelocatable"] = False
        components.write_bytes(plistlib.dumps(entries))
        subprocess.run([
            "pkgbuild", "--root", str(payload), "--scripts", str(scripts),
            "--component-plist", str(components), "--ownership", "recommended",
            "--identifier", "com.agenthub.desktop.installer", "--version", version,
            "--install-location", "/", str(result),
        ], check=True)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--kit", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args()
    print(package(args.kit.resolve(), args.output_dir.resolve()))
