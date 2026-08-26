"""Immutable, presentation-safe values shared by every application surface.

The DTOs in this module deliberately have no credential, URL, header, raw
configuration, database-path, or exception fields. Arbitrary public
identifiers are also validated before they can enter a DTO, and ``repr`` never
includes provider or model secrets.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, fields
from datetime import datetime, timezone
from enum import Enum
from urllib.parse import urlparse
from uuid import UUID


class RuntimeMode(str, Enum):
    """Top-level application modes."""

    COMPANION = "companion"
    STANDALONE = "standalone"
    EMPTY = "empty"
    INCOMPATIBLE = "incompatible"


class StoreCapability(str, Enum):
    """Read-only result of probing a provider store."""

    ABSENT = "absent"
    UNAVAILABLE = "unavailable"
    READ_ONLY = "read_only"
    COMPATIBLE = "compatible"
    INCOMPATIBLE = "incompatible"
    CORRUPT = "corrupt"

    @property
    def can_read(self) -> bool:
        return self in {StoreCapability.READ_ONLY, StoreCapability.COMPATIBLE}

    @property
    def schema_allows_write(self) -> bool:
        """Whether the schema alone permits a later guarded write."""
        return self is StoreCapability.COMPATIBLE


class ProtocolAdapter(str, Enum):
    """Protocol adapter flavor for standalone provider endpoints."""

    ANTHROPIC = "anthropic"
    OPENAI_CHAT = "openai_chat"
    OPENAI_RESPONSES = "openai_responses"


_SENSITIVE_TEXT_RE = re.compile(
    r"(?i)(?:api[-_]?key|access[-_]?token|auth[-_]?token|bearer|credential|"
    r"password|passwd|private[-_]?key|secret|session[-_]?token)"
)
_CONTROL_CHARACTER_RE = re.compile(r"[\x00-\x1f\x7f]")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _require_public_identifier(value: object, *, field_name: str) -> str:
    """Validate a value that is allowed to cross a presentation boundary."""

    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    if not value or value != value.strip():
        raise ValueError(f"{field_name} must be a non-empty trimmed string")
    if len(value) > 512:
        raise ValueError(f"{field_name} is too long")
    if _CONTROL_CHARACTER_RE.search(value):
        raise ValueError(f"{field_name} contains a control character")
    if "://" in value or _SENSITIVE_TEXT_RE.search(value):
        raise ValueError(f"{field_name} is not a public identifier")
    return value


def normalize_base_url(value: object) -> str:
    """Validate and normalize a public endpoint base URL."""

    if not isinstance(value, str):
        raise TypeError("base_url must be a string")
    trimmed = value.strip()
    if not trimmed:
        raise ValueError("base_url must not be empty")
    if _CONTROL_CHARACTER_RE.search(trimmed):
        raise ValueError("base_url contains control characters")

    parsed = urlparse(trimmed)
    if parsed.scheme.lower() not in {"http", "https"}:
        raise ValueError("base_url must have http or https scheme")
    if not parsed.netloc:
        raise ValueError("base_url must contain a network location / host")
    if parsed.username or parsed.password:
        raise ValueError("base_url must not contain credentials in userinfo")
    if parsed.query or parsed.fragment:
        raise ValueError("base_url must not contain query or fragment parameters")

    normalized = f"{parsed.scheme.lower()}://{parsed.netloc}{parsed.path.rstrip('/')}"
    return normalized


def _normalize_uuid(value: object, *, field_name: str) -> UUID:
    if isinstance(value, UUID):
        return value
    if isinstance(value, str):
        try:
            return UUID(value.strip())
        except (ValueError, AttributeError) as exc:
            raise ValueError(f"{field_name} must be a valid UUID string") from exc
    raise TypeError(f"{field_name} must be a UUID or valid UUID string")


def _normalize_timestamp(value: object, *, field_name: str) -> datetime:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc)
    if isinstance(value, str):
        try:
            dt = datetime.fromisoformat(value.strip())
            if dt.tzinfo is None:
                return dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc)
        except ValueError as exc:
            raise ValueError(f"{field_name} must be a valid ISO-8601 timestamp string") from exc
    raise TypeError(f"{field_name} must be a datetime, float timestamp, or ISO string")


@dataclass(frozen=True, slots=True, repr=False)
class ProviderRef:
    """Stable provider identity without sensitive provider settings."""

    store: str
    provider_id: str
    display_name: str | None = None
    is_current: bool = False

    def __post_init__(self) -> None:
        _require_public_identifier(self.store, field_name="store")
        _require_public_identifier(self.provider_id, field_name="provider_id")
        if self.display_name is not None:
            _require_public_identifier(self.display_name, field_name="display_name")
        if not isinstance(self.is_current, bool):
            raise TypeError("is_current must be a bool")

    @property
    def source(self) -> str:
        """Compatibility spelling for callers that call the store a source."""
        return self.store

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(store={self.store!r}, "
            f"provider_id=<redacted>, is_current={self.is_current!r})"
        )


@dataclass(frozen=True, slots=True, repr=False)
class ModelMapping:
    """Generic purpose-to-model mapping, independent of Claude JSON fields."""

    default: str | None = None
    fast: str | None = None
    reasoning: str | None = None
    coding: str | None = None
    long_context: str | None = None
    fallback: str | None = None

    def __post_init__(self) -> None:
        for item in fields(self):
            value = getattr(self, item.name)
            if value is not None:
                _require_public_identifier(
                    value,
                    field_name=f"models.{item.name}",
                )

    @property
    def configured_slots(self) -> tuple[str, ...]:
        return tuple(
            item.name
            for item in fields(self)
            if getattr(self, item.name) is not None
        )

    def to_public_dict(self) -> dict[str, str]:
        """Return only configured, validated model identifiers."""
        return {
            item.name: value
            for item in fields(self)
            if (value := getattr(self, item.name)) is not None
        }

    def __repr__(self) -> str:
        return f"{type(self).__name__}(slots={self.configured_slots!r})"


@dataclass(frozen=True, slots=True, repr=False)
class ProviderInspection:
    """Read-only, redacted provider details used by CLI, TUI, and GUI."""

    reference: ProviderRef
    models: ModelMapping = ModelMapping()
    is_current: bool = False
    fingerprint: str | None = None
    proxy_takeover: bool = False
    schema_capability: StoreCapability | None = None
    unknown_field_count: int = 0
    unknown_fingerprint: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.reference, ProviderRef):
            raise TypeError("reference must be a ProviderRef")
        if not isinstance(self.models, ModelMapping):
            raise TypeError("models must be a ModelMapping")
        if not isinstance(self.is_current, bool):
            raise TypeError("is_current must be a bool")
        if self.fingerprint is not None:
            if not isinstance(self.fingerprint, str) or not _SHA256_RE.fullmatch(self.fingerprint):
                raise ValueError("fingerprint must be a 64-character hex digest")
        if not isinstance(self.proxy_takeover, bool):
            raise TypeError("proxy_takeover must be a bool")
        if self.schema_capability is not None and not isinstance(
            self.schema_capability, StoreCapability
        ):
            raise TypeError("schema_capability must be a StoreCapability")
        if (
            not isinstance(self.unknown_field_count, int)
            or isinstance(self.unknown_field_count, bool)
            or self.unknown_field_count < 0
        ):
            raise TypeError("unknown_field_count must be a non-negative int")
        if self.unknown_fingerprint is not None:
            if (
                not isinstance(self.unknown_fingerprint, str)
                or not _SHA256_RE.fullmatch(self.unknown_fingerprint)
            ):
                raise ValueError("unknown_fingerprint must be a 64-character hex digest")

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(reference={self.reference!r}, "
            f"models={self.models!r}, is_current={self.is_current!r})"
        )


@dataclass(frozen=True, slots=True, repr=False)
class StandaloneProfile:
    """Credential-free metadata for one standalone provider profile."""

    profile_id: UUID
    name: str
    base_url: str
    adapter: ProtocolAdapter
    secret_ref: UUID
    created_at: datetime
    updated_at: datetime
    models: ModelMapping = ModelMapping()
    purpose_tags: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "profile_id", _normalize_uuid(self.profile_id, field_name="profile_id"))
        _require_public_identifier(self.name, field_name="name")
        object.__setattr__(self, "base_url", normalize_base_url(self.base_url))
        if isinstance(self.adapter, str):
            object.__setattr__(self, "adapter", ProtocolAdapter(self.adapter.lower()))
        elif not isinstance(self.adapter, ProtocolAdapter):
            raise TypeError("adapter must be a ProtocolAdapter")
        object.__setattr__(self, "secret_ref", _normalize_uuid(self.secret_ref, field_name="secret_ref"))
        object.__setattr__(self, "created_at", _normalize_timestamp(self.created_at, field_name="created_at"))
        object.__setattr__(self, "updated_at", _normalize_timestamp(self.updated_at, field_name="updated_at"))
        if self.updated_at < self.created_at:
            raise ValueError("updated_at must not precede created_at")
        if not isinstance(self.models, ModelMapping):
            raise TypeError("models must be a ModelMapping")

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(profile_id={str(self.profile_id)!r}, "
            f"name={self.name!r}, adapter={self.adapter.value!r}, "
            f"models={self.models!r})"
        )


@dataclass(frozen=True, slots=True, repr=False)
class LaunchDescriptor:
    """Ephemeral, short-lived single-use launch token for isolated session."""

    descriptor_id: UUID
    profile_id: UUID
    base_url: str
    adapter: ProtocolAdapter
    models: ModelMapping
    secret_ref: UUID
    created_at: datetime
    expires_at: datetime
    consumed: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "descriptor_id", _normalize_uuid(self.descriptor_id, field_name="descriptor_id"))
        object.__setattr__(self, "profile_id", _normalize_uuid(self.profile_id, field_name="profile_id"))
        object.__setattr__(self, "base_url", normalize_base_url(self.base_url))
        if isinstance(self.adapter, str):
            object.__setattr__(self, "adapter", ProtocolAdapter(self.adapter.lower()))
        elif not isinstance(self.adapter, ProtocolAdapter):
            raise TypeError("adapter must be a ProtocolAdapter")
        if not isinstance(self.models, ModelMapping):
            raise TypeError("models must be a ModelMapping")
        object.__setattr__(self, "secret_ref", _normalize_uuid(self.secret_ref, field_name="secret_ref"))
        object.__setattr__(self, "created_at", _normalize_timestamp(self.created_at, field_name="created_at"))
        object.__setattr__(self, "expires_at", _normalize_timestamp(self.expires_at, field_name="expires_at"))
        if self.expires_at <= self.created_at:
            raise ValueError("expires_at must be strictly after created_at")
        if not isinstance(self.consumed, bool):
            raise TypeError("consumed must be a bool")

    @property
    def is_expired(self) -> bool:
        return datetime.now(timezone.utc) > self.expires_at

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(descriptor_id={str(self.descriptor_id)!r}, "
            f"profile_id={str(self.profile_id)!r}, consumed={self.consumed!r})"
        )


ProviderReference = ProviderRef
ProviderInspect = ProviderInspection


__all__ = [
    "LaunchDescriptor",
    "ModelMapping",
    "ProtocolAdapter",
    "ProviderInspect",
    "ProviderInspection",
    "ProviderRef",
    "ProviderReference",
    "RuntimeMode",
    "StandaloneProfile",
    "StoreCapability",
    "normalize_base_url",
]
