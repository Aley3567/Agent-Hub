"""Read-only CC Switch provider-store adapter.

Database paths and raw provider records remain inside this module. The
presentation boundary receives only validated stable references and redacted
inspection DTOs.
"""

from __future__ import annotations

import hashlib
import json
import os
import sqlite3
from collections.abc import Mapping
from pathlib import Path

from .claude_models import ClaudeModelAdapter, ClaudeModelDocumentError
from .domain import ProviderInspection, ProviderRef, StoreCapability
from .store import (
    ProviderConfigCorruptError,
    ProviderNotFoundError,
    ProviderStoreError,
    ProviderStoreIncompatibleError,
    ProviderStoreUnavailableError,
)


CC_SWITCH_DB_ENV = "CLAUDE_HUB_CC_SWITCH_DB"
CC_SWITCH_DB_ENV_ALIASES = ("CLAUDE_HUB_CC_SWITCH_DB_PATH", "CLAUDE1_DB_PATH")
MIN_READ_SCHEMA_VERSION = 13
MAX_READ_SCHEMA_VERSION = 16
WRITE_SCHEMA_VERSIONS = frozenset({16})
CC_SWITCH_STORE_ID = "cc-switch"
MAX_SETTINGS_CONFIG_BYTES = 4 * 1024 * 1024

_REQUIRED_COLUMNS: dict[str, frozenset[str]] = {
    "providers": frozenset(
        {
            "id",
            "name",
            "settings_config",
            "app_type",
            "sort_index",
            "is_current",
        }
    ),
}


