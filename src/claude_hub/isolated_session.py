"""Session-isolated Claude configuration environment without touching global settings."""

from __future__ import annotations

import atexit
import json
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from .domain import LaunchDescriptor, ModelMapping


@dataclass(frozen=True, slots=True)
class IsolatedSessionEnvironment:
    """Active session isolation paths and scoped environment variables."""

    session_dir: Path
    settings_file: Path
    environment: dict[str, str]


class IsolatedClaudeSession:
    """Context manager for temporary, isolated Claude Code session settings.

    Creates an ephemeral directory (0700) with a session-scoped settings.json (0600),
    setting CLAUDE_CONFIG_DIR to the isolated directory. On exit or abnormal termination,
    all session files are purged, leaving no traces in global user configuration.
    """

    __slots__ = ("_descriptor", "_secret", "_session_dir", "_closed")

    def __init__(
        self,
        descriptor: LaunchDescriptor,
        *,
        secret: str,
    ) -> None:
        if not isinstance(descriptor, LaunchDescriptor):
            raise TypeError("descriptor must be a LaunchDescriptor")
        if not isinstance(secret, str) or not secret:
            raise ValueError("secret must be a non-empty string")

        self._descriptor = descriptor
        self._secret = secret
        self._session_dir: Path | None = None
        self._closed = False

    @property
    def is_active(self) -> bool:
        return self._session_dir is not None and not self._closed

    def _build_settings_payload(self) -> dict[str, Any]:
        env_vars: dict[str, str] = {
            "ANTHROPIC_BASE_URL": self._descriptor.base_url,
            "ANTHROPIC_API_KEY": self._secret,
        }

        # Project model slots
        models = self._descriptor.models
        if models.default:
            env_vars["ANTHROPIC_MODEL"] = models.default
        if models.fast:
            env_vars["ANTHROPIC_DEFAULT_HAIKU_MODEL"] = models.fast
        if models.reasoning:
            env_vars["ANTHROPIC_REASONING_MODEL"] = models.reasoning
        if models.coding:
            env_vars["ANTHROPIC_DEFAULT_SONNET_MODEL"] = models.coding
        if models.long_context:
            env_vars["ANTHROPIC_DEFAULT_OPUS_MODEL"] = models.long_context
        if models.fallback:
            env_vars["ANTHROPIC_DEFAULT_FABLE_MODEL"] = models.fallback

        return {
            "env": env_vars,
            "permissions": {"allow": []},
        }

    def __enter__(self) -> IsolatedSessionEnvironment:
        # Create ephemeral directory with strict 0700 permissions
        temp_dir = tempfile.mkdtemp(prefix="claude-hub-session-")
        self._session_dir = Path(temp_dir)
        try:
            os.chmod(self._session_dir, 0o700)
        except OSError:
            pass

        # Register emergency cleanup
        atexit.register(self.cleanup)

        # Write settings.json with strict 0600 permissions
        settings_file = self._session_dir / "settings.json"
        payload = self._build_settings_payload()
        with open(settings_file, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
            f.flush()
            os.fsync(f.fileno())

        try:
            os.chmod(settings_file, 0o600)
        except OSError:
            pass

        # Scoped environment variables for subprocess
        session_env = {
            "CLAUDE_CONFIG_DIR": str(self._session_dir),
            "ANTHROPIC_BASE_URL": self._descriptor.base_url,
            "ANTHROPIC_API_KEY": self._secret,
        }

        return IsolatedSessionEnvironment(
            session_dir=self._session_dir,
            settings_file=settings_file,
            environment=session_env,
        )

    def cleanup(self) -> None:
        """Purge the isolated session directory and its contents."""
        if self._session_dir is not None and self._session_dir.exists():
            try:
                shutil.rmtree(self._session_dir, ignore_errors=True)
            except OSError:
                pass
            self._session_dir = None
        self._closed = True

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.cleanup()


__all__ = [
    "IsolatedClaudeSession",
    "IsolatedSessionEnvironment",
]
