"""Packaging and console-script contract tests."""

import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

import claude_hub
from claude_hub import entrypoints


class PackagingTests(unittest.TestCase):
    def test_package_metadata_exposes_clean_semantic_version(self) -> None:
        self.assertEqual(claude_hub.__version__, "0.1.0")

    def test_pyproject_toml_declares_expected_entrypoints(self) -> None:
        pyproject_path = REPO_ROOT / "pyproject.toml"
        self.assertTrue(pyproject_path.is_file())
        content = pyproject_path.read_text(encoding="utf-8")
        self.assertIn('claude-hub = "claude_hub.entrypoints:hub_main"', content)
        self.assertIn('claude1 = "claude_hub.entrypoints:claude1_main"', content)
        self.assertIn('switchctl = "claude_hub.switchctl:main"', content)

    def test_hub_entrypoint_help_and_version(self) -> None:
        stdout = io.StringIO()
        with patch.object(sys, "stdout", stdout):
            code = entrypoints.hub_main(["--version"])
        self.assertEqual(code, 0)
        self.assertIn("claude-hub 0.1.0", stdout.getvalue())

        stdout = io.StringIO()
        with patch.object(sys, "stdout", stdout):
            code = entrypoints.hub_main(["--help"])
        self.assertEqual(code, 0)
        self.assertIn("claude-hub", stdout.getvalue())

    def test_claude1_entrypoint_help_and_version(self) -> None:
        stdout = io.StringIO()
        with patch.object(sys, "stdout", stdout):
            code = entrypoints.claude1_main(["--version"])
        self.assertEqual(code, 0)
        self.assertIn("claude1 0.1.0", stdout.getvalue())

        stdout = io.StringIO()
        with patch.object(sys, "stdout", stdout):
            code = entrypoints.claude1_main(["--help"])
        self.assertEqual(code, 0)
        self.assertIn("claude1", stdout.getvalue())

    def test_entrypoint_unsupported_args_returns_code_2(self) -> None:
        stderr = io.StringIO()
        with patch.object(sys, "stderr", stderr):
            code = entrypoints.claude1_main(["--unknown-flag"])
        self.assertEqual(code, 2)
        self.assertIn("packaged operational behavior is not implemented yet", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
