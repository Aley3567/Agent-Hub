"""Tests for switchctl versioned JSON CLI interface."""

import io
import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from claude_hub import switchctl
from claude_hub.ccswitch import CCSwitchProviderStore, stable_provider_id
from claude_hub.credentials import InMemorySecretStore
from claude_hub.domain import ModelMapping, ProtocolAdapter, StoreCapability
from claude_hub.quick_setup import create_standalone_profile
from claude_hub.service import ProviderApplicationService
from claude_hub.standalone import StandaloneProfileStore
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
        self.profile_dir = Path(self.temp_dir.name) / "profiles"
        self.profile_store = StandaloneProfileStore(self.profile_dir)
        self.secret_store = InMemorySecretStore()

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
        data = payload["data"]
        self.assertEqual(data["capability"], "compatible")
        self.assertTrue(data["available"])
        self.assertEqual(data["mode"], "companion")
        self.assertIsInstance(data["hint"], str)
        self.assertNotEqual(data["hint"], "")

    def test_detect_unavailable_is_distinguishable_from_absent(self) -> None:
        _init_test_db(self.db_path, version=16)
        os.chmod(self.db_path, 0o000)
        try:
            locked_service = ProviderApplicationService(CCSwitchProviderStore(self.db_path))
            stdout = io.StringIO()
            stderr = io.StringIO()
            code = switchctl.main(["detect"], service=locked_service, stdout=stdout, stderr=stderr)
            self.assertEqual(code, switchctl.EXIT_OK)
            unavailable_payload = json.loads(stdout.getvalue())
        finally:
            os.chmod(self.db_path, 0o600)

        absent_service = ProviderApplicationService(
            CCSwitchProviderStore(Path(self.temp_dir.name) / "absent.db")
        )
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["detect"], service=absent_service, stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_OK)
        absent_payload = json.loads(stdout.getvalue())

        self.assertEqual(unavailable_payload["data"]["capability"], "unavailable")
        self.assertFalse(unavailable_payload["data"]["available"])
        self.assertIsNone(unavailable_payload["data"]["mode"])
        self.assertEqual(absent_payload["data"]["capability"], "absent")
        self.assertIsNotNone(absent_payload["data"]["mode"])
        self.assertNotEqual(unavailable_payload["data"], absent_payload["data"])

    @unittest.skipIf(not hasattr(os, "geteuid") or os.geteuid() == 0, "requires non-root")
    def test_mode_fails_closed_when_store_unavailable(self) -> None:
        _init_test_db(self.db_path, version=16)
        os.chmod(self.db_path, 0o000)
        try:
            service = ProviderApplicationService(CCSwitchProviderStore(self.db_path))
            stdout = io.StringIO()
            stderr = io.StringIO()
            code = switchctl.main(["mode"], service=service, stdout=stdout, stderr=stderr)
        finally:
            os.chmod(self.db_path, 0o600)
        self.assertEqual(code, switchctl.EXIT_RUNTIME_ERROR)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "store_unavailable")

    def test_runtime_error_envelope_does_not_leak_exception_text(self) -> None:
        class _ExplodingStore:
            def detect(self) -> StoreCapability:
                raise RuntimeError("probe failed at /Users/admin/secrets/cc-switch.db")

            def list(self):
                raise RuntimeError("unused")

            def inspect(self, reference):
                raise RuntimeError("unused")

        service = ProviderApplicationService(_ExplodingStore())
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["detect"], service=service, stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_RUNTIME_ERROR)
        output_raw = stdout.getvalue()
        payload = json.loads(output_raw)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "runtime_error")
        self.assertEqual(payload["error"]["message"], "detect failed: RuntimeError")
        self.assertNotIn("/", output_raw)
        self.assertNotIn(".db", output_raw)
        self.assertNotIn("secrets", output_raw)

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
        self.assertEqual(
            providers[0]["stableId"], stable_provider_id("p-redaction-test")
        )
        self.assertNotEqual(providers[0]["stableId"], "p-redaction-test")
        self.assertEqual(providers[0]["displayName"], "Safe Display Name")
        self.assertTrue(providers[0]["current"])

        # Security check: secrets and the raw provider id must NEVER be present
        self.assertNotIn("mock_cred_val", output_raw)
        self.assertNotIn("do_not_leak", output_raw)
        self.assertNotIn("intranet.example.corp", output_raw)
        self.assertNotIn("p-redaction-test", output_raw)

    def test_inspect_command_and_security_redaction(self) -> None:
        _init_test_db(self.db_path, version=16)
        service = ProviderApplicationService(CCSwitchProviderStore(self.db_path))
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(
            ["inspect", stable_provider_id("p-redaction-test")],
            service=service,
            stdout=stdout,
            stderr=stderr,
        )
        self.assertEqual(code, switchctl.EXIT_OK)
        output_raw = stdout.getvalue()
        payload = json.loads(output_raw)
        self.assertTrue(payload["ok"])
        self.assertEqual(
            payload["data"]["stableId"], stable_provider_id("p-redaction-test")
        )
        self.assertEqual(payload["data"]["models"]["default"], "claude-3-5-sonnet")
        self.assertEqual(payload["data"]["schemaCapability"], "compatible")

        # Security check: secrets and raw provider id must NEVER be present
        self.assertNotIn("mock_cred_val", output_raw)
        self.assertNotIn("do_not_leak", output_raw)
        self.assertNotIn("intranet.example.corp", output_raw)
        self.assertNotIn("mock_env_token_val", output_raw)
        self.assertNotIn("p-redaction-test", output_raw)

    def test_stable_id_does_not_expose_raw_uuid(self) -> None:
        import uuid

        raw_uuid = str(uuid.uuid4())
        conn = sqlite3.connect(self.db_path)
        conn.execute(f"PRAGMA user_version = 16")
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
            VALUES (?, 'UUID Provider', ?, 'claude', 0, 1)
            """,
            (
                raw_uuid,
                json.dumps({"env": {"ANTHROPIC_MODEL": "claude-3-5-sonnet"}}),
            ),
        )
        conn.commit()
        conn.close()

        service = ProviderApplicationService(CCSwitchProviderStore(self.db_path))
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(["list"], service=service, stdout=stdout, stderr=stderr)
        self.assertEqual(code, switchctl.EXIT_OK)
        list_raw = stdout.getvalue()
        payload = json.loads(list_raw)
        self.assertEqual(len(payload["data"]["providers"]), 1)
        derived = payload["data"]["providers"][0]["stableId"]
        self.assertNotEqual(derived, raw_uuid)
        self.assertNotIn(raw_uuid, list_raw)

        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(
            ["inspect", derived], service=service, stdout=stdout, stderr=stderr
        )
        self.assertEqual(code, switchctl.EXIT_OK)
        self.assertEqual(json.loads(stdout.getvalue())["data"]["stableId"], derived)
        self.assertNotIn(raw_uuid, stdout.getvalue())

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

    def test_profile_lifecycle_commands(self) -> None:
        # 1. Profile create
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(
            [
                "profile",
                "create",
                "--name",
                "My CLI Profile",
                "--base-url",
                "https://api.cli.com/v1",
                "--secret",
                "mock_secret_cli_token_9999",  # secret-guard: allow generic-secret-assignment
                "--models",
                json.dumps({"default": "claude-3-5-sonnet", "fast": "claude-3-5-haiku"}),
            ],
            profile_store=self.profile_store,
            secret_store=self.secret_store,
            stdout=stdout,
            stderr=stderr,
        )
        self.assertEqual(code, switchctl.EXIT_OK)
        output_raw = stdout.getvalue()
        self.assertNotIn("mock_secret_cli_token", output_raw)
        payload = json.loads(output_raw)
        self.assertTrue(payload["ok"])
        profile_id = payload["data"]["profileId"]

        # 2. Profile list
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(
            ["profile", "list"],
            profile_store=self.profile_store,
            secret_store=self.secret_store,
            stdout=stdout,
            stderr=stderr,
        )
        self.assertEqual(code, switchctl.EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(len(payload["data"]["profiles"]), 1)
        self.assertEqual(payload["data"]["profiles"][0]["name"], "My CLI Profile")

        # 3. Profile inspect
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(
            ["profile", "inspect", profile_id],
            profile_store=self.profile_store,
            secret_store=self.secret_store,
            stdout=stdout,
            stderr=stderr,
        )
        self.assertEqual(code, switchctl.EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["data"]["name"], "My CLI Profile")
        self.assertTrue(payload["data"]["hasSecret"])
        self.assertNotIn("mock_secret_cli_token", stdout.getvalue())

        # 4. Profile launch
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(
            ["launch", profile_id],
            profile_store=self.profile_store,
            secret_store=self.secret_store,
            stdout=stdout,
            stderr=stderr,
            runner=lambda cmd, env: 0,
        )
        self.assertEqual(code, switchctl.EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["data"]["exitCode"], 0)
        self.assertTrue(payload["data"]["isolated"])

        # 5. Profile delete
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(
            ["profile", "delete", profile_id],
            profile_store=self.profile_store,
            secret_store=self.secret_store,
            stdout=stdout,
            stderr=stderr,
        )
        self.assertEqual(code, switchctl.EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["data"]["deleted"])

    def test_profile_create_via_stdin(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        stdin = io.StringIO("mock_stdin_secret_token_val_5678\n")  # secret-guard: allow generic-secret-assignment
        code = switchctl.main(
            [
                "profile",
                "create",
                "--name",
                "Stdin Profile",
                "--base-url",
                "https://api.stdin.com/v1",
                "--secret-stdin",
            ],
            profile_store=self.profile_store,
            secret_store=self.secret_store,
            stdin=stdin,
            stdout=stdout,
            stderr=stderr,
        )
        self.assertEqual(code, switchctl.EXIT_OK)
        payload = json.loads(stdout.getvalue())
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["data"]["name"], "Stdin Profile")

    def test_profile_create_missing_args_returns_json_envelope(self) -> None:
        stdout = io.StringIO()
        stderr = io.StringIO()
        code = switchctl.main(
            [
                "profile",
                "create",
                "--name",
                "Incomplete",
            ],
            profile_store=self.profile_store,
            secret_store=self.secret_store,
            stdout=stdout,
            stderr=stderr,
        )
        self.assertEqual(code, switchctl.EXIT_RUNTIME_ERROR)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "runtime_error")

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
        code = switchctl.main(
            ["inspect", stable_provider_id("p-redaction-test")],
            service=service,
            stdout=stdout,
            stderr=stderr,
        )
        self.assertEqual(code, switchctl.EXIT_RUNTIME_ERROR)
        payload = json.loads(stdout.getvalue())
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error"]["code"], "provider_config_corrupt")


if __name__ == "__main__":
    unittest.main()
