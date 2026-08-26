"""Deterministic test doubles for the provider store protocol."""

from __future__ import annotations

from collections.abc import Iterable, Mapping

from .domain import ProviderInspection, ProviderRef, StoreCapability
from .store import (
    ProviderConfigCorruptError,
    ProviderNotFoundError,
    ProviderStore,
    ProviderStoreIncompatibleError,
    ProviderStoreUnavailableError,
)

IN_MEMORY_STORE_ID = "in-memory"


def _assert_readable(capability: StoreCapability) -> None:
    if capability is StoreCapability.ABSENT:
        raise ProviderStoreUnavailableError("in-memory store is absent")
    if capability is StoreCapability.UNAVAILABLE:
        raise ProviderStoreUnavailableError("in-memory store is unprobeable")
    if capability is StoreCapability.CORRUPT:
        raise ProviderConfigCorruptError("in-memory store is corrupt")
    if capability is StoreCapability.INCOMPATIBLE:
        raise ProviderStoreIncompatibleError("in-memory store is incompatible")


class InMemoryProviderStore(ProviderStore):
    """In-memory test fake implementing :class:`~claude_hub.store.ProviderStore`.

    Its inspect() enforces the same store-ownership rule as the real CC Switch
    adapter: a reference bound to a different store is rejected, keeping the
    fake and adapter behaviorally aligned for conformance tests.
    """

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
        _assert_readable(self._capability)
        return self._providers

    def inspect(self, reference: ProviderRef) -> ProviderInspection:
        _assert_readable(self._capability)
        if reference.store != IN_MEMORY_STORE_ID:
            raise ProviderNotFoundError(
                f"Store {reference.store!r} is not {IN_MEMORY_STORE_ID!r}"
            )
        if reference.provider_id in self._inspections:
            return self._inspections[reference.provider_id]
        for item in self._providers:
            if item.provider_id == reference.provider_id:
                return ProviderInspection(reference=item)
        raise ProviderNotFoundError(
            f"provider {reference.provider_id!r} not found in in-memory store"
        )


__all__ = ["InMemoryProviderStore"]
