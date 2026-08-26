"""Quick setup orchestrator for Standalone Profiles and credential rollback."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from .credentials import SecretStore
from .domain import ModelMapping, ProtocolAdapter, StandaloneProfile
from .standalone import StandaloneProfileStore


def create_standalone_profile(
    profile_store: StandaloneProfileStore,
    secret_store: SecretStore,
    *,
    name: str,
    base_url: str,
    secret: str,
    adapter: ProtocolAdapter = ProtocolAdapter.ANTHROPIC,
    models: ModelMapping | None = None,
    purpose_tags: Sequence[str] = (),
) -> StandaloneProfile:
    """Atomically create a standalone profile with credential rollback on failure."""

    if not isinstance(secret, str) or not secret.strip():
        raise ValueError("secret must be a non-empty string")

    # Generate unique IDs
    profile_id = uuid4()
    secret_ref = uuid4()
    now = datetime.now(timezone.utc)

    profile = StandaloneProfile(
        profile_id=profile_id,
        name=name,
        base_url=base_url,
        adapter=adapter,
        secret_ref=secret_ref,
        created_at=now,
        updated_at=now,
        models=models or ModelMapping(),
        purpose_tags=tuple(purpose_tags),
    )

    # 1. Store the secret in the OS credential store
    secret_store.set_secret(secret_ref, secret)

    # 2. Try to store profile metadata
    try:
        profile_store.create(profile)
        return profile
    except Exception:
        # Rollback: purge secret from credential store if profile creation failed
        try:
            secret_store.delete_secret(secret_ref)
        except Exception:
            pass
        raise


def delete_standalone_profile(
    profile_store: StandaloneProfileStore,
    secret_store: SecretStore,
    profile_id: UUID | str,
    *,
    purge_secret: bool = True,
) -> bool:
    """Delete a standalone profile and optionally purge its stored credential."""

    profile = profile_store.get(profile_id)
    deleted = profile_store.delete(profile.profile_id)
    if deleted and purge_secret:
        try:
            secret_store.delete_secret(profile.secret_ref)
        except Exception:
            pass
    return deleted


def audit_orphan_secrets(
    profile_store: StandaloneProfileStore,
    secret_store: SecretStore,
) -> tuple[str, ...]:
    """Find secret references stored in SecretStore that have no referencing Profile."""

    stored_refs = set(secret_store.list_secret_refs())
    active_refs = {str(p.secret_ref) for p in profile_store.list()}
    orphans = stored_refs - active_refs
    return tuple(sorted(orphans))


def cleanup_orphan_secrets(
    profile_store: StandaloneProfileStore,
    secret_store: SecretStore,
) -> tuple[str, ...]:
    """Purge all orphaned secret references from the SecretStore."""

    orphans = audit_orphan_secrets(profile_store, secret_store)
    purged: list[str] = []
    for ref in orphans:
        if secret_store.delete_secret(ref):
            purged.append(ref)
    return tuple(purged)


__all__ = [
    "audit_orphan_secrets",
    "cleanup_orphan_secrets",
    "create_standalone_profile",
    "delete_standalone_profile",
]
