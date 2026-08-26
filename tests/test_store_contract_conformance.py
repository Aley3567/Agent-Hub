"""Shared conformance suite for the ProviderStore contract.

Both the read-only CC Switch adapter and the in-memory test fake must honor the
same behaviors so that tests can be trusted across either backend. This module
runs the same scenario table against both implementations.
"""

import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from claude_hub.ccswitch import CCSwitchProviderStore
from claude_hub.domain import ProviderInspection, ProviderRef, StoreCapability
from claude_hub.testing import IN_MEMORY_STORE_ID, InMemoryProviderStore
from claude_hub.store import (
    ProviderConfigCorruptError,
    ProviderNotFoundError,
    ProviderStoreIncompatibleError,
    ProviderStoreUnavailableError,
)

_PROVIDER_ROWS = [
    {
        "id": "p-1",
        "name": "Official Claude",
        "settings_config": json.dumps(
            {"env": {"ANTHROPIC_MODEL": "claude-3-5-sonnet"}}
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


def _init_adapter_db(path: Path, *, version: int) -> None:
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
    for p in _PROVIDER_ROWS:
        conn.execute(
            """
            INSERT INTO providers (id, name, settings_config, app_type, sort_index, is_current)
            VALUES (?, ?, ?, 'claude', ?, ?)
            """,
            (p["id"], p["name"], p["settings_config"], p["sort_index"], p["is_current"]),
        )
    conn.commit()
    conn.close()


class _Backend:
    """One configured ProviderStore plus the capability it should report."""

    def __init__(self, store, capability: StoreCapability) -> None:
        self.store = store
        self.capability = capability

    def detect(self) -> StoreCapability:
        return self.store.detect()


def _build_backends(temp_dir: Path) -> list[_Backend]:
    good_db = temp_dir / "good.db"
    absent_db = temp_dir / "absent.db"
    corrupt_db = temp_dir / "corrupt.db"
    incompatible_db = temp_dir / "incompatible.db"

    _init_adapter_db(good_db, version=16)
    corrupt_db.write_bytes(b"not a real sqlite database header")
    _init_adapter_db(incompatible_db, version=99)

    good_provider_refs = tuple(
        ProviderRef(
            store=IN_MEMORY_STORE_ID,
            provider_id=p["id"],
            display_name=p["name"],
            is_current=bool(p["is_current"]),
        )
        for p in _PROVIDER_ROWS
    )

    fake_good = InMemoryProviderStore(
        capability=StoreCapability.COMPATIBLE,
        providers=good_provider_refs,
    )
    fake_absent = InMemoryProviderStore(capability=StoreCapability.ABSENT)
    fake_corrupt = InMemoryProviderStore(capability=StoreCapability.CORRUPT)
    fake_incompatible = InMemoryProviderStore(
        capability=StoreCapability.INCOMPATIBLE
    )

    return [
        _Backend(CCSwitchProviderStore(good_db), StoreCapability.COMPATIBLE),
        _Backend(CCSwitchProviderStore(absent_db), StoreCapability.ABSENT),
        _Backend(CCSwitchProviderStore(corrupt_db), StoreCapability.CORRUPT),
        _Backend(
            CCSwitchProviderStore(incompatible_db), StoreCapability.INCOMPATIBLE
        ),
        _Backend(fake_good, StoreCapability.COMPATIBLE),
        _Backend(fake_absent, StoreCapability.ABSENT),
        _Backend(fake_corrupt, StoreCapability.CORRUPT),
        _Backend(fake_incompatible, StoreCapability.INCOMPATIBLE),
    ]


class StoreContractConformanceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.backends = _build_backends(Path(self.temp_dir.name))

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_detect_reports_configured_capability(self) -> None:
        for backend in self.backends:
            with self.subTest(capability=backend.capability):
                self.assertEqual(backend.store.detect(), backend.capability)

    def test_good_backends_list_and_inspect(self) -> None:
        for backend in self.backends:
            if backend.capability is not StoreCapability.COMPATIBLE:
                continue
            with self.subTest(backend=type(backend.store).__name__):
                refs = backend.store.list()
                self.assertEqual(len(refs), 2)
                # Returned references must be immutable and store-bound.
                first = refs[0]
                self.assertIsInstance(first.store, str)
                self.assertTrue(first.store)
                inspection = backend.store.inspect(first)
                self.assertIsInstance(inspection, ProviderInspection)
                self.assertEqual(inspection.reference.provider_id, first.provider_id)

    def test_unknown_provider_raises_not_found(self) -> None:
        for backend in self.backends:
            if backend.capability is not StoreCapability.COMPATIBLE:
                continue
            with self.subTest(backend=type(backend.store).__name__):
                ref = ProviderRef(
                    store="cc-switch", provider_id="does-not-exist"
                )
                with self.assertRaises(ProviderNotFoundError):
                    backend.store.inspect(ref)

    def test_wrong_store_reference_rejected(self) -> None:
        for backend in self.backends:
            if backend.capability is not StoreCapability.COMPATIBLE:
                continue
            with self.subTest(backend=type(backend.store).__name__):
                ref = ProviderRef(store="foreign-store", provider_id="p-1")
                with self.assertRaises(ProviderNotFoundError):
                    backend.store.inspect(ref)

    def test_capability_gates_map_to_distinct_errors(self) -> None:
        cases = [
            (StoreCapability.ABSENT, ProviderStoreUnavailableError),
            (StoreCapability.CORRUPT, ProviderConfigCorruptError),
            (StoreCapability.INCOMPATIBLE, ProviderStoreIncompatibleError),
        ]
        for backend in self.backends:
            for capability, error_type in cases:
                if backend.capability is not capability:
                    continue
                with self.subTest(
                    backend=type(backend.store).__name__, capability=capability
                ):
                    with self.assertRaises(error_type):
                        backend.store.list()
                    with self.assertRaises(error_type):
                        backend.store.inspect(
                            ProviderRef(store="cc-switch", provider_id="p-1")
                        )


if __name__ == "__main__":
    unittest.main()
