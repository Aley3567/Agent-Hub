"""Mode routing and startup view resolution tests."""

import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from claude_hub.domain import RuntimeMode, StoreCapability
from claude_hub.routing import (
    FirstScreen,
    StartupRoute,
    first_screen_for_mode,
    resolve_runtime_mode,
    resolve_startup_route,
)
from claude_hub.store import ProviderStoreUnavailableError


class ModeRoutingTests(unittest.TestCase):
    def test_companion_mode_when_store_can_read(self) -> None:
        self.assertEqual(
            resolve_runtime_mode(StoreCapability.COMPATIBLE, standalone_exists=False),
            RuntimeMode.COMPANION,
        )
        self.assertEqual(
            resolve_runtime_mode(StoreCapability.READ_ONLY, standalone_exists=False),
            RuntimeMode.COMPANION,
        )

    def test_standalone_or_empty_when_store_absent(self) -> None:
        self.assertEqual(
            resolve_runtime_mode(StoreCapability.ABSENT, standalone_exists=False),
            RuntimeMode.EMPTY,
        )
        self.assertEqual(
            resolve_runtime_mode(StoreCapability.ABSENT, standalone_exists=True),
            RuntimeMode.STANDALONE,
        )

    def test_incompatible_when_store_incompatible_or_corrupt(self) -> None:
        self.assertEqual(
            resolve_runtime_mode(StoreCapability.INCOMPATIBLE, standalone_exists=False),
            RuntimeMode.INCOMPATIBLE,
        )
        self.assertEqual(
            resolve_runtime_mode(StoreCapability.CORRUPT, standalone_exists=True),
            RuntimeMode.INCOMPATIBLE,
        )

    def test_explicit_standalone_override(self) -> None:
        self.assertEqual(
            resolve_runtime_mode(
                StoreCapability.COMPATIBLE,
                standalone_exists=True,
                store_override="standalone",
            ),
            RuntimeMode.STANDALONE,
        )
        self.assertEqual(
            resolve_runtime_mode(
                StoreCapability.INCOMPATIBLE,
                standalone_exists=False,
                store_override="standalone",
            ),
            RuntimeMode.EMPTY,
        )

    def test_invalid_override_raises(self) -> None:
        with self.assertRaises(ValueError):
            resolve_runtime_mode(
                StoreCapability.COMPATIBLE,
                standalone_exists=False,
                store_override="invalid-override",
            )

    def test_unavailable_store_fails_closed(self) -> None:
        with self.assertRaises(ProviderStoreUnavailableError):
            resolve_runtime_mode(StoreCapability.UNAVAILABLE, standalone_exists=False)
        with self.assertRaises(ProviderStoreUnavailableError):
            resolve_runtime_mode(StoreCapability.UNAVAILABLE, standalone_exists=True)
        with self.assertRaises(ProviderStoreUnavailableError):
            resolve_startup_route(StoreCapability.UNAVAILABLE, standalone_exists=False)

    def test_explicit_standalone_override_beats_unavailable_probe(self) -> None:
        self.assertEqual(
            resolve_runtime_mode(
                StoreCapability.UNAVAILABLE,
                standalone_exists=True,
                store_override="standalone",
            ),
            RuntimeMode.STANDALONE,
        )

    def test_first_screen_mapping(self) -> None:
        self.assertEqual(
            first_screen_for_mode(RuntimeMode.COMPANION),
            FirstScreen.PROVIDER_LIST,
        )
        self.assertEqual(
            first_screen_for_mode(RuntimeMode.STANDALONE),
            FirstScreen.PROFILE_LIST,
        )
        self.assertEqual(
            first_screen_for_mode(RuntimeMode.EMPTY),
            FirstScreen.QUICK_SETUP,
        )
        self.assertEqual(
            first_screen_for_mode(RuntimeMode.INCOMPATIBLE),
            FirstScreen.INCOMPATIBLE_ERROR,
        )

    def test_resolve_startup_route(self) -> None:
        route = resolve_startup_route(
            StoreCapability.COMPATIBLE,
            standalone_exists=False,
        )
        self.assertEqual(
            route,
            StartupRoute(
                mode=RuntimeMode.COMPANION,
                first_screen=FirstScreen.PROVIDER_LIST,
            ),
        )


if __name__ == "__main__":
    unittest.main()
