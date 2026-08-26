"""Deterministic test doubles for the provider store protocol."""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from .domain import ProviderInspection, ProviderRef, StoreCapability
from .store import (
    ProviderNotFoundError,
    ProviderStore,
)


class InMemoryProviderStore(ProviderStore):
    """In-memory test fake implementing :class:`~claude_hub.store.ProviderStore`."""

    def __init__(
        self,
        *,
        capability: StoreCapability = StoreCapability.COMPATIBLE,
        providers: Iterable[ProviderRef] = (),
        inspections: Mapping[str, ProviderInspection] | None = None,
    ) -> None:
        self._capability = capability
        self._providers = tuple(providers)
        self._inspections = dict(inspections or {})

    def detect(self) -> StoreCapability:
        return self._capability

    def list(self) -> tuple[ProviderRef, ...]:
        return self._providers

    def inspect(self, reference: ProviderRef) -> ProviderInspection:
        if reference.provider_id in self._inspections:
            return self._inspections[reference.provider_id]
        for item in self._providers:
            if item.provider_id == reference.provider_id:
                return ProviderInspection(reference=item)
        raise ProviderNotFoundError(
            f"provider {reference.provider_id!r} not found in in-memory store"
        )


__all__ = ["InMemoryProviderStore"]
