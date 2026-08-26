"""Short-lived, single-use launch descriptors for isolated sessions."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

from .domain import LaunchDescriptor, StandaloneProfile


DEFAULT_TTL_SECONDS = 60


class DescriptorError(RuntimeError):
    """Base class for launch descriptor failures."""


class DescriptorExpiredError(DescriptorError):
    """Raised when a launch descriptor has exceeded its expiration time."""


class DescriptorAlreadyConsumedError(DescriptorError):
    """Raised when a launch descriptor has already been consumed (prevents replay)."""


def create_launch_descriptor(
    profile: StandaloneProfile,
    *,
    ttl_seconds: int = DEFAULT_TTL_SECONDS,
) -> LaunchDescriptor:
    """Generate an ephemeral, single-use launch descriptor for a profile."""

    if not isinstance(profile, StandaloneProfile):
        raise TypeError("profile must be a StandaloneProfile")
    if ttl_seconds <= 0:
        raise ValueError("ttl_seconds must be positive")

    now = datetime.now(timezone.utc)
    expires = now + timedelta(seconds=ttl_seconds)

    return LaunchDescriptor(
        descriptor_id=uuid4(),
        profile_id=profile.profile_id,
        base_url=profile.base_url,
        adapter=profile.adapter,
        models=profile.models,
        secret_ref=profile.secret_ref,
        created_at=now,
        expires_at=expires,
        consumed=False,
    )


def consume_launch_descriptor(
    descriptor: LaunchDescriptor,
    *,
    now: datetime | None = None,
) -> LaunchDescriptor:
    """Atomically validate and consume a single-use launch descriptor."""

    if not isinstance(descriptor, LaunchDescriptor):
        raise TypeError("descriptor must be a LaunchDescriptor")

    current_time = datetime.now(timezone.utc) if now is None else now
    if current_time.tzinfo is None:
        current_time = current_time.replace(tzinfo=timezone.utc)

    if descriptor.consumed:
        raise DescriptorAlreadyConsumedError(
            f"Launch descriptor {descriptor.descriptor_id} has already been consumed"
        )

    if current_time > descriptor.expires_at:
        raise DescriptorExpiredError(
            f"Launch descriptor {descriptor.descriptor_id} expired at {descriptor.expires_at.isoformat()}"
        )

    return LaunchDescriptor(
        descriptor_id=descriptor.descriptor_id,
        profile_id=descriptor.profile_id,
        base_url=descriptor.base_url,
        adapter=descriptor.adapter,
        models=descriptor.models,
        secret_ref=descriptor.secret_ref,
        created_at=descriptor.created_at,
        expires_at=descriptor.expires_at,
        consumed=True,
    )


__all__ = [
    "DEFAULT_TTL_SECONDS",
    "DescriptorAlreadyConsumedError",
    "DescriptorError",
    "DescriptorExpiredError",
    "consume_launch_descriptor",
    "create_launch_descriptor",
]
