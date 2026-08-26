"""System keyring and secure secret storage boundary.

This module owns storing, retrieving, and purging secrets via the operating
system credential store. Plaintext keys are strictly transient in memory and
never written to disk files, JSON configuration, environment variables, or logs.
If no secure system credential store is available, the store strictly fails closed.
"""

from __future__ import annotations

import os
import platform
import subprocess
from typing import Protocol, runtime_checkable
from uuid import UUID


SERVICE_NAME = "claude-hub"


class SecretStoreError(RuntimeError):
    """Base class for secret store failures."""


class SecretStoreUnavailableError(SecretStoreError):
    """Raised when the system credential store is unavailable or missing.

    Enforces strict fail-closed security boundary: never downgrade to disk files.
    """


class SecretStorePermissionError(SecretStoreError):
    """Raised when system credential access is denied by OS policy."""


@runtime_checkable
class SecretStore(Protocol):
    """Protocol for secure OS-level secret storage."""

    def is_available(self) -> bool:
        """Check whether the secure backend is accessible on this machine."""

    def get_secret(self, ref: str | UUID) -> str | None:
        """Retrieve a plaintext secret by reference ID, or None if absent."""

    def set_secret(self, ref: str | UUID, secret: str) -> None:
        """Store a plaintext secret against a reference ID."""

    def delete_secret(self, ref: str | UUID) -> bool:
        """Delete a secret by reference ID. Returns True if deleted, False if not found."""

    def list_secret_refs(self) -> tuple[str, ...]:
        """List all reference IDs managed under this service namespace."""


class InMemorySecretStore(SecretStore):
    """In-memory secret store test double."""

    def __init__(self, *, available: bool = True) -> None:
        self._available = available
        self._secrets: dict[str, str] = {}

    def is_available(self) -> bool:
        return self._available

    def _check_available(self) -> None:
        if not self._available:
            raise SecretStoreUnavailableError("System credential store is unavailable")

    def get_secret(self, ref: str | UUID) -> str | None:
        self._check_available()
        return self._secrets.get(str(ref))

    def set_secret(self, ref: str | UUID, secret: str) -> None:
        self._check_available()
        if not isinstance(secret, str) or not secret:
            raise ValueError("secret must be a non-empty string")
        self._secrets[str(ref)] = secret

    def delete_secret(self, ref: str | UUID) -> bool:
        self._check_available()
        key = str(ref)
        if key in self._secrets:
            del self._secrets[key]
            return True
        return False

    def list_secret_refs(self) -> tuple[str, ...]:
        self._check_available()
        return tuple(sorted(self._secrets.keys()))


class MacOSKeychainStore(SecretStore):
    """macOS Keychain store using /usr/bin/security."""

    def __init__(self, *, service_name: str = SERVICE_NAME) -> None:
        self._service_name = service_name
        self._security_bin = "/usr/bin/security"

    def is_available(self) -> bool:
        return os.path.exists(self._security_bin) and platform.system() == "Darwin"

    def _require_available(self) -> None:
        if not self.is_available():
            raise SecretStoreUnavailableError("macOS Keychain (/usr/bin/security) is unavailable")

    def get_secret(self, ref: str | UUID) -> str | None:
        self._require_available()
        account = str(ref)
        cmd = [
            self._security_bin,
            "find-generic-password",
            "-s",
            self._service_name,
            "-a",
            account,
            "-w",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            return result.stdout.rstrip("\r\n")
        # Exit code 44 on macOS means item not found
        return None

    def set_secret(self, ref: str | UUID, secret: str) -> None:
        self._require_available()
        if not isinstance(secret, str) or not secret:
            raise ValueError("secret must be a non-empty string")
        account = str(ref)
        # -U updates if existing
        cmd = [
            self._security_bin,
            "add-generic-password",
            "-U",
            "-s",
            self._service_name,
            "-a",
            account,
            "-w",
            secret,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            raise SecretStoreError(f"Failed to store credential in Keychain: {result.stderr.strip()}")

    def delete_secret(self, ref: str | UUID) -> bool:
        self._require_available()
        account = str(ref)
        cmd = [
            self._security_bin,
            "delete-generic-password",
            "-s",
            self._service_name,
            "-a",
            account,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        return result.returncode == 0

    def list_secret_refs(self) -> tuple[str, ...]:
        self._require_available()
        cmd = [
            self._security_bin,
            "dump-keychain",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode != 0:
            return ()
        # Parse output for accounts matching service
        refs: list[str] = []
        in_matching_service = False
        for line in result.stdout.splitlines():
            line = line.strip()
            if f'"svce"<blob>="{self._service_name}"' in line:
                in_matching_service = True
            elif in_matching_service and '"acct"<blob>="' in line:
                start = line.find('"acct"<blob>="') + len('"acct"<blob>="')
                end = line.find('"', start)
                if end != -1:
                    refs.append(line[start:end])
                in_matching_service = False
        return tuple(sorted(set(refs)))


def build_default_secret_store() -> SecretStore:
    """Resolve the platform-appropriate secret store, or fail-closed."""
    if platform.system() == "Darwin" and os.path.exists("/usr/bin/security"):
        return MacOSKeychainStore()
    # On unsupported environments without a native store, return a fail-closed mock or raise
    return InMemorySecretStore(available=False)


__all__ = [
    "InMemorySecretStore",
    "MacOSKeychainStore",
    "SERVICE_NAME",
    "SecretStore",
    "SecretStoreError",
    "SecretStorePermissionError",
    "SecretStoreUnavailableError",
    "build_default_secret_store",
]
