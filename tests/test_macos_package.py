"""Exercise the PATH emitted into the macOS Installer scripts without root."""
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest


PACKAGER = Path(__file__).resolve().parents[1] / "scripts/package-agent-hub-macos-pkg.py"


class InstallerPathTests(unittest.TestCase):
    def run_installer_path(self, home, command):
        context = runpy.run_path(str(PACKAGER))["USER_CONTEXT"]
        # The identity and privilege-switching parts belong to macOS PackageKit;
        # run its actual PATH setup under an otherwise empty Installer environment.
        setup = context[context.index("INSTALL_PATH="):context.index("run_as_user()")]
        return subprocess.run(
            ["/bin/sh", "-ec", setup + '\nPATH="$INSTALL_PATH"; export PATH\n' + command],
            env={"INSTALL_USER_HOME": str(home), "PATH": "/usr/bin:/bin"},
            capture_output=True, text=True,
        )

    def test_nvm_cli_and_its_node_interpreter_are_available(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            bin_dir = home / ".nvm/versions/node/v24.0.0/bin"
            bin_dir.mkdir(parents=True)
            cli = bin_dir / "agent-hub-installer-fixture-cli"
            cli.write_text('#!/usr/bin/env agent-hub-installer-fixture-node\n')
            node = bin_dir / "agent-hub-installer-fixture-node"
            node.write_text('#!/bin/sh\nprintf "fixture-ok\\n"\n')
            cli.chmod(0o755)
            node.chmod(0o755)
            result = self.run_installer_path(home, "agent-hub-installer-fixture-cli")
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "fixture-ok")

    def test_missing_version_managers_do_not_add_literal_globs(self):
        with tempfile.TemporaryDirectory() as directory:
            result = self.run_installer_path(Path(directory), 'printf "%s" "$PATH"')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("*", result.stdout)
            self.assertNotIn(".nvm", result.stdout)
            self.assertIn("/usr/bin", result.stdout)
