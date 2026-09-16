"""Provider snapshot ownership: reading CC Switch rows and caching them once.

`claude-hub.py` owns the path and the permission policy -- it resolves
``CLAUDE_HUB_DB``, fails closed on anything looser than 0600, and states the
revision it observed. This module owns everything downstream of that decision:
how a row becomes a runtime provider record, how a stable copy of a live SQLite
database is taken, and the single cache slot with its lock, single-flight rule
and metrics.

Invariants
    - The source database is never opened for writing and never mutated; reads
      go through a private 0600 copy of main+WAL taken while the fingerprint is
      unchanged before and after.
    - ``ProviderSnapshotCache`` is the sole owner of the cached entry, the two
      locks and the five counters. Nothing outside it may read or assign them.
    - A failed refresh leaves the previous entry intact; the caller still sees
      the error.
    - Records carry live credentials. They belong to the runtime path and must
      not be merged with the redacted management-plane store.

Error mode
    ``ProviderDatabaseError`` for anything that makes the database unusable;
    ``sqlite3.Error`` / ``OSError`` raised by a refresh are wrapped into it.
"""

from __future__ import annotations

import json
import math
import shutil
import sqlite3
import tempfile
import threading
import time
from collections import deque
from pathlib import Path

from claude1_account_pool import normalize_account_endpoint
from claude1_protocol import provider_api_format
from claude1_transport import TransportConfigError, normalize_transport_config
from claude1_credentials import CREDENTIAL_COLUMNS, CredentialError, resolve as resolve_credentials, without_secrets


# Attempts at copying a stable main+WAL pair while a writer is active.
DB_SNAPSHOT_RETRIES = 5


class ProviderDatabaseError(RuntimeError):
    """The CC Switch provider database is missing, unreadable or malformed."""


def _snapshot_percentile(samples, pct: float) -> int:
    """Return the nearest-rank ``pct`` percentile of ``samples`` (0 if empty)."""
    if not samples:
        return 0
    s = sorted(samples)
    idx = max(0, math.ceil(pct / 100 * len(s)) - 1)
    return s[idx]


class ProviderSnapshotCache:
    """Sole owner of the process-wide provider snapshot, its lock and metrics.

    The cache holds one ``(revision, providers)`` slot: a single assignment on
    write and a single load on read, so a concurrent refresh can never tear the
    pair apart.  Callers supply the revision they observed and a ``refresh``
    callable; the cache decides whether that refresh happens at all, and it is
    the only object allowed to touch the entry, the locks or the counters.

    Invariants
        - A failed refresh leaves the previous entry intact and counts one
          failure; the caller still sees the error.
        - Concurrent misses are single-flight coalesced: a waiter accepts an
          entry another thread produced while it waited (design doc §3.2).
        - Metrics live behind their own lock, so the fast hit path never
          contends on the refresh lock (design doc §7, D5).
        - Deciding *what* a valid revision is, reading the database and
          re-checking file permissions all belong to the caller's ``refresh``;
          this object only decides *when* it runs.
    """

    def __init__(self, *, log=None) -> None:
        self._log = log
        self._entry: tuple | None = None
        self._credential_retry_after = 0.0
        self._lock = threading.Lock()
        self._metrics_lock = threading.Lock()
        self._hits = 0
        self._misses = 0
        self._refreshes = 0
        self._refresh_failures = 0
        self._refresh_samples: deque[int] = deque(maxlen=64)

    def load(self, revision: tuple, refresh) -> dict:
        """Return the providers for ``revision``, refreshing at most once.

        ``refresh`` returns ``(verified_revision, providers, elapsed_ms)``. It
        decides which work counts toward ``elapsed_ms`` and must have finished
        every safety re-check before returning, because only its result is
        allowed into the cache.
        """
        entry = self._entry
        if entry is not None and entry[0] == revision and (
            not self._credential_retry_after or time.monotonic() < self._credential_retry_after
        ):
            self._count_hit()
            return entry[1]
        self._count_miss()
        with self._lock:
            # Single-flight: if another thread refreshed while we waited, the
            # entry object has changed. That entry was verified by its own
            # refresh and is at least as fresh as the revision the caller
            # observed at entrance, so accept it instead of serializing one
            # refresh per waiter (design doc §3.2).
            refreshed = self._entry
            if refreshed is not None and refreshed is not entry:
                return refreshed[1]
            try:
                verified, providers, elapsed_ms = refresh()
            except (ProviderDatabaseError, sqlite3.Error, OSError) as exc:
                failures = self._count_refresh_failure()
                self._write_log(
                    f"provider_snapshot refresh_failed "
                    f"failures={failures} error={type(exc).__name__}"
                )
                if isinstance(exc, ProviderDatabaseError):
                    raise
                raise ProviderDatabaseError(
                    "provider database could not be read"
                ) from exc
            # Cache failures too: an unused locked account must not put every
            # Keychain lookup on every request. Retry on demand after a short
            # backoff, or immediately when the DB revision changes.
            failed = any(record.get("credential_error") for record in providers.values() if isinstance(record, dict))
            self._credential_retry_after = time.monotonic() + 2.0 if failed else 0.0
            self._entry = (verified, providers)
            metrics = self._count_refresh(elapsed_ms)
        self._write_log(
            f"provider_snapshot "
            f"refresh_ms={elapsed_ms} "
            f"hits={metrics['hits']} "
            f"misses={metrics['misses']} "
            f"refreshes={metrics['refreshes']} "
            f"p50_ms={metrics['p50_ms']} "
            f"p95_ms={metrics['p95_ms']}"
        )
        return providers

    def reset(self) -> None:
        """Drop the cached entry and zero the counters."""
        with self._lock:
            self._entry = None
            self._credential_retry_after = 0.0
        with self._metrics_lock:
            self._hits = 0
            self._misses = 0
            self._refreshes = 0
            self._refresh_failures = 0
            self._refresh_samples.clear()

    def metrics(self) -> dict:
        """Counter snapshot for diagnostics and tests."""
        with self._metrics_lock:
            return self._metrics_locked()

    def _metrics_locked(self) -> dict:
        return {
            "hits": self._hits,
            "misses": self._misses,
            "refreshes": self._refreshes,
            "refresh_failures": self._refresh_failures,
            "samples": len(self._refresh_samples),
            "p50_ms": _snapshot_percentile(self._refresh_samples, 50),
            "p95_ms": _snapshot_percentile(self._refresh_samples, 95),
        }

    def _write_log(self, message: str) -> None:
        if self._log is not None:
            self._log(message)

    def _count_hit(self) -> None:
        with self._metrics_lock:
            self._hits += 1

    def _count_miss(self) -> None:
        """Count a fast-path miss, before any refresh is attempted."""
        with self._metrics_lock:
            self._misses += 1

    def _count_refresh(self, elapsed_ms: int) -> dict:
        """Record a successful refresh and return the current counters."""
        with self._metrics_lock:
            self._refreshes += 1
            self._refresh_samples.append(elapsed_ms)
            return self._metrics_locked()

    def _count_refresh_failure(self) -> int:
        """Count a failed refresh and return the running failure total."""
        with self._metrics_lock:
            self._refresh_failures += 1
            return self._refresh_failures


