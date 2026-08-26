"""Pure startup-mode and first-screen resolution shared by CLI and UI."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from .domain import RuntimeMode, StoreCapability
from .store import ProviderStoreUnavailableError


class FirstScreen(str, Enum):
    PROVIDER_LIST = "provider_list"
    PROFILE_LIST = "profile_list"
    QUICK_SETUP = "quick_setup"
    INCOMPATIBLE_ERROR = "incompatible_error"


@dataclass(frozen=True, slots=True)
class StartupRoute:
    mode: RuntimeMode
    first_screen: FirstScreen


def resolve_runtime_mode(
    cc_switch_capability: StoreCapability,
    *,
    standalone_exists: bool,
    store_override: str | None = None,
) -> RuntimeMode:
    """Resolve runtime mode from durable store facts."""

    if not isinstance(cc_switch_capability, StoreCapability):
        raise TypeError("cc_switch_capability must be a StoreCapability")
    if not isinstance(standalone_exists, bool):
        raise TypeError("standalone_exists must be a bool")
    if store_override not in (None, "standalone"):
        raise ValueError("unsupported store override")

    if store_override == "standalone":
        return (
            RuntimeMode.STANDALONE
            if standalone_exists
            else RuntimeMode.EMPTY
        )
    if cc_switch_capability.can_read:
        return RuntimeMode.COMPANION
    if cc_switch_capability in {
        StoreCapability.INCOMPATIBLE,
        StoreCapability.CORRUPT,
    }:
        return RuntimeMode.INCOMPATIBLE
    if cc_switch_capability is StoreCapability.UNAVAILABLE:
        # The store exists but its state cannot be proven (locked, permission
        # denied). Guessing a mode here would silently reroute startup, so
        # fail closed with an actionable error instead.
        raise ProviderStoreUnavailableError(
            "CC Switch availability could not be determined; "
            "resolve access to the database or choose --store standalone"
        )
    return RuntimeMode.STANDALONE if standalone_exists else RuntimeMode.EMPTY


def first_screen_for_mode(mode: RuntimeMode) -> FirstScreen:
    """Return the initial view screen for a resolved mode."""

    if not isinstance(mode, RuntimeMode):
        raise TypeError("mode must be a RuntimeMode")
    return {
        RuntimeMode.COMPANION: FirstScreen.PROVIDER_LIST,
        RuntimeMode.STANDALONE: FirstScreen.PROFILE_LIST,
        RuntimeMode.EMPTY: FirstScreen.QUICK_SETUP,
        RuntimeMode.INCOMPATIBLE: FirstScreen.INCOMPATIBLE_ERROR,
    }[mode]


def resolve_startup_route(
    cc_switch_capability: StoreCapability,
    *,
    standalone_exists: bool,
    store_override: str | None = None,
) -> StartupRoute:
    """Resolve startup mode and first screen together."""

    mode = resolve_runtime_mode(
        cc_switch_capability,
        standalone_exists=standalone_exists,
        store_override=store_override,
    )
    return StartupRoute(mode=mode, first_screen=first_screen_for_mode(mode))


__all__ = [
    "FirstScreen",
    "StartupRoute",
    "first_screen_for_mode",
    "resolve_runtime_mode",
    "resolve_startup_route",
]
