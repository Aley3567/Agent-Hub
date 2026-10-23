"""Tests for credentials and system secret store security boundaries."""

import sys
import unittest
from pathlib import Path
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from claude_hub.credentials import (
    InMemorySecretStore,
    SecretStoreUnavailableError,
    build_default_secret_store,
)


class CredentialsTests(unittest.TestCase):
    def test_in_memory_secret_store_crud(self) -> None:
        store = InMemorySecretStore()
        self.assertTrue(store.is_available())

        ref1 = uuid4()
        ref2 = uuid4()
        token1 = "test_val_secret_key_1111"  # secret-guard: allow generic-secret-assignment
        token2 = "test_val_secret_key_2222"  # secret-guard: allow generic-secret-assignment

        store.set_secret(ref1, token1)
        store.set_secret(ref2, token2)

        self.assertEqual(store.get_secret(ref1), token1)
        self.assertEqual(store.get_secret(ref2), token2)
        self.assertEqual(len(store.list_secret_refs()), 2)

        deleted = store.delete_secret(ref1)
        self.assertTrue(deleted)
        self.assertIsNone(store.get_secret(ref1))
        self.assertEqual(len(store.list_secret_refs()), 1)

    def test_unavailable_secret_store_fails_closed(self) -> None:
        store = InMemorySecretStore(available=False)
        self.assertFalse(store.is_available())

        ref = uuid4()
        with self.assertRaises(SecretStoreUnavailableError):
            store.set_secret(ref, "test_val_secret_key_3333")  # secret-guard: allow generic-secret-assignment

        with self.assertRaises(SecretStoreUnavailableError):
            store.get_secret(ref)

        with self.assertRaises(SecretStoreUnavailableError):
            store.delete_secret(ref)

        with self.assertRaises(SecretStoreUnavailableError):
            store.list_secret_refs()

    def test_invalid_secret_input_raises(self) -> None:
        store = InMemorySecretStore()
        ref = uuid4()
        with self.assertRaises(ValueError):
            store.set_secret(ref, "")  # empty string

        with self.assertRaises(ValueError):
            store.set_secret(ref, None)  # type: ignore


class MacOSKeychainBoundaryTests(unittest.TestCase):
    def _read_result(self, cmd, value):
        import subprocess
        raw = value.encode()
        printable = all(32 <= b <= 126 and b != 92 for b in raw)
        if "-g" in cmd:
            representation = f'"{value}"' if printable else f'0x{raw.hex()}  "display-only"'
            return subprocess.CompletedProcess(cmd, 0, "item metadata\n", f"password: {representation}\n")
        output = value if all(32 <= b <= 126 for b in raw) else raw.hex()
        return subprocess.CompletedProcess(cmd, 0, output + "\n", "")

    def test_reads_unicode_controls_and_literal_hex_without_guessing(self):
        from unittest.mock import patch
        from claude_hub.credentials import MacOSKeychainStore
        store = MacOSKeychainStore()
        for value in ["fixture 中文", "fixture\ntrailing\n", 'fixture "quotes"',
                      "fixture \\ slash", "deadbeef01234567", "  fixture  "]:
            with self.subTest(value=value), patch.object(store, "is_available", return_value=True), patch(
                    "claude_hub.credentials.subprocess.run",
                    side_effect=lambda cmd, **kwargs: self._read_result(cmd, value)):
                self.assertEqual(store.get_secret(uuid4()), value)

    def test_only_missing_is_none_or_false_and_permission_errors_propagate(self):
        import subprocess
        from unittest.mock import patch
        from claude_hub.credentials import MacOSKeychainStore, SecretStorePermissionError, SecretStoreUnavailableError
        store = MacOSKeychainStore()
        for method in [store.get_secret, store.delete_secret]:
            for code, error in [(44, None), (51, SecretStorePermissionError),
                                (128, SecretStorePermissionError), (36, SecretStorePermissionError),
                                (1, SecretStoreUnavailableError)]:
                result = subprocess.CompletedProcess([], code, "", "private-backend-fixture")
                with self.subTest(method=method.__name__, code=code), patch.object(
                        store, "is_available", return_value=True), patch(
                        "claude_hub.credentials.subprocess.run", return_value=result):
                    if error:
                        with self.assertRaises(error) as caught:
                            method(uuid4())
                        self.assertNotIn("private-backend-fixture", str(caught.exception))
                    else:
                        self.assertIn(method(uuid4()), (None, False))

    def test_write_requires_matching_readback(self):
        import subprocess
        from unittest.mock import patch
        from claude_hub.credentials import MacOSKeychainStore, SecretStoreError
        store = MacOSKeychainStore()
        with patch.object(store, "is_available", return_value=True), patch.object(
                store, "get_secret", return_value="different-fixture"), patch(
                "claude_hub.credentials.subprocess.run", return_value=subprocess.CompletedProcess([], 0, "", "")):
            with self.assertRaises(SecretStoreError):
                store.set_secret(uuid4(), "selected-fixture")

    def test_read_timeout_is_sanitized(self):
        import subprocess
        from unittest.mock import patch
        from claude_hub.credentials import MacOSKeychainStore, SecretStoreUnavailableError
        store = MacOSKeychainStore()
        with patch.object(store, "is_available", return_value=True), patch(
                "claude_hub.credentials.subprocess.run",
                side_effect=subprocess.TimeoutExpired(["private-fixture"], 15, output="private-fixture")):
            with self.assertRaises(SecretStoreUnavailableError) as caught:
                store.get_secret(uuid4())
            self.assertNotIn("private-fixture", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
