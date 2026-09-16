"""Provider credential read boundary (stdlib only, no persistence or plaintext fallback).

The versioned envelope is shared with provider-store. Persisted rows are never
mutated; only fresh runtime objects receive secrets. Standalone UUIDs retain
their separate API and namespace.
"""
from __future__ import annotations

import copy
import hashlib
import json
import platform
import re
import subprocess
import threading
import tomllib
import warnings
from urllib.parse import urlsplit

SERVICE = "claude-hub"
REFERENCE = re.compile(r"provider/v1/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\Z")
CREDENTIAL_COLUMNS = ("credential_ref", "credential_version", "revision")


class CredentialError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def _status_error(status: int) -> CredentialError:
    return CredentialError({-25300: "credential_missing", -128: "credential_denied",
        -25293: "credential_denied", -25308: "credential_locked",
        -26275: "credential_corrupt"}.get(status, "credential_unavailable"))


def read_secret(reference: str) -> bytes:
    if not isinstance(reference, str) or not REFERENCE.fullmatch(reference):
        raise CredentialError("credential_corrupt")
    if platform.system() == "Windows":
        return _windows_read(reference)
    if platform.system() != "Darwin":
        raise CredentialError("credential_unavailable")
    command = f"find-generic-password -s {SERVICE} -a {reference} -w\n"
    try:
        result = subprocess.run(["/usr/bin/security", "-i"], input=command.encode(),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15)
    except subprocess.TimeoutExpired:
        raise CredentialError("credential_timeout") from None
    except OSError:
        raise CredentialError("credential_unavailable") from None
    if result.returncode:
        match = re.search(rb"find-generic-password: returned (-?\d+)\s*$", result.stderr)
        if match:
            raise _status_error(int(match[1]))
        raise CredentialError("credential_unavailable")
    output = result.stdout.removesuffix(b"\n")
    if output and len(output) % 2 == 0 and re.fullmatch(rb"[0-9a-fA-F]+", output):
        output = bytes.fromhex(output.decode("ascii"))
    return output


def _windows_read(reference: str) -> bytes:
    import ctypes
    from ctypes import wintypes
    class Credential(ctypes.Structure):
        _fields_ = [("Flags", wintypes.DWORD), ("Type", wintypes.DWORD),
            ("TargetName", wintypes.LPWSTR), ("Comment", wintypes.LPWSTR),
            ("LastWritten", wintypes.FILETIME), ("CredentialBlobSize", wintypes.DWORD),
            ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", wintypes.DWORD),
            ("AttributeCount", wintypes.DWORD), ("Attributes", ctypes.c_void_p),
            ("TargetAlias", wintypes.LPWSTR), ("UserName", wintypes.LPWSTR)]
    api = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
    api.CredReadW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                            ctypes.POINTER(ctypes.POINTER(Credential))]
    api.CredReadW.restype = wintypes.BOOL
    api.CredFree.argtypes = [ctypes.c_void_p]
    api.CredFree.restype = None
    pointer = ctypes.POINTER(Credential)()
    if not api.CredReadW(f"{SERVICE}:{reference}", 1, 0, ctypes.byref(pointer)):
        code = ctypes.get_last_error()
        raise CredentialError({1168: "credential_missing", 5: "credential_denied",
            1312: "credential_locked"}.get(code, "credential_unavailable"))
    try:
        if pointer.contents.CredentialBlobSize > 2560:
            raise CredentialError("credential_corrupt")
        return ctypes.string_at(pointer.contents.CredentialBlob, pointer.contents.CredentialBlobSize)
    finally:
        api.CredFree(pointer)


def _overlay(target: dict, secret: dict) -> None:
    for key, value in secret.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            _overlay(target[key], value)
        else:
            target[key] = copy.deepcopy(value)


def _secret_key(key: str) -> bool:
    key = key.lower().replace("-", "_")
    return (key in {"auth", "authorization", "proxy_authorization", "apikey", "api_key",
        "token", "tokens", "password", "secret", "experimental_bearer_token"}
        or key.endswith(("_api_key", "_auth_token", "_access_token", "_refresh_token", "_id_token", "_password")))


