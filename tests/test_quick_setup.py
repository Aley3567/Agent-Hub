"""Tests for quick setup profile lifecycle and transactional rollback."""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from claude_hub.credentials import InMemorySecretStore
from claude_hub.domain import ModelMapping, ProtocolAdapter
from claude_hub.quick_setup import (
    audit_orphan_secrets,
    cleanup_orphan_secrets,
    create_standalone_profile,
    delete_standalone_profile,
)
from claude_hub.standalone import (
    StandaloneProfileConflictError,
    StandaloneProfileStore,
)


class QuickSetupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        self.profile_store = StandaloneProfileStore(self.data_dir)
        self.secret_store = InMemorySecretStore()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_create_standalone_profile_success(self) -> None:
        profile = create_standalone_profile(
            self.profile_store,
            self.secret_store,
            name="Primary Channel",
            base_url="https://api.primary.com/v1",
            secret="mock_secret_key_val_1111",  # secret-guard: allow generic-secret-assignment
            models=ModelMapping(default="claude-3-5-sonnet"),
        )
        self.assertEqual(profile.name, "Primary Channel")
        self.assertTrue(self.profile_store.exists(profile.profile_id))
        self.assertEqual(
            self.secret_store.get_secret(profile.secret_ref),
            "mock_secret_key_val_1111",  # secret-guard: allow generic-secret-assignment
        )

    def test_create_standalone_profile_rollback_on_failure(self) -> None:
        # Create first profile
        create_standalone_profile(
            self.profile_store,
            self.secret_store,
            name="Conflicting Name",
            base_url="https://api.one.com/v1",
            secret="mock_secret_key_val_2222",  # secret-guard: allow generic-secret-assignment
        )
        initial_secret_count = len(self.secret_store.list_secret_refs())

        # Attempt to create duplicate name profile (should raise and rollback secret)
        with self.assertRaises(StandaloneProfileConflictError):
            create_standalone_profile(
                self.profile_store,
                self.secret_store,
                name="conflicting name",
                base_url="https://api.two.com/v1",
                secret="mock_secret_key_val_3333",  # secret-guard: allow generic-secret-assignment
            )

        # Ensure no orphan secret leaked into secret_store
        self.assertEqual(len(self.secret_store.list_secret_refs()), initial_secret_count)

    def test_delete_profile_and_purge_secret(self) -> None:
        profile = create_standalone_profile(
            self.profile_store,
            self.secret_store,
            name="To Purge",
            base_url="https://api.purge.com/v1",
            secret="mock_secret_key_val_4444",  # secret-guard: allow generic-secret-assignment
        )
        self.assertIsNotNone(self.secret_store.get_secret(profile.secret_ref))

        deleted = delete_standalone_profile(
            self.profile_store,
            self.secret_store,
            profile.profile_id,
            purge_secret=True,
        )
        self.assertTrue(deleted)
        self.assertFalse(self.profile_store.exists(profile.profile_id))
        self.assertIsNone(self.secret_store.get_secret(profile.secret_ref))

    def test_audit_and_cleanup_orphan_secrets(self) -> None:
        profile = create_standalone_profile(
            self.profile_store,
            self.secret_store,
            name="Active Profile",
            base_url="https://api.active.com/v1",
            secret="mock_secret_key_val_5555",  # secret-guard: allow generic-secret-assignment
        )
        # Inject an orphan secret
        orphan_ref = uuid4()
        self.secret_store.set_secret(orphan_ref, "orphan_secret_token_val_6666")  # secret-guard: allow generic-secret-assignment

        orphans = audit_orphan_secrets(self.profile_store, self.secret_store)
        self.assertEqual(orphans, (str(orphan_ref),))

        purged = cleanup_orphan_secrets(self.profile_store, self.secret_store)
        self.assertEqual(purged, (str(orphan_ref),))
        self.assertEqual(len(audit_orphan_secrets(self.profile_store, self.secret_store)), 0)
        self.assertIsNotNone(self.secret_store.get_secret(profile.secret_ref))


if __name__ == "__main__":
    unittest.main()
