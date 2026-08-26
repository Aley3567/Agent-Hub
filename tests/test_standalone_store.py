"""Tests for StandaloneProfileStore and filesystem metadata persistence."""

import json
import os
import stat
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from claude_hub.domain import ModelMapping, ProtocolAdapter, StandaloneProfile
from claude_hub.standalone import (
    SCHEMA_VERSION,
    StandaloneProfileConflictError,
    StandaloneProfileExistsError,
    StandaloneProfileNotFoundError,
    StandaloneProfileStore,
    StandaloneStoreCorruptError,
    UnsupportedStandaloneSchemaError,
    standalone_data_dir,
)


class StandaloneStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.data_dir = Path(self.temp_dir.name)
        self.store = StandaloneProfileStore(self.data_dir)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_standalone_data_dir_resolution(self) -> None:
        home = "/home/testuser"
        macos_dir = standalone_data_dir("darwin", home=home)
        self.assertEqual(
            macos_dir,
            Path("/home/testuser/Library/Application Support/claude-hub"),
        )

        linux_dir = standalone_data_dir("linux", home=home)
        self.assertEqual(
            linux_dir,
            Path("/home/testuser/.local/share/claude-hub"),
        )

        win_dir = standalone_data_dir(
            "windows",
            home=home,
            environment={"LOCALAPPDATA": "/c/AppData/Local"},
        )
        self.assertEqual(
            win_dir,
            Path("/c/AppData/Local/claude-hub"),
        )

    def test_create_and_get_profile(self) -> None:
        p_id = uuid4()
        s_ref = uuid4()
        now = datetime.now(timezone.utc)
        profile = StandaloneProfile(
            profile_id=p_id,
            name="My Claude Provider",
            base_url="https://api.example.com/v1",
            adapter=ProtocolAdapter.ANTHROPIC,
            secret_ref=s_ref,
            created_at=now,
            updated_at=now,
            models=ModelMapping(default="claude-3-5-sonnet", fast="claude-3-5-haiku"),
        )

        created = self.store.create(profile)
        self.assertEqual(created.profile_id, p_id)
        self.assertTrue(self.store.store_path.exists())

        fetched = self.store.get(p_id)
        self.assertEqual(fetched.name, "My Claude Provider")
        self.assertEqual(fetched.base_url, "https://api.example.com/v1")
        self.assertEqual(fetched.adapter, ProtocolAdapter.ANTHROPIC)
        self.assertEqual(fetched.models.default, "claude-3-5-sonnet")
        self.assertEqual(fetched.models.fast, "claude-3-5-haiku")
        self.assertEqual(fetched.secret_ref, s_ref)

    def test_permissions_enforcement(self) -> None:
        now = datetime.now(timezone.utc)
        profile = StandaloneProfile(
            profile_id=uuid4(),
            name="Perm Profile",
            base_url="https://api.example.com/v1",
            adapter=ProtocolAdapter.ANTHROPIC,
            secret_ref=uuid4(),
            created_at=now,
            updated_at=now,
        )
        self.store.create(profile)

        # On POSIX systems, check mode
        if os.name == "posix":
            file_mode = stat.S_IMODE(self.store.store_path.stat().st_mode)
            dir_mode = stat.S_IMODE(self.data_dir.stat().st_mode)
            self.assertEqual(file_mode, 0o600)
            self.assertEqual(dir_mode, 0o700)

    def test_list_and_get_by_name(self) -> None:
        now = datetime.now(timezone.utc)
        p1 = StandaloneProfile(
            profile_id=uuid4(),
            name="Beta Profile",
            base_url="https://api.beta.com",
            adapter=ProtocolAdapter.ANTHROPIC,
            secret_ref=uuid4(),
            created_at=now,
            updated_at=now,
        )
        p2 = StandaloneProfile(
            profile_id=uuid4(),
            name="Alpha Profile",
            base_url="https://api.alpha.com",
            adapter=ProtocolAdapter.OPENAI_CHAT,
            secret_ref=uuid4(),
            created_at=now,
            updated_at=now,
        )
        self.store.create(p1)
        self.store.create(p2)

        profiles = self.store.list()
        self.assertEqual(len(profiles), 2)
        self.assertEqual(profiles[0].name, "Alpha Profile")
        self.assertEqual(profiles[1].name, "Beta Profile")

        found = self.store.get_by_name("alpha profile")
        self.assertIsNotNone(found)
        self.assertEqual(found.profile_id, p2.profile_id)

    def test_duplicate_name_conflict(self) -> None:
        now = datetime.now(timezone.utc)
        p1 = StandaloneProfile(
            profile_id=uuid4(),
            name="Unique Name",
            base_url="https://api.one.com",
            adapter=ProtocolAdapter.ANTHROPIC,
            secret_ref=uuid4(),
            created_at=now,
            updated_at=now,
        )
        p2 = StandaloneProfile(
            profile_id=uuid4(),
            name="unique name",
            base_url="https://api.two.com",
            adapter=ProtocolAdapter.ANTHROPIC,
            secret_ref=uuid4(),
            created_at=now,
            updated_at=now,
        )
        self.store.create(p1)
        with self.assertRaises(StandaloneProfileConflictError):
            self.store.create(p2)

    def test_update_profile(self) -> None:
        p_id = uuid4()
        s_ref = uuid4()
        now = datetime.now(timezone.utc)
        p = StandaloneProfile(
            profile_id=p_id,
            name="Orig Name",
            base_url="https://api.orig.com",
            adapter=ProtocolAdapter.ANTHROPIC,
            secret_ref=s_ref,
            created_at=now,
            updated_at=now,
        )
        self.store.create(p)

        later = datetime.now(timezone.utc)
        updated = StandaloneProfile(
            profile_id=p_id,
            name="New Name",
            base_url="https://api.new.com",
            adapter=ProtocolAdapter.OPENAI_CHAT,
            secret_ref=s_ref,
            created_at=now,
            updated_at=later,
        )
        self.store.update(updated)

        fetched = self.store.get(p_id)
        self.assertEqual(fetched.name, "New Name")
        self.assertEqual(fetched.base_url, "https://api.new.com")
        self.assertEqual(fetched.adapter, ProtocolAdapter.OPENAI_CHAT)

    def test_delete_profile(self) -> None:
        now = datetime.now(timezone.utc)
        p = StandaloneProfile(
            profile_id=uuid4(),
            name="To Delete",
            base_url="https://api.del.com",
            adapter=ProtocolAdapter.ANTHROPIC,
            secret_ref=uuid4(),
            created_at=now,
            updated_at=now,
        )
        self.store.create(p)
        self.assertTrue(self.store.exists(p.profile_id))

        self.store.delete(p.profile_id)
        self.assertFalse(self.store.exists(p.profile_id))
        with self.assertRaises(StandaloneProfileNotFoundError):
            self.store.get(p.profile_id)

    def test_corrupt_store_file_raises(self) -> None:
        self.store.store_path.parent.mkdir(parents=True, exist_ok=True)
        self.store.store_path.write_text("not json{", encoding="utf-8")
        with self.assertRaises(StandaloneStoreCorruptError):
            self.store.list()

    def test_unsupported_schema_version_raises(self) -> None:
        self.store.store_path.parent.mkdir(parents=True, exist_ok=True)
        doc = {"schemaVersion": 99, "profiles": {}}
        self.store.store_path.write_text(json.dumps(doc), encoding="utf-8")
        with self.assertRaises(UnsupportedStandaloneSchemaError):
            self.store.list()


if __name__ == "__main__":
    unittest.main()