# ----------------------------------------------------- database reading
#
# Below this line is what a refresh actually does; the cache above only
# decides whether it runs at all.


def _read_provider_snapshot(path: Path, *, warning=None) -> tuple:
    """Read a stable private main+WAL copy without opening the source SQLite DB.

    Returns ``(providers, verified_revision)`` where the revision is the
    ``_database_snapshot_state`` confirmed identical before and after copying.
    """
    wal_path, _shm_path = _sqlite_sidecars(path)
    last_error = None
    credential_reload = False
    for _attempt in range(DB_SNAPSHOT_RETRIES):
        before = _database_snapshot_state(path)
        if before[0] is None:
            raise ProviderDatabaseError("provider database file is missing")
        try:
            with tempfile.TemporaryDirectory(prefix="claude-hub-db-") as temp_dir:
                snapshot = Path(temp_dir) / "providers.db"
                shutil.copyfile(path, snapshot)
                snapshot.chmod(0o600)
                if before[1] is not None:
                    snapshot_wal = snapshot.with_name(snapshot.name + "-wal")
                    shutil.copyfile(wal_path, snapshot_wal)
                    snapshot_wal.chmod(0o600)
                after = _database_snapshot_state(path)
                if before != after:
                    continue
                try:
                    records = _read_provider_rows(snapshot, warning=warning)
                    missing = any(record.get("credential_error") == "credential_missing" for record in records.values())
                    if missing and not credential_reload and _database_snapshot_state(path) != before:
                        credential_reload = True
                        continue
                    return records, before
                except sqlite3.Error as exc:
                    last_error = exc
        except (FileNotFoundError, OSError) as exc:
            last_error = exc
            continue
    raise ProviderDatabaseError(
        "provider database changed while taking a read-only snapshot"
    ) from last_error


