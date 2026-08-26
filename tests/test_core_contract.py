"""Core domain DTO and store contract tests."""

import dataclasses
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from claude_hub.domain import (
    ModelMapping,
    ProviderInspection,
    ProviderRef,
    RuntimeMode,
    StoreCapability,
)
from claude_hub.service import ProviderApplicationService
from claude_hub.store import ProviderNotFoundError
from claude_hub.testing import InMemoryProviderStore


class CoreContractTests(unittest.TestCase):
    def test_provider_ref_immutability(self) -> None:
        ref = ProviderRef(store="cc-switch", provider_id="prov-1", display_name="Test Provider")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            ref.provider_id = "prov-2"  # type: ignore

    def test_provider_ref_validation(self) -> None:
        with self.assertRaises(ValueError):
            ProviderRef(store="cc-switch", provider_id="forbidden-bearer-token")
        with self.assertRaises(ValueError):
            ProviderRef(store="cc-switch", provider_id="https://example.com/api")
        with self.assertRaises(ValueError):
            ProviderRef(store="cc-switch", provider_id="has\ncontrol")
        with self.assertRaises(ValueError):
            ProviderRef(store="cc-switch", provider_id="")

    def test_provider_ref_repr_sanitization(self) -> None:
        ref = ProviderRef(store="cc-switch", provider_id="prov-1", display_name="SensitiveName")
        repr_str = repr(ref)
        self.assertIn("<redacted>", repr_str)
        self.assertNotIn("prov-1", repr_str)

    def test_model_mapping_immutability_and_slots(self) -> None:
        mapping = ModelMapping(default="claude-3-5-sonnet", fast="claude-3-5-haiku")
        with self.assertRaises(dataclasses.FrozenInstanceError):
            mapping.default = "other-model"  # type: ignore
        self.assertEqual(mapping.configured_slots, ("default", "fast"))
        self.assertEqual(
            mapping.to_public_dict(),
            {"default": "claude-3-5-sonnet", "fast": "claude-3-5-haiku"},
        )

    def test_model_mapping_validation(self) -> None:
        with self.assertRaises(ValueError):
            ModelMapping(default="forbidden-bearer-token")

    def test_provider_inspection_immutability_and_repr(self) -> None:
        ref = ProviderRef(store="cc-switch", provider_id="prov-1")
        models = ModelMapping(default="claude-sonnet")
        inspection = ProviderInspection(
            reference=ref,
            models=models,
            is_current=True,
            fingerprint="a" * 64,
            proxy_takeover=False,
            schema_capability=StoreCapability.COMPATIBLE,
            unknown_field_count=0,
            unknown_fingerprint="b" * 64,
        )
        with self.assertRaises(dataclasses.FrozenInstanceError):
            inspection.is_current = False  # type: ignore
        self.assertIn("reference", repr(inspection))

    def test_in_memory_provider_store_and_service(self) -> None:
        p1 = ProviderRef(store="in-memory", provider_id="p1", display_name="Provider 1")
        p2 = ProviderRef(store="in-memory", provider_id="p2", display_name="Provider 2", is_current=True)
        fake_store = InMemoryProviderStore(
            capability=StoreCapability.COMPATIBLE,
            providers=[p1, p2],
        )
        service = ProviderApplicationService(fake_store)
        self.assertEqual(service.detect(), StoreCapability.COMPATIBLE)
        self.assertEqual(service.list(), (p1, p2))
        self.assertEqual(service.inspect(p1).reference, p1)
        self.assertEqual(service.inspect_stable_id("p2", store_name="in-memory").reference, p2)

        with self.assertRaises(ProviderNotFoundError):
            service.inspect_stable_id("non-existent", store_name="in-memory")
        with self.assertRaises(ProviderNotFoundError):
            service.inspect(ProviderRef(store="other-store", provider_id="p1"))


if __name__ == "__main__":
    unittest.main()
