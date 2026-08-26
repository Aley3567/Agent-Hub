"""Read-only CC Switch provider store SQLite adapter tests."""

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from claude_hub.ccswitch import (
    CCSwitchProviderStore,
    resolve_ccswitch_database_path,
    stable_provider_id,
)
from claude_hub.domain import ProviderRef, StoreCapability
from claude_hub.store import (
    ProviderConfigCorruptError,
    ProviderNotFoundError,
    ProviderStoreIncompatibleError,
    ProviderStoreUnavailableError,
)


def _init_test_db(
    path: Path,
    *,
    version: int = 16,
    providers: list[dict[str, object]] | None = None,
    with_proxy_config: bool = False,
    live_takeover: int = 0,
) -> None:
    if path.exists():
        path.unlink()
    conn = sqlite3.connect(path)
    conn.execute(f"PRAGMA user_version = {version}")
    conn.execute(
        """
        CREATE TABLE providers (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            settings_config TEXT NOT NULL,
            app_type TEXT NOT NULL,
            sort_index INTEGER DEFAULT 0,
            is_current INTEGER DEFAULT 0
        )
        """
    )
    if with_proxy_config:
        conn.execute(
            """
            CREATE TABLE proxy_config (
                app_type TEXT PRIMARY KEY,
                live_takeover_active INTEGER DEFAULT 0
            )
            """
        )
        conn.execute(
            "INSERT INTO proxy_config (app_type, live_takeover_active) VALUES ('claude', ?)",
            (live_takeover,),
        )

    if providers is not None:
        for p in providers:
            conn.execute(
                """
                INSERT INTO providers (id, name, settings_config, app_type, sort_index, is_current)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    p["id"],
                    p["name"],
                    p["settings_config"],
                    p.get("app_type", "claude"),
                    p.get("sort_index", 0),
                    p.get("is_current", 0),
                ),
            )
    conn.commit()
    conn.close()


class CCSwitchStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "cc-switch.db"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_path_resolution(self) -> None:
        explicit = Path("/tmp/custom.db")
        self.assertEqual(resolve_ccswitch_database_path(explicit), explicit)

        env_path = resolve_ccswitch_database_path(
            environ={"CLAUDE_HUB_CC_SWITCH_DB": "/custom/env.db"}
        )
        self.assertEqual(env_path, Path("/custom/env.db"))

    def test_detect_absent_when_file_not_found(self) -> None:
        store = CCSwitchProviderStore(self.db_path)
        self.assertEqual(store.detect(), StoreCapability.ABSENT)

    def test_detect_corrupt_when_empty_file(self) -> None:
        self.db_path.touch()
        store = CCSwitchProviderStore(self.db_path)
        self.assertEqual(store.detect(), StoreCapability.CORRUPT)

    def test_detect_corrupt_when_invalid_sqlite(self) -> None:
        self.db_path.write_bytes(b"not a real sqlite database header")
        store = CCSwitchProviderStore(self.db_path)
        self.assertEqual(store.detect(), StoreCapability.CORRUPT)

    def test_detect_compatible_versions(self) -> None:
        _init_test_db(self.db_path, version=16)
        store = CCSwitchProviderStore(self.db_path)
        self.assertEqual(store.detect(), StoreCapability.COMPATIBLE)

    def test_detect_read_only_versions(self) -> None:
        _init_test_db(self.db_path, version=13)
        store = CCSwitchProviderStore(self.db_path)
        self.assertEqual(store.detect(), StoreCapability.READ_ONLY)

        _init_test_db(self.db_path, version=15)
        store = CCSwitchProviderStore(self.db_path)
        self.assertEqual(store.detect(), StoreCapability.READ_ONLY)

    def test_detect_incompatible_version(self) -> None:
        _init_test_db(self.db_path, version=99)
        store = CCSwitchProviderStore(self.db_path)
        self.assertEqual(store.detect(), StoreCapability.INCOMPATIBLE)

        _init_test_db(self.db_path, version=12)
        store = CCSwitchProviderStore(self.db_path)
        self.assertEqual(store.detect(), StoreCapability.INCOMPATIBLE)

    def test_detect_incompatible_schema_missing_columns(self) -> None:
        conn = sqlite3.connect(self.db_path)
        conn.execute("PRAGMA user_version = 16")
        conn.execute("CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT)")
        conn.commit()
        conn.close()

        store = CCSwitchProviderStore(self.db_path)
        self.assertEqual(store.detect(), StoreCapability.INCOMPATIBLE)

    def test_detect_operational_error_returns_unavailable_not_corrupt(self) -> None:
        _init_test_db(self.db_path, version=16)
        store = CCSwitchProviderStore(self.db_path)
        with patch("claude_hub.ccswitch._readonly_connection", side_effect=sqlite3.OperationalError("database is locked")):
            # Lock contention must NOT report CORRUPT or ABSENT
            self.assertEqual(store.detect(), StoreCapability.UNAVAILABLE)

    @unittest.skipIf(not hasattr(os, "geteuid") or os.geteuid() == 0, "requires non-root")
    def test_detect_locked_database_is_unavailable(self) -> None:
        _init_test_db(self.db_path, version=16)
        holder = sqlite3.connect(self.db_path)
        try:
            holder.execute("BEGIN EXCLUSIVE")
            store = CCSwitchProviderStore(self.db_path)
            self.assertEqual(store.detect(), StoreCapability.UNAVAILABLE)
            with self.assertRaises(ProviderStoreUnavailableError):
                store.list()
        finally:
            holder.rollback()
            holder.close()

    @unittest.skipIf(not hasattr(os, "geteuid") or os.geteuid() == 0, "requires non-root")
    def test_detect_permission_denied_file_is_unavailable(self) -> None:
        _init_test_db(self.db_path, version=16)
        os.chmod(self.db_path, 0o000)
        try:
            store = CCSwitchProviderStore(self.db_path)
            self.assertEqual(store.detect(), StoreCapability.UNAVAILABLE)
        finally:
            os.chmod(self.db_path, 0o600)

    @unittest.skipIf(not hasattr(os, "geteuid") or os.geteuid() == 0, "requires non-root")
    def test_detect_permission_denied_parent_dir_is_unavailable(self) -> None:
        _init_test_db(self.db_path, version=16)
        os.chmod(self.temp_dir.name, 0o600)
        try:
            store = CCSwitchProviderStore(self.db_path)
            self.assertEqual(store.detect(), StoreCapability.UNAVAILABLE)
        finally:
            os.chmod(self.temp_dir.name, 0o700)

    def test_list_operational_error_raises_unavailable_not_corrupt(self) -> None:
        _init_test_db(self.db_path, version=16)
        store = CCSwitchProviderStore(self.db_path)
        with patch.object(CCSwitchProviderStore, "detect", return_value=StoreCapability.COMPATIBLE):
            with patch("claude_hub.ccswitch._readonly_connection", side_effect=sqlite3.OperationalError("database is locked")):
                with self.assertRaises(ProviderStoreUnavailableError):
                    store.list()

    def test_list_and_inspect_providers(self) -> None:
        providers = [
            {
                "id": "p-1",
                "name": "Official Claude",
                "settings_config": json.dumps(
                    {
                        "env": {
                            "ANTHROPIC_MODEL": "claude-3-5-sonnet",
                            "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-3-5-haiku",
                        }
                    }
                ),
                "is_current": 1,
                "sort_index": 0,
            },
            {
                "id": "p-2",
                "name": "Fallback Provider",
                "settings_config": json.dumps({"env": {}}),
                "is_current": 0,
                "sort_index": 1,
            },
        ]
        _init_test_db(
            self.db_path,
            version=16,
            providers=providers,
            with_proxy_config=True,
            live_takeover=1,
        )

        store = CCSwitchProviderStore(self.db_path)
        provider_list = store.list()
        self.assertEqual(len(provider_list), 2)
        # Golden pin: the derivation algorithm must not drift silently.
        self.assertEqual(stable_provider_id("p-1"), "607ea439bdc44fc6")
        self.assertEqual(provider_list[0].provider_id, stable_provider_id("p-1"))
        self.assertNotEqual(provider_list[0].provider_id, "p-1")
        self.assertEqual(provider_list[0].display_name, "Official Claude")
        self.assertTrue(provider_list[0].is_current)
        self.assertEqual(provider_list[1].provider_id, stable_provider_id("p-2"))
        self.assertFalse(provider_list[1].is_current)

        # Inspect p-1 via its derived stable reference
        inspection = store.inspect(provider_list[0])
        self.assertEqual(inspection.reference.provider_id, stable_provider_id("p-1"))
        self.assertEqual(inspection.models.default, "claude-3-5-sonnet")
        self.assertEqual(inspection.models.fast, "claude-3-5-haiku")
        self.assertTrue(inspection.is_current)
        self.assertTrue(inspection.proxy_takeover)
        self.assertEqual(inspection.schema_capability, StoreCapability.COMPATIBLE)

    def test_inspect_not_found(self) -> None:
        _init_test_db(self.db_path, version=16, providers=[])
        store = CCSwitchProviderStore(self.db_path)
        ref = ProviderRef(store="cc-switch", provider_id="missing-p")
        with self.assertRaises(ProviderNotFoundError):
            store.inspect(ref)

    def test_inspect_corrupt_settings_config_raises(self) -> None:
        providers = [
            {
                "id": "p-bad",
                "name": "Bad JSON",
                "settings_config": "not-valid-json{",
                "is_current": 0,
            }
        ]
        _init_test_db(self.db_path, version=16, providers=providers)
        store = CCSwitchProviderStore(self.db_path)
        ref = ProviderRef(store="cc-switch", provider_id=stable_provider_id("p-bad"))
        with self.assertRaises(ProviderConfigCorruptError):
            store.inspect(ref)

    def test_inspect_oversized_settings_config_raises(self) -> None:
        providers = [
            {
                "id": "p-huge",
                "name": "Huge JSON",
                "settings_config": " " * (4 * 1024 * 1024 + 10),
                "is_current": 0,
            }
        ]
        _init_test_db(self.db_path, version=16, providers=providers)
        store = CCSwitchProviderStore(self.db_path)
        ref = ProviderRef(store="cc-switch", provider_id=stable_provider_id("p-huge"))
        with self.assertRaises(ProviderConfigCorruptError):
            store.inspect(ref)

    def test_list_raises_when_store_absent(self) -> None:
        store = CCSwitchProviderStore(Path(self.temp_dir.name) / "non-existent.db")
        with self.assertRaises(ProviderStoreUnavailableError):
            store.list()


if __name__ == "__main__":
    unittest.main()
