"""Credential-free standalone profile metadata storage.

The store owns only routing metadata and an opaque reference to a credential
managed elsewhere. It never accepts, resolves, or returns plaintext API keys.
"""

from __future__ import annotations

import json
import os
import stat
import tempfile
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

from .domain import ModelMapping, ProtocolAdapter, StandaloneProfile


APPLICATION_DIRECTORY = "claude-hub"
STORE_FILENAME = "standalone-profiles.json"
SCHEMA_VERSION = 1
MAX_STORE_BYTES = 4 * 1024 * 1024


class StandaloneStoreError(RuntimeError):
    """Base class for sanitized standalone-store failures."""


class StandaloneStoreSecurityError(StandaloneStoreError):
    """Raised when a path, file type, owner, or mode is unsafe."""


class StandaloneStoreCorruptError(StandaloneStoreError):
    """Raised when the local document does not satisfy its declared schema."""


class UnsupportedStandaloneSchemaError(StandaloneStoreError):
    """Raised when a local schema cannot be safely interpreted."""


class StandaloneProfileNotFoundError(StandaloneStoreError):
    """Raised when a profile UUID is absent."""


class StandaloneProfileExistsError(StandaloneStoreError):
    """Raised when create would overwrite an existing profile."""


class StandaloneProfileConflictError(StandaloneStoreError):
    """Raised when update would regress immutable or monotonic metadata."""


def standalone_data_dir(
    platform: str,
    *,
    home: str | os.PathLike[str],
    environment: Mapping[str, str] | None = None,
) -> Path:
    """Return the standard per-user data directory without reading process state."""

    if not isinstance(platform, str):
        raise TypeError("platform must be a string")
    if not isinstance(environment, (Mapping, type(None))):
        raise TypeError("environment must be a mapping")
    values = {} if environment is None else environment
    home_path = Path(home)
    normalized_platform = platform.casefold()

    if normalized_platform in {"darwin", "macos"}:
        base = home_path / "Library" / "Application Support"
    elif normalized_platform in {"win32", "windows"}:
        configured = values.get("LOCALAPPDATA")
        candidate = (
            Path(configured)
            if isinstance(configured, str) and configured
            else None
        )
        base = (
            candidate
            if candidate is not None and candidate.is_absolute()
            else home_path / "AppData" / "Local"
        )
    elif normalized_platform.startswith("linux"):
        configured = values.get("XDG_DATA_HOME")
        candidate = (
            Path(configured)
            if isinstance(configured, str) and configured
            else None
        )
        base = (
            candidate
            if candidate is not None and candidate.is_absolute()
            else home_path / ".local" / "share"
        )
    else:
        base = home_path / ".local" / "share"

    return base / APPLICATION_DIRECTORY