def _provider_record(values: dict, *, warning=None) -> tuple[str, str, dict] | None:
    """Turn one ``providers`` row into a runtime record, or ``None`` to skip it.

    A row is skipped -- never repaired and never guessed at -- when its
    settings, env or base URL cannot be read; a channel pointing at such a
    provider then fails to resolve instead of reaching an unintended upstream.
    """
    name = values["name"]
    provider_id = str(values.get("id") or name)
    settings_config = values["settings_config"]
    try:
        settings = json.loads(settings_config)
    except (json.JSONDecodeError, UnicodeError, TypeError):
        return None
    if not isinstance(settings, dict):
        return None
    try:
        meta = json.loads(values.get("meta") or "{}")
    except (json.JSONDecodeError, UnicodeError, TypeError):
        meta = {}
    if not isinstance(meta, dict):
        meta = {}
    credential_error = None
    try:
        settings, meta = resolve_credentials(values, "claude", settings, meta, warning=warning)
    except CredentialError as exc:
        # Keep the non-secret identity visible so selection reports the actual
        # credential failure. No token from the persisted row may escape here.
        credential_error = exc.code
        settings, meta = without_secrets(settings), without_secrets(meta)
    env = settings.get("env") or {}
    if not isinstance(env, dict):
        return None
    is_full_url = meta.get("isFullUrl") is True
    raw_base = env.get("ANTHROPIC_BASE_URL")
    base = normalize_account_endpoint(
        raw_base,
        is_full_url=is_full_url,
    )
    if not base:
        return None
    auth_token = env.get("ANTHROPIC_AUTH_TOKEN")
    api_key = env.get("ANTHROPIC_API_KEY")
    if isinstance(auth_token, str) and auth_token:
        token = auth_token
        credential_type = "ANTHROPIC_AUTH_TOKEN"
    elif isinstance(api_key, str) and api_key:
        token = api_key
        credential_type = "ANTHROPIC_API_KEY"
    else:
        token = ""
        credential_type = ""
    if credential_error:
        token, credential_type = "", ""
    folded_env = {
        str(key).upper(): value for key, value in env.items()
    }
    proxy_key = "HTTPS_PROXY" if base.startswith("https://") else "HTTP_PROXY"
    raw_proxy = folded_env.get(proxy_key) or folded_env.get("ALL_PROXY")
    provider_proxy = (
        raw_proxy.strip()
        if isinstance(raw_proxy, str) and raw_proxy.strip()
        else None
    )
    provider_transport = None
    transport_error = None
    if "transport" in settings:
        try:
            provider_transport = normalize_transport_config(
                settings["transport"]
            )
        except TransportConfigError as exc:
            transport_error = str(exc)
    record = {
        "selector": f"id:{provider_id}",
        "name": name,
        "base_url": base,
        "token": token,
        "credential_type": credential_type,
        "credential_error": credential_error,
        "credential_ref": values.get("credential_ref"),
        "credential_revision": values.get("revision", 0),
        "proxy": provider_proxy,
        "transport": provider_transport,
        "transport_error": transport_error,
        "api_format": provider_api_format(
            meta=meta,
            settings=settings,
            provider_type=values.get("provider_type"),
        ),
        "provider_type": (
            values.get("provider_type") or meta.get("providerType")
        ),
        "is_full_url": is_full_url,
        "model_map": {
            tier: (
                value.strip()
                if isinstance(
                    value := env.get(
                        f"ANTHROPIC_DEFAULT_{tier.upper()}_MODEL"
                    ),
                    str,
                )
                and value.strip()
                else None
            )
            for tier in ("opus", "sonnet", "haiku", "fable")
        },
    }
    return provider_id, name, record


def _read_provider_rows(path: Path, *, warning=None) -> dict:
    """Read provider rows without mutating the database or contacting providers."""
    db_uri = path.resolve(strict=False).as_uri() + "?mode=ro"
    conn = sqlite3.connect(db_uri, uri=True)
    try:
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(providers)").fetchall()
        }
        selected = ["name", "settings_config"]
        if "id" in columns:
            selected.insert(0, "id")
        selected.extend(
            column for column in ("meta", "provider_type", *CREDENTIAL_COLUMNS) if column in columns
        )
        cursor = conn.execute(
            f"SELECT {', '.join(selected)} FROM providers "
            "WHERE app_type='claude'"
        )
        records: list[tuple[str, str, dict]] = []
        for raw_row in cursor.fetchall():
            entry = _provider_record(dict(zip(selected, raw_row)), warning=warning)
            if entry is not None:
                records.append(entry)
        name_counts: dict[str, int] = {}
        for _provider_id, name, _record in records:
            name_counts[name] = name_counts.get(name, 0) + 1
        rows = {}
        for provider_id, name, record in records:
            rows[f"id:{provider_id}"] = record
            if name_counts[name] == 1:
                rows[name] = record
        return rows
    finally:
        conn.close()


# -------------------------------------------------- filesystem revision


def _sqlite_sidecars(path: Path) -> tuple[Path, Path]:
    return (
        path.with_name(path.name + "-wal"),
        path.with_name(path.name + "-shm"),
    )


def _snapshot_fingerprint(path: Path) -> tuple | None:
    try:
        st = path.stat()
    except FileNotFoundError:
        return None
    return (
        st.st_dev,
        st.st_ino,
        st.st_size,
        st.st_mtime_ns,
        st.st_ctime_ns,
    )


def _database_snapshot_state(path: Path) -> tuple:
    wal_path, _shm_path = _sqlite_sidecars(path)
    return (_snapshot_fingerprint(path), _snapshot_fingerprint(wal_path))
