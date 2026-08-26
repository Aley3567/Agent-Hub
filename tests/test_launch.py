"""Tests for standalone session launcher orchestrator."""

import sys
import tempfile
import unittest
from pathlib import Path
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from claude_hub.credentials import InMemorySecretStore, SecretStoreError, SecretStoreUnavailableError
from claude_hub.domain import ModelMapping, ProtocolAdapter
from claude_hub.launch import LaunchOutcome, launch_standalone_session
from claude_hub.quick_setup import create_standalone_profile
from claude_hub.standalone import StandaloneProfileNotFoundError, StandaloneProfileStore


class LaunchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        self.profile_store = StandaloneProfileStore(self.data_dir)
        self.secret_store = InMemorySecretStore()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_launch_standalone_session_success(self) -> None:
        profile = create_standalone_profile(
            self.profile_store,
            self.secret_store,
            name="Launch Profile",
            base_url="https://api.launch.com/v1",
            secret="mock_secret_key_launch_test_7777",  # secret-guard: allow generic-secret-assignment
            models=ModelMapping(default="claude-3-5-sonnet"),
        )

        executed_cmd = None
        executed_env = None

        def fake_runner(cmd: list[str], env: dict[str, str]) -> int:
            nonlocal executed_cmd, executed_env
            executed_cmd = list(cmd)
            executed_env = dict(env)
            return 0

        outcome = launch_standalone_session(
            self.profile_store,
            self.secret_store,
            profile.profile_id,
            argv=["--dry-run", "task"],
            claude_bin="/bin/echo",
            runner=fake_runner,
        )

        self.assertEqual(outcome.exit_code, 0)
        self.assertEqual(outcome.profile_id, profile.profile_id)
        self.assertTrue(outcome.isolated)
        self.assertEqual(executed_cmd, ["/bin/echo", "--dry-run", "task"])
        self.assertIsNotNone(executed_env)
        self.assertIn("CLAUDE_CONFIG_DIR", executed_env)
        self.assertEqual(executed_env["ANTHROPIC_BASE_URL"], "https://api.launch.com/v1")

    def test_launch_fails_closed_when_secret_store_unavailable(self) -> None:
        profile = create_standalone_profile(
            self.profile_store,
            self.secret_store,
            name="Secure Profile",
            base_url="https://api.secure.com/v1",
            secret="mock_secret_key_secure_8888",  # secret-guard: allow generic-secret-assignment
        )
        unavailable_store = InMemorySecretStore(available=False)
        with self.assertRaises(SecretStoreUnavailableError):
            launch_standalone_session(
                self.profile_store,
                unavailable_store,
                profile.profile_id,
            )

    def test_launch_missing_profile_raises(self) -> None:
        missing_id = uuid4()
        with self.assertRaises(StandaloneProfileNotFoundError):
            launch_standalone_session(
                self.profile_store,
                self.secret_store,
                missing_id,
            )


if __name__ == "__main__":
    unittest.main()
