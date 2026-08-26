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


if __name__ == "__main__":
    unittest.main()
