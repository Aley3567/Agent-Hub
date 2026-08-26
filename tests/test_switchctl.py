"""Tests for switchctl versioned JSON CLI interface."""

import io
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from claude_hub import switchctl
from claude_hub.ccswitch import CCSwitchProviderStore
from claude_hub.domain import StoreCapability
from claude_hub.service import ProviderApplicationService
from claude_hub.testing import InMemoryProviderStore


def _init_test_db(path: Path, version: int = 16) -> None:
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(path)
    conn.execute(f"PRAGMA user_version = {version}")
    conn.execute(
        """
        CREATE TABLE providers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            settings_config TEXT NOT NULL,
            app_type TEXT NOT NULL,
            sort_index INTEGER DEFAULT 0,
            is_current INTEGER DEFAULT 0
        )
        """
    )
    conn.execute(
        """
        INSERT INTO providers (id, name, settings_config, app_type, sort_index, is_current)
        VALUES (?, ?, ?, 'claude', 0, 1)
        """,
        (
            "p-redaction-test",
            "Safe Display Name",
            json.dumps(
                {
                    "apiKey": "mock_cred_val_token_do_not_leak_9999",  # secret-guard: allow generic-secret-assignment
                    "baseUrl": "https://intranet.example.corp/v1",
                    "env": {
                        "ANTHROPIC_MODEL": "claude-3-5-sonnet",
                        "ANTHROPIC_CUSTOM_ENV": "mock_env_token_val_8888",
                    },
                }
            ),
        ),
    )
    conn.commit()
    conn.close()


class SwitchctlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "cc-switch.db"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_help_command(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["--help"], stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["schemaVersion"], 1)
        self.assertTrue(payload["ok"])
        self.assertIn("usage", payload["data"])

    def test_version_command(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["--version"], stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["schemaVersion"], 1)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["data"]["version"], "0.1.0")

    def test_detect_command(self) -> None:
        _init_test_db(self.db_path, version=16)
        service = ProviderApplicationService(CCSwitchProviderStore(self.db_path))
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["detect"], service=service, stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["data"]["capability"], "compatible")

    def test_list_command_and_security_redaction(self) -> None:
        _init_test_db(self.db_path, version=16)
        service = ProviderApplicationService(CCSwitchProviderStore(self.db_path))
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["list"], service=service, stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_OK)
        output_raw = stdout.getvalue()
        payload = json.loads(output_raw)
        self.assertTrue(payload["ok"])
        providers = payload["data"]["providers"]
        self.assertEqual(len(providers), 1)
        self.assertEqual(providers[0]["stableId"], "p-redaction-test")
        self.assertEqual(providers[0]["displayName"], "Safe Display Name")
        self.assertTrue(providers[0]["current"])

        # Security check: secrets must NEVER be present in the raw output
        self.assertNotIn("mock_cred_val", output_raw)
        self.assertNotIn("do_not_leak", output_raw)
        self.assertNotIn("intranet.example.corp", output_raw)

    def test_inspect_command_and_security_redaction(self) -> None:
        _init_test_db(self.db_path, version=16)
        service = ProviderApplicationService(CCSwitchProviderStore(self.db_path))
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["inspect", "p-redaction-test"], service=service, stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_OK)
        output_raw = stdout.getvalue()
        payload = json.loads(output_raw)
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["data"]["stableId"], "p-redaction-test")
        self.assertEqual(payload["data"]["models"]["default"], "claude-3-5-sonnet")
        self.assertEqual(payload["data"]["schemaCapability"], "compatible")

        # Security check: secrets must NEVER be present in the raw inspect output
        self.assertNotIn("mock_cred_val", output_raw)
        self.assertNotIn("do_not_leak", output_raw)
        self.assertNotIn("intranet.example.corp", output_raw)
        self.assertNotIn("mock_env_token_val", output_raw)

    def test_mode_and_route_subcommands(self) -> None:
        _init_test_db(self.db_path, version=16)
        service = ProviderApplicationService(CCSwitchProviderStore(self.db_path))
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["mode"], service=service, stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["data"]["mode"], "companion")
        self.assertEqual(payload["data"]["firstScreen"], "provider_list")

        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["route", "--store", "standalone"], service=service, stdout=stdout, stderr=stderr, standalone_exists=True)
        self.assertEqual(code, switchctl.EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["data"]["mode"], "standalone")
        self.assertEqual(payload["data"]["firstScreen"], "profile_list")

    def test_usage_error_on_unknown_subcommand(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["non-existent-subcommand"], stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_USAGE)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "usage_error")
        self.assertIn("switchctl: usage_error", stderr.getvalue())

    def test_inspect_missing_argument_returns_usage_error(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["inspect"], stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_USAGE)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "usage_error")

    def test_provider_not_found_error(self) -> None:
        _init_test_db(self.db_path, version=16)
        service = ProviderApplicationService(CCSwitchProviderStore(self.db_path))
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["inspect", "unknown-prov-id"], service=service, stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_RUNTIME_ERROR)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "provider_not_found")

    def test_store_unavailable_error(self) -> None:
        absent_path = Path(self.temp_dir.name) / "absent.db"
        service = ProviderApplicationService(CCSwitchProviderStore(absent_path))
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["list"], service=service, stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_RUNTIME_ERROR)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "store_unavailable")

    def test_store_incompatible_error(self) -> None:
        _init_test_db(self.db_path, version=99)
        service = ProviderApplicationService(CCSwitchProviderStore(self.db_path))
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["list"], service=service, stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_RUNTIME_ERROR)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "store_incompatible")

    def test_corrupt_config_error_handling(self) -> None:
        _init_test_db(self.db_path, version=16)
        conn = sqlite3.connect(self.db_path)
        conn.execute("UPDATE providers SET settings_config = 'broken-json{' WHERE id = 'p-redaction-test'")
        conn.commit()
        conn.close()

        service = ProviderApplicationService(CCSwitchProviderStore(self.db_path))
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["inspect", "p-redaction-test"], service=service, stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_RUNTIME_ERROR)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "provider_config_corrupt")


if __name__ == "__main__":
    unittest.main()