class StandaloneProfileStore:
    """Atomic, credential-free JSON metadata storage for standalone profiles."""

    __slots__ = ("_data_dir", "_store_path")

    def __init__(self, data_dir: str | os.PathLike[str]) -> None:
        self._data_dir = Path(data_dir)
        self._store_path = self._data_dir / STORE_FILENAME

    @property
    def store_path(self) -> Path:
        return self._store_path

    def _ensure_secure_dir(self) -> None:
        if not self._data_dir.exists():
            self._data_dir.mkdir(parents=True, mode=0o700, exist_ok=True)
            try:
                os.chmod(self._data_dir, 0o700)
            except OSError:
                pass

    def _load_document(self) -> dict[str, Any]:
        if not self._store_path.exists():
            return {"schemaVersion": SCHEMA_VERSION, "profiles": {}}

        try:
            size = self._store_path.stat().st_size
            if size == 0:
                raise StandaloneStoreCorruptError("Store file is empty")
            if size > MAX_STORE_BYTES:
                raise StandaloneStoreCorruptError("Store file exceeds maximum size")

            content = self._store_path.read_text(encoding="utf-8")
            doc = json.loads(content)
            if not isinstance(doc, dict):
                raise StandaloneStoreCorruptError("Store content is not a JSON object")

            version = doc.get("schemaVersion")
            if version != SCHEMA_VERSION:
                raise UnsupportedStandaloneSchemaError(
                    f"Unsupported schema version: {version!r}"
                )

            profiles = doc.get("profiles")
            if not isinstance(profiles, dict):
                raise StandaloneStoreCorruptError("Profiles must be an object")

            return doc
        except (json.JSONDecodeError, ValueError) as exc:
            raise StandaloneStoreCorruptError(f"Corrupt JSON store: {exc}") from exc

    def _write_document(self, doc: dict[str, Any]) -> None:
        self._ensure_secure_dir()
        temp_file = None
        try:
            # Write to a temporary file in the same directory for atomic rename
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self._data_dir,
                prefix=".profiles-tmp-",
                delete=False,
            ) as tf:
                temp_file = Path(tf.name)
                json.dump(doc, tf, indent=2, ensure_ascii=False)
                tf.flush()
                os.fsync(tf.fileno())

            try:
                os.chmod(temp_file, 0o600)
            except OSError:
                pass

            os.replace(temp_file, self._store_path)
            temp_file = None
        finally:
            if temp_file is not None and temp_file.exists():
                try:
                    temp_file.unlink()
                except OSError:
                    pass

    def _deserialize_profile(self, data: Mapping[str, Any]) -> StandaloneProfile:
        try:
            models_dict = data.get("models", {})
            models = ModelMapping(
                default=models_dict.get("default"),
                fast=models_dict.get("fast"),
                reasoning=models_dict.get("reasoning"),
                coding=models_dict.get("coding"),
                long_context=models_dict.get("long_context"),
                fallback=models_dict.get("fallback"),
            )
            return StandaloneProfile(
                profile_id=UUID(data["profile_id"]),
                name=data["name"],
                base_url=data["base_url"],
                adapter=ProtocolAdapter(data["adapter"]),
                secret_ref=UUID(data["secret_ref"]),
                created_at=datetime.fromisoformat(data["created_at"]),
                updated_at=datetime.fromisoformat(data["updated_at"]),
                models=models,
                purpose_tags=tuple(data.get("purpose_tags", ())),
            )
        except Exception as exc:
            raise StandaloneStoreCorruptError(
                f"Failed to deserialize profile: {exc}"
            ) from exc

    def _serialize_profile(self, profile: StandaloneProfile) -> dict[str, Any]:
        return {
            "profile_id": str(profile.profile_id),
            "name": profile.name,
            "base_url": profile.base_url,
            "adapter": profile.adapter.value,
            "secret_ref": str(profile.secret_ref),
            "created_at": profile.created_at.isoformat(),
            "updated_at": profile.updated_at.isoformat(),
            "models": profile.models.to_public_dict(),
            "purpose_tags": list(profile.purpose_tags),
        }

    def list(self) -> tuple[StandaloneProfile, ...]:
        """Return all standalone profiles ordered by name."""
        doc = self._load_document()
        profiles_dict = doc.get("profiles", {})
        results: list[StandaloneProfile] = []
        for p_data in profiles_dict.values():
            results.append(self._deserialize_profile(p_data))
        results.sort(key=lambda p: (p.name.casefold(), str(p.profile_id)))
        return tuple(results)

    def get(self, profile_id: UUID | str) -> StandaloneProfile:
        """Get profile by UUID, or raise StandaloneProfileNotFoundError."""
        key = str(UUID(str(profile_id)))
        doc = self._load_document()
        profiles_dict = doc.get("profiles", {})
        if key not in profiles_dict:
            raise StandaloneProfileNotFoundError(f"Profile {key!r} not found")
        return self._deserialize_profile(profiles_dict[key])

    def get_by_name(self, name: str) -> StandaloneProfile | None:
        """Find profile by exact display name (case-insensitive)."""
        target = name.strip().casefold()
        for p in self.list():
            if p.name.casefold() == target:
                return p
        return None

    def exists(self, profile_id: UUID | str) -> bool:
        try:
            self.get(profile_id)
            return True
        except (StandaloneProfileNotFoundError, ValueError):
            return False

    def has_profiles(self) -> bool:
        return len(self.list()) > 0

    def create(self, profile: StandaloneProfile) -> StandaloneProfile:
        """Atomically create a new standalone profile."""
        if not isinstance(profile, StandaloneProfile):
            raise TypeError("profile must be a StandaloneProfile")

        doc = self._load_document()
        profiles_dict = doc.setdefault("profiles", {})
        key = str(profile.profile_id)

        if key in profiles_dict:
            raise StandaloneProfileExistsError(f"Profile {key!r} already exists")

        # Ensure no name conflict
        for existing_raw in profiles_dict.values():
            if existing_raw.get("name", "").strip().casefold() == profile.name.casefold():
                raise StandaloneProfileConflictError(
                    f"A profile with name {profile.name!r} already exists"
                )

        profiles_dict[key] = self._serialize_profile(profile)
        self._write_document(doc)
        return profile

    def update(self, profile: StandaloneProfile) -> StandaloneProfile:
        """Atomically update an existing standalone profile."""
        if not isinstance(profile, StandaloneProfile):
            raise TypeError("profile must be a StandaloneProfile")

        doc = self._load_document()
        profiles_dict = doc.setdefault("profiles", {})
        key = str(profile.profile_id)

        if key not in profiles_dict:
            raise StandaloneProfileNotFoundError(f"Profile {key!r} not found")

        existing = self._deserialize_profile(profiles_dict[key])
        if profile.created_at != existing.created_at:
            raise StandaloneProfileConflictError("created_at cannot be altered")
        if profile.secret_ref != existing.secret_ref:
            raise StandaloneProfileConflictError("secret_ref cannot be altered directly")

        profiles_dict[key] = self._serialize_profile(profile)
        self._write_document(doc)
        return profile

    def delete(self, profile_id: UUID | str) -> bool:
        """Atomically delete a profile by UUID."""
        key = str(UUID(str(profile_id)))
        doc = self._load_document()
        profiles_dict = doc.get("profiles", {})
        if key not in profiles_dict:
            raise StandaloneProfileNotFoundError(f"Profile {key!r} not found")

        del profiles_dict[key]
        self._write_document(doc)
        return True


__all__ = [
    "APPLICATION_DIRECTORY",
    "SCHEMA_VERSION",
    "STORE_FILENAME",
    "StandaloneProfileConflictError",
    "StandaloneProfileExistsError",
    "StandaloneProfileNotFoundError",
    "StandaloneProfileStore",
    "StandaloneStoreCorruptError",
    "StandaloneStoreError",
    "StandaloneStoreSecurityError",
    "UnsupportedStandaloneSchemaError",
    "standalone_data_dir",
]