def contains_secret(value) -> bool:
    if isinstance(value, dict):
        return any((_secret_key(key) and item not in (None, "", {})) or contains_secret(item)
                   for key, item in value.items())
    if isinstance(value, list):
        return any(contains_secret(item) for item in value)
    if isinstance(value, str) and "://" in value:
        try:
            return urlsplit(value).username is not None
        except ValueError:
            return True
    return False


def without_secrets(value):
    if isinstance(value, dict):
        clean = {}
        for key, item in value.items():
            if _secret_key(key):
                continue
            if key == "config" and isinstance(item, str):
                try:
                    if contains_secret(tomllib.loads(item)):
                        continue
                except tomllib.TOMLDecodeError:
                    raise CredentialError("credential_corrupt") from None
            if isinstance(item, (str, list)) and contains_secret(item):
                continue
            clean[key] = without_secrets(item)
        return clean
    return copy.deepcopy(value)


def decode_envelope(raw: bytes, app: str, provider_id: str, revision: int) -> dict:
    def unique_object(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError()
            result[key] = value
        return result
    def invalid_constant(_):
        raise ValueError()
    try:
        payload = json.loads(raw, object_pairs_hook=unique_object, parse_constant=invalid_constant)
        valid = (isinstance(payload, dict) and type(payload.get("version")) is int
            and payload["version"] == 1 and app in ("claude", "codex")
            and payload.get("app_type") == app and payload.get("provider_id") == provider_id
            and type(revision) is int and revision > 0
            and type(payload.get("revision")) is int and payload["revision"] == revision
            and isinstance(payload.get("settings"), dict) and isinstance(payload.get("meta"), dict))
        if not valid:
            raise ValueError()
        return payload
    except (ValueError, TypeError, UnicodeError, RecursionError):
        raise CredentialError("credential_corrupt") from None


_warned: set[tuple] = set()
_warning_lock = threading.Lock()


def credential_status(row: dict) -> str:
    """Metadata-only status; never opens the system store."""
    return "referenced" if row.get("credential_ref") is not None else "legacy"


def resolve(row, app: str, settings: dict, meta: dict | None = None, *, reader=None,
            warning=None) -> tuple[dict, dict]:
    row = dict(row)
    reference = row.get("credential_ref")
    result, result_meta = copy.deepcopy(settings), copy.deepcopy(meta or {})
    if reference is None:
        # Warnings carry no user-controlled name, endpoint or secret. Callers can
        # route this structured event to their journal instead of stderr.
        if contains_secret(settings) or contains_secret(result_meta):
            identity = (app, str(row.get("id", "")), row.get("revision", 0), hashlib.sha256(str(row.get("settings_config", "")).encode()).digest())
            with _warning_lock:
                fresh = identity not in _warned
                if fresh:
                    if len(_warned) >= 4096:
                        _warned.clear()
                    _warned.add(identity)
            if fresh:
                event = {"code": "credential_legacy_plaintext", "app_type": app,
                         "revision": row.get("revision", 0)}
                if warning:
                    warning(event)
                else:
                    warnings.warn("credential_legacy_plaintext: explicit migration available", RuntimeWarning, stacklevel=2)
        return result, result_meta
    if not isinstance(reference, str) or not REFERENCE.fullmatch(reference) or row.get("credential_version") != 1:
        raise CredentialError("credential_corrupt")
    payload = decode_envelope((reader or read_secret)(reference), app, str(row.get("id", "")), row.get("revision"))
    # A reference makes the OS payload authoritative, including absent fields.
    # Old token aliases must not outrank a newly selected API-key credential.
    result, result_meta = without_secrets(result), without_secrets(result_meta)
    _overlay(result, payload["settings"])
    _overlay(result_meta, payload["meta"])
    return result, result_meta
