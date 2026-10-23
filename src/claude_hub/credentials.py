"""System keyring and secure secret storage boundary.

This module owns storing, retrieving, and purging secrets via the operating
system credential store. Plaintext keys are strictly transient in memory and
never written to disk files, JSON configuration, environment variables, or logs.
If no secure system credential store is available, the store strictly fails closed.
"""

from __future__ import annotations

import os
import platform
import re
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

    def __init__(self, *, service_name: str = SERVICE_NAME,
                 keychain_path: str | os.PathLike[str] | None = None) -> None:
        self._service_name = service_name
        self._security_bin = "/usr/bin/security"
        self._keychain_args = [] if keychain_path is None else [os.fspath(keychain_path)]

    def is_available(self) -> bool:
        return os.path.exists(self._security_bin) and platform.system() == "Darwin"

    def _require_available(self) -> None:
        if not self.is_available():
            raise SecretStoreUnavailableError("macOS Keychain (/usr/bin/security) is unavailable")

    def _run(self, args: list[str], *, input: str | None = None):
        try:
            return subprocess.run([self._security_bin, *args], input=input,
                                  capture_output=True, text=True, encoding="utf-8", timeout=15)
        except (OSError, subprocess.TimeoutExpired, UnicodeError):
            raise SecretStoreUnavailableError("Keychain operation unavailable") from None

    @staticmethod
    def _found(result) -> bool:
        if result.returncode == 0:
            return True
        if result.returncode == 44:  # errSecItemNotFound (-25300), reduced to an exit status
            return False
        if result.returncode in (128, 51, 36):  # cancelled, auth failed, interaction not allowed
            raise SecretStorePermissionError("Keychain access denied or locked")
        raise SecretStoreUnavailableError("Keychain operation unavailable")

    @staticmethod
    def _quote(value: str) -> str:
        if any(char in value for char in "\x00\r\n"):
            raise ValueError("invalid Keychain credential input")
        # security -i is not a shell: it does not concatenate adjacent quotes.
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'

    def get_secret(self, ref: str | UUID) -> str | None:
        self._require_available()
        account = str(ref)
        cmd = [
            "find-generic-password",
            "-s",
            self._service_name,
            "-a",
            account,
            "-g",
            *self._keychain_args,
        ]
        result = self._run(cmd)
        if not self._found(result):
            return None
        # -w prints bare hex for non-printable bytes, indistinguishable from a
        # literal hex password. -g marks hex explicitly and quotes plain text.
        for line in result.stderr.splitlines():
            if not line.startswith("password: "):
                continue
            value = line.removeprefix("password: ")
            if value.startswith('"') and value.endswith('"'):
                return value[1:-1]
            match = re.fullmatch(r"0x([0-9a-fA-F]+)(?: +.*)?", value)
            if match:
                try:
                    return bytes.fromhex(match[1]).decode("utf-8")
                except (ValueError, UnicodeError):
                    break
        raise SecretStoreError("Keychain credential response is invalid")

    def set_secret(self, ref: str | UUID, secret: str) -> None:
        self._require_available()
        if not isinstance(secret, str) or not secret:
            raise ValueError("secret must be a non-empty string")
        account = str(ref)
        # Match provider-store's stdin + hex boundary: process arguments are
        # visible to other local processes, and interactive input is one line.
        if "\x00" in secret:
            raise ValueError("invalid Keychain credential input")
        args = ["add-generic-password", "-U", "-s", self._service_name, "-a", account,
                "-X", secret.encode("utf-8").hex(), *self._keychain_args]
        command = " ".join(self._quote(arg) for arg in args) + "\n"
        if len(command.encode("utf-8")) > 4094:
            raise ValueError("Keychain credential exceeds interactive input limit")
        if not self._found(self._run(["-i"], input=command)):
            raise SecretStoreError("Failed to store credential in Keychain")
        if self.get_secret(ref) != secret:
            raise SecretStoreError("Keychain credential write verification failed")

    def delete_secret(self, ref: str | UUID) -> bool:
        self._require_available()
        account = str(ref)
        cmd = [
            "delete-generic-password",
            "-s",
            self._service_name,
            "-a",
            account,
            *self._keychain_args,
        ]
        return self._found(self._run(cmd))

    def list_secret_refs(self) -> tuple[str, ...]:
        self._require_available()
        cmd = [
            "dump-keychain",
            *self._keychain_args,
        ]
        result = self._run(cmd)
        if not self._found(result):
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
