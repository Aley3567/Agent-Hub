"""Run the shipped entry points outside the checkout, without user config."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("npm") and shutil.which("node"), "requires npm and Node")
class NpmArtifactTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="hub-npm-test-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.work = Path(cls.temporary.name)
        packed = subprocess.run(
            ["npm", "pack", "--ignore-scripts", "--json", "--pack-destination", str(cls.work)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
            timeout=60,
        )
        artifact = cls.work / json.loads(packed.stdout)[0]["filename"]
        cls.unpacked = cls.work / "unpacked"
        with tarfile.open(artifact) as archive:
            archive.extractall(cls.unpacked, filter="data")
        cls.package = cls.unpacked / "package"
        cls.env = dict(os.environ)
        for key in tuple(cls.env):
            if key.startswith(("CLAUDE", "CODEX", "PYTHON")):
                cls.env.pop(key)
        # Help must not load configuration; make accidental DB access fail
        # against an absent fixture path instead of reaching the user's DB.
        cls.env["CLAUDE1_HOME"] = str(cls.work / "launcher-home")
        cls.env["CLAUDE1_DB_PATH"] = str(cls.work / "absent.db")
        cls.env["CLAUDE_HUB_DB"] = str(cls.work / "absent.db")
        cls.env["CLAUDE_HUB_CONFIG"] = str(cls.work / "absent-config.json")

    def run_entrypoint(self, command):
        result = subprocess.run(
            command,
            cwd=self.work,
            env=self.env,
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_npm_launcher_help_runs_without_checkout_modules(self):
        output = self.run_entrypoint(
            ["node", str(self.package / "bin/model-bridge.js"), "--help"]
        )
        self.assertIn("claude1", output)

    def test_hub_help_runs_without_checkout_modules(self):
        output = self.run_entrypoint(
            [sys.executable, str(self.package / "claude-hub.py"), "--help"]
        )
        self.assertIn("serve", output)
