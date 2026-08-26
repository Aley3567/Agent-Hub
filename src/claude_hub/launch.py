"""Launcher orchestrator for standalone isolated Claude Code sessions."""

from __future__ import annotations

import os
import shutil
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from .credentials import SecretStore, SecretStoreError, SecretStoreUnavailableError
from .domain import StandaloneProfile
from .isolated_session import IsolatedClaudeSession
from .launch_descriptor import consume_launch_descriptor, create_launch_descriptor
from .standalone import StandaloneProfileNotFoundError, StandaloneProfileStore


@dataclass(frozen=True, slots=True)
class LaunchOutcome:
    """Diagnostic outcome of an isolated session execution."""

    profile_id: UUID
    exit_code: int
    session_id: str
    isolated: bool = True


class LaunchError(RuntimeError):
    """Base class for launch execution failures."""


def resolve_claude_binary(explicit: str | None = None) -> str:
    """Find the Claude CLI executable on system PATH or use explicit path."""
    if explicit is not None:
        if not os.path.exists(explicit):
            raise LaunchError(f"Specified Claude binary not found at {explicit}")
        return explicit

    found = shutil.which("claude")
    if found is not None:
        return found
    return "claude"


def launch_standalone_session(
    profile_store: StandaloneProfileStore,
    secret_store: SecretStore,
    profile_id: UUID | str,
    *,
    argv: Sequence[str] = (),
    claude_bin: str | None = None,
    runner: Any | None = None,
    environ: Mapping[str, str] | None = None,
) -> LaunchOutcome:
    """Launch an isolated Claude Code session for a Standalone Profile.

    Orchestration sequence:
    1. Fetch profile metadata from StandaloneProfileStore.
    2. Retrieve secret from SecretStore (strictly fail-closed if unavailable).
    3. Generate and consume short-lived LaunchDescriptor.
    4. Spawn IsolatedClaudeSession creating isolated temporary directory & settings.json.
    5. Execute Claude CLI subprocess with isolated CLAUDE_CONFIG_DIR and environment.
    6. Automatically clean up ephemeral session upon exit.
    """

    # 1. Profile metadata
    profile = profile_store.get(profile_id)

    # 2. Secret resolution (fail-closed)
    if not secret_store.is_available():
        raise SecretStoreUnavailableError(
            "System credential store is unavailable; refusing to launch without secure credentials"
        )

    secret = secret_store.get_secret(profile.secret_ref)
    if secret is None:
        raise SecretStoreError(
            f"Credential for profile {profile.name!r} not found in system credential store"
        )

    # 3. Ephemeral single-use descriptor
    raw_descriptor = create_launch_descriptor(profile)
    descriptor = consume_launch_descriptor(raw_descriptor)

    # 4. Isolated session environment
    claude_executable = resolve_claude_binary(claude_bin)
    base_env = dict(os.environ if environ is None else environ)

    with IsolatedClaudeSession(descriptor, secret=secret) as session_env:
        exec_env = {**base_env, **session_env.environment}
        cmd = [claude_executable, *argv]

        if runner is not None:
            # Injectable runner for tests and dry runs
            exit_code = runner(cmd, env=exec_env)
        else:
            proc = subprocess.run(cmd, env=exec_env)
            exit_code = proc.returncode

        return LaunchOutcome(
            profile_id=profile.profile_id,
            exit_code=exit_code,
            session_id=str(descriptor.descriptor_id),
            isolated=True,
        )


__all__ = [
    "LaunchError",
    "LaunchOutcome",
    "launch_standalone_session",
    "resolve_claude_binary",
]
