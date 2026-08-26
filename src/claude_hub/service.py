"""Application services shared by CLI, TUI, and GUI adapters."""

from __future__ import annotations

from .domain import ProviderInspection, ProviderRef, StoreCapability
from .routing import StartupRoute, resolve_startup_route
from .store import ProviderStore


class ProviderApplicationService:
    """Minimal detect/list/inspect use cases over an injected store."""

    __slots__ = ("_store",)

    def __init__(self, store: ProviderStore) -> None:
        if not isinstance(store, ProviderStore):
            raise TypeError("store must implement ProviderStore")
        self._store = store

    def detect(self) -> StoreCapability:
        capability = self._store.detect()
        if not isinstance(capability, StoreCapability):
            raise TypeError("ProviderStore.detect() returned an invalid capability")
        return capability

    def list(self) -> tuple[ProviderRef, ...]:
        references = tuple(self._store.list())
        if any(not isinstance(reference, ProviderRef) for reference in references):
            raise TypeError("ProviderStore.list() returned an invalid reference")
        return references

    def inspect(self, reference: ProviderRef) -> ProviderInspection:
        if not isinstance(reference, ProviderRef):
            raise TypeError("reference must be a ProviderRef")
        inspection = self._store.inspect(reference)
        if not isinstance(inspection, ProviderInspection):
            raise TypeError("ProviderStore.inspect() returned an invalid inspection")
        if inspection.reference.provider_id != reference.provider_id:
            raise ValueError("ProviderStore.inspect() returned a different reference")
        return inspection

    def inspect_stable_id(
        self,
        stable_id: str,
        store_name: str = "cc-switch",
    ) -> ProviderInspection:
        """Convenience inspection by stable identifier string."""
        reference = ProviderRef(store=store_name, provider_id=stable_id)
        return self.inspect(reference)

    def resolve_startup(
        self,
        *,
        standalone_exists: bool = False,
        store_override: str | None = None,
    ) -> StartupRoute:
        """Resolve the startup mode and landing view from store capability."""
        capability = self.detect()
        return resolve_startup_route(
            capability,
            standalone_exists=standalone_exists,
            store_override=store_override,
        )

    def list_providers(self) -> tuple[ProviderRef, ...]:
        """Descriptive alias for presentation adapters."""
        return self.list()

    def inspect_provider(self, reference: ProviderRef) -> ProviderInspection:
        """Descriptive alias for presentation adapters."""
        return self.inspect(reference)


__all__ = ["ProviderApplicationService"]
