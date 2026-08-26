"""Tests for isolated Claude Code session environments."""

import json
import os
import signal
import stat
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from claude_hub.domain import LaunchDescriptor, ModelMapping, ProtocolAdapter
from claude_hub.isolated_session import IsolatedClaudeSession


class IsolatedSessionTests(unittest.TestCase):
    def test_session_lifecycle_and_cleanup(self) -> None:
        now = datetime.now(timezone.utc)
        descriptor = LaunchDescriptor(
            descriptor_id=uuid4(),
            profile_id=uuid4(),
            base_url="https://api.isolated.com/v1",
            adapter=ProtocolAdapter.ANTHROPIC,
            models=ModelMapping(default="claude-3-5-sonnet", fast="claude-3-5-haiku"),
            secret_ref=uuid4(),
            created_at=now,
            expires_at=now + timedelta(seconds=60),
            consumed=True,
        )

        session_path = None
        secret_token = "mock_secret_key_session_test_9999"  # secret-guard: allow generic-secret-assignment

        with IsolatedClaudeSession(descriptor, secret=secret_token) as session_env:
            session_path = session_env.session_dir
            self.assertTrue(session_path.exists())
            self.assertTrue(session_env.settings_file.exists())

            # Check permissions on POSIX
            if os.name == "posix":
                dir_mode = stat.S_IMODE(session_path.stat().st_mode)
                file_mode = stat.S_IMODE(session_env.settings_file.stat().st_mode)
                self.assertEqual(dir_mode, 0o700)
                self.assertEqual(file_mode, 0o600)

            # Check settings content
            settings_data = json.loads(session_env.settings_file.read_text(encoding="utf-8"))
            self.assertEqual(
                settings_data["env"]["ANTHROPIC_BASE_URL"],
                "https://api.isolated.com/v1",
            )
            self.assertEqual(
                settings_data["env"]["ANTHROPIC_API_KEY"],
                secret_token,
            )
            self.assertEqual(
                settings_data["env"]["ANTHROPIC_MODEL"],
                "claude-3-5-sonnet",
            )
            self.assertEqual(
                settings_data["env"]["ANTHROPIC_DEFAULT_HAIKU_MODEL"],
                "claude-3-5-haiku",
            )

            # Check environment mapping
            self.assertEqual(
                session_env.environment["CLAUDE_CONFIG_DIR"],
                str(session_path),
            )
            self.assertEqual(
                session_env.environment["ANTHROPIC_BASE_URL"],
                "https://api.isolated.com/v1",
            )

        # After exiting context manager, session dir MUST be deleted
        self.assertIsNotNone(session_path)
        self.assertFalse(session_path.exists())

    def test_session_cleanup_on_simulated_signal(self) -> None:
        now = datetime.now(timezone.utc)
        descriptor = LaunchDescriptor(
            descriptor_id=uuid4(),
            profile_id=uuid4(),
            base_url="https://api.isolated.com/v1",
            adapter=ProtocolAdapter.ANTHROPIC,
            models=ModelMapping(default="claude-3-5-sonnet"),
            secret_ref=uuid4(),
            created_at=now,
            expires_at=now + timedelta(seconds=60),
            consumed=True,
        )

        session = IsolatedClaudeSession(descriptor, secret="test_key_val_8888")  # secret-guard: allow generic-secret-assignment
        session_env = session.__enter__()
        session_path = session_env.session_dir
        self.assertTrue(session_path.exists())

        # Simulate SIGTERM cleanup
        session.cleanup()
        self.assertFalse(session_path.exists())
        self.assertFalse(session.is_active)


if __name__ == "__main__":
    unittest.main()