def resolve_ccswitch_database_path(
    database_path: str | os.PathLike[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> Path:
    """Resolve explicit, environment, then platform-home database candidates."""

    if database_path is not None:
        return Path(database_path).expanduser()

    environment = os.environ if environ is None else environ
    for key in (CC_SWITCH_DB_ENV, *CC_SWITCH_DB_ENV_ALIASES):
        value = environment.get(key)
        if value:
            return Path(value).expanduser()
    return Path.home() / ".cc-switch" / "cc-switch.db"


def _readonly_connection(path: Path) -> sqlite3.Connection:
    uri = path.resolve(strict=True).as_uri() + "?mode=ro"
    connection = sqlite3.connect(uri, uri=True, timeout=5.0)
    try:
        connection.execute("PRAGMA query_only=ON")
    except Exception:
        connection.close()
        raise
    return connection


class CCSwitchProviderStore:
    """Read-only SQLite store adapter for CC Switch databases."""

    __slots__ = ("_database_path", "_environ", "_model_adapter")

    def __init__(
        self,
        database_path: str | os.PathLike[str] | None = None,
        *,
        model_adapter: ClaudeModelAdapter | None = None,
        environ: Mapping[str, str] | None = None,
    ) -> None:
        self._database_path = database_path
        self._environ = environ
        self._model_adapter = (
            ClaudeModelAdapter() if model_adapter is None else model_adapter
        )

    @property
    def database_path(self) -> Path:
        return resolve_ccswitch_database_path(
            self._database_path,
            environ=self._environ,
        )

    def detect(self) -> StoreCapability:
        """Probe CC Switch file existence and schema capability."""
        path = self.database_path
        if not path.is_file():
            return StoreCapability.ABSENT

        try:
            if path.stat().st_size == 0:
                return StoreCapability.CORRUPT
        except OSError:
            return StoreCapability.ABSENT

        try:
            with _readonly_connection(path) as conn:
                cursor = conn.cursor()
                cursor.execute("PRAGMA user_version")
                row = cursor.fetchone()
                if row is None:
                    return StoreCapability.CORRUPT
                version = row[0]

                if not isinstance(version, int) or version < MIN_READ_SCHEMA_VERSION or version > MAX_READ_SCHEMA_VERSION:
                    return StoreCapability.INCOMPATIBLE

                # Validate required tables & columns
                cursor.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='providers'"
                )
                if cursor.fetchone() is None:
                    return StoreCapability.INCOMPATIBLE

                cursor.execute("PRAGMA table_info(providers)")
                columns = {r[1] for r in cursor.fetchall()}
                if not _REQUIRED_COLUMNS["providers"].issubset(columns):
                    return StoreCapability.INCOMPATIBLE

                if version in WRITE_SCHEMA_VERSIONS:
                    return StoreCapability.COMPATIBLE
                return StoreCapability.READ_ONLY
        except sqlite3.OperationalError:
            # Operational errors (e.g. database locked, unable to open) mean unavailable, not corrupt
            return StoreCapability.ABSENT
        except sqlite3.DatabaseError:
            # Format/structural errors mean corrupt
            return StoreCapability.CORRUPT
        except OSError:
            return StoreCapability.ABSENT

    def list(self) -> tuple[ProviderRef, ...]:
        """Return stable provider references from CC Switch."""
        capability = self.detect()
        if not capability.can_read:
            if capability is StoreCapability.ABSENT:
                raise ProviderStoreUnavailableError(
                    f"CC Switch database not found or unavailable at {self.database_path}"
                )
            if capability is StoreCapability.CORRUPT:
                raise ProviderConfigCorruptError(
                    f"CC Switch database at {self.database_path} is corrupt"
                )
            raise ProviderStoreIncompatibleError(
                f"CC Switch database at {self.database_path} has incompatible schema"
            )

        path = self.database_path
        try:
            with _readonly_connection(path) as conn:
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT id, name, is_current
                    FROM providers
                    WHERE app_type = 'claude'
                    ORDER BY sort_index ASC, id ASC
                    """
                )
                rows = cursor.fetchall()
                results: list[ProviderRef] = []
                for row in rows:
                    p_id, p_name, is_current = row
                    results.append(
                        ProviderRef(
                            store=CC_SWITCH_STORE_ID,
                            provider_id=str(p_id),
                            display_name=str(p_name) if p_name else None,
                            is_current=bool(is_current),
                        )
                    )
                return tuple(results)
        except sqlite3.OperationalError as exc:
            raise ProviderStoreUnavailableError(
                f"Failed to access CC Switch database: {exc}"
            ) from exc
        except sqlite3.DatabaseError as exc:
            raise ProviderConfigCorruptError(
                f"Failed to query providers from CC Switch: {exc}"
            ) from exc

    def inspect(self, reference: ProviderRef) -> ProviderInspection:
        """Return redacted provider details and model mapping."""
        if not isinstance(reference, ProviderRef):
            raise TypeError("reference must be a ProviderRef")
        if reference.store != CC_SWITCH_STORE_ID:
            raise ProviderNotFoundError(
                f"Store {reference.store!r} is not {CC_SWITCH_STORE_ID!r}"
            )

        capability = self.detect()
        if not capability.can_read:
            if capability is StoreCapability.ABSENT:
                raise ProviderStoreUnavailableError(
                    f"CC Switch database not found or unavailable at {self.database_path}"
                )
            if capability is StoreCapability.CORRUPT:
                raise ProviderConfigCorruptError(
                    f"CC Switch database at {self.database_path} is corrupt"
                )
            raise ProviderStoreIncompatibleError(
                f"CC Switch database at {self.database_path} has incompatible schema"
            )

        path = self.database_path
        try:
            with _readonly_connection(path) as conn:
                cursor = conn.cursor()
                cursor.execute(
                    """
                    SELECT id, name, settings_config, is_current
                    FROM providers
                    WHERE app_type = 'claude' AND id = ?
                    """,
                    (reference.provider_id,),
                )
                row = cursor.fetchone()
                if row is None:
                    raise ProviderNotFoundError(
                        f"Provider {reference.provider_id!r} not found"
                    )

                p_id, p_name, settings_raw, is_current = row

                if not isinstance(settings_raw, str):
                    raise ProviderConfigCorruptError(
                        f"Provider {reference.provider_id!r} settings_config is not text"
                    )
                # Fast length short-circuit before memory-intensive encoding
                if len(settings_raw) > MAX_SETTINGS_CONFIG_BYTES:
                    raise ProviderConfigCorruptError(
                        f"Provider {reference.provider_id!r} settings_config exceeds size limit"
                    )
                if len(settings_raw.encode("utf-8")) > MAX_SETTINGS_CONFIG_BYTES:
                    raise ProviderConfigCorruptError(
                        f"Provider {reference.provider_id!r} settings_config exceeds size limit"
                    )

                try:
                    document = json.loads(settings_raw)
                    if not isinstance(document, dict):
                        raise ValueError("settings_config must be a JSON object")
                except Exception as exc:
                    raise ProviderConfigCorruptError(
                        f"Provider {reference.provider_id!r} settings_config JSON corrupt: {exc}"
                    ) from exc

                try:
                    models = self._model_adapter.project(document)
                except ClaudeModelDocumentError as exc:
                    raise ProviderConfigCorruptError(
                        f"Provider {reference.provider_id!r} model projection failed: {exc}"
                    ) from exc

                unknown_summary = self._model_adapter.unknown_fields(document)
                doc_fingerprint = self._model_adapter.fingerprint(document)

                # Check optional proxy takeover
                proxy_takeover = False
                cursor.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='proxy_config'"
                )
                if cursor.fetchone() is not None:
                    cursor.execute(
                        "SELECT live_takeover_active FROM proxy_config WHERE app_type = 'claude'"
                    )
                    takeover_row = cursor.fetchone()
                    if takeover_row and takeover_row[0]:
                        proxy_takeover = bool(takeover_row[0])

                ref = ProviderRef(
                    store=CC_SWITCH_STORE_ID,
                    provider_id=str(p_id),
                    display_name=str(p_name) if p_name else None,
                    is_current=bool(is_current),
                )

                return ProviderInspection(
                    reference=ref,
                    models=models,
                    is_current=bool(is_current),
                    fingerprint=doc_fingerprint,
                    proxy_takeover=proxy_takeover,
                    schema_capability=capability,
                    unknown_field_count=unknown_summary.count,
                    unknown_fingerprint=unknown_summary.fingerprint,
                )
        except (ProviderNotFoundError, ProviderConfigCorruptError, ProviderStoreUnavailableError, ProviderStoreIncompatibleError):
            raise
        except sqlite3.OperationalError as exc:
            raise ProviderStoreUnavailableError(
                f"Failed to query provider {reference.provider_id!r}: {exc}"
            ) from exc
        except sqlite3.DatabaseError as exc:
            raise ProviderConfigCorruptError(
                f"Failed to query provider {reference.provider_id!r}: {exc}"
            ) from exc


__all__ = [
    "CCSwitchProviderStore",
    "CC_SWITCH_DB_ENV",
    "CC_SWITCH_DB_ENV_ALIASES",
    "CC_SWITCH_STORE_ID",
    "MAX_READ_SCHEMA_VERSION",
    "MAX_SETTINGS_CONFIG_BYTES",
    "MIN_READ_SCHEMA_VERSION",
    "WRITE_SCHEMA_VERSIONS",
    "resolve_ccswitch_database_path",
]
