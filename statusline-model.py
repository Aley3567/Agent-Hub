#!/usr/bin/env python3
"""Resolve the real model for a Claude Code statusLine payload.

Reads one statusLine JSON object from stdin and prints one raw model id/name.
The resolver is intentionally layout-free so an existing statusline can use it
without handing its colors, context meter, or cost display to claude1.
"""

from __future__ import annotations

import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from ipaddress import ip_address
from pathlib import Path
from urllib.parse import urlparse


MODEL_TIERS = ("FABLE", "OPUS", "SONNET", "HAIKU")
META_TYPES = {
    "attachment",
    "mode",
    "permission-mode",
    "last-prompt",
}
TRANSCRIPT_TAIL_BYTES = 256 * 1024
TRANSCRIPT_TAIL_LINES = 400


def _tail_lines(
    path: Path,
    *,
    max_bytes: int = TRANSCRIPT_TAIL_BYTES,
    max_lines: int = TRANSCRIPT_TAIL_LINES,
) -> list[str]:
    with path.open("rb") as stream:
        stream.seek(0, os.SEEK_END)
        size = stream.tell()
        start = max(0, size - max_bytes)
        stream.seek(start - 1 if start else 0)
        tail = stream.read(max_bytes + 1 if start else max_bytes)

    if start:
        starts_mid_line = tail[:1] != b"\n"
        tail = tail[1:]
        if starts_mid_line:
            _, separator, tail = tail.partition(b"\n")
            if not separator:
                return []
    return tail.decode("utf-8", errors="replace").splitlines()[-max_lines:]


def _timestamp(value: object) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _is_meta_entry(entry: dict) -> bool:
    kind = str(entry.get("type") or "")
    if kind in META_TYPES or kind.startswith("file-history-"):
        return True
    message = entry.get("message")
    return bool(
        entry.get("sourceToolAssistantUUID")
        or entry.get("toolUseResult") is not None
        or entry.get("isMeta")
        or entry.get("is_meta")
        or (
            isinstance(message, dict)
            and (message.get("isMeta") or message.get("is_meta"))
        )
    )


def latest_response_model(
    transcript_path: object,
    *,
    now: float | None = None,
    max_age_seconds: float = 1800,
) -> str:
    if not isinstance(transcript_path, str) or not transcript_path:
        return ""
    path = Path(transcript_path).expanduser()
    if not path.is_file():
        return ""
    assistant: tuple[float, str] | None = None
    latest_semantic: float | None = None
    try:
        lines = _tail_lines(path)
    except OSError:
        return ""
    for line in lines:
        try:
            entry = json.loads(line)
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(entry, dict):
            continue
        stamp = _timestamp(entry.get("timestamp"))
        if stamp is None:
            continue
        kind = entry.get("type")
        if kind == "assistant":
            message = entry.get("message")
            model = message.get("model") if isinstance(message, dict) else None
            if isinstance(model, str) and model and model != "<synthetic>":
                assistant = (stamp, model)
        elif kind == "user" and not _is_meta_entry(entry):
            latest_semantic = stamp
    if assistant is None:
        return ""
    stamp, model = assistant
    current = datetime.now(timezone.utc).timestamp() if now is None else now
    if latest_semantic is not None and stamp < latest_semantic:
        return ""
    if current - stamp >= max_age_seconds:
        return ""
    return model


def _string_env(raw: object) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    return {
        str(key): str(value)
        for key, value in raw.items()
        if isinstance(key, str) and value is not None
    }


def _exact_slot_model(model_id: str, env: dict[str, str]) -> str:
    """Return the owning slot's display value when ``model_id`` is configured.

    An official-shaped id is not automatically a tier placeholder: a slot
    mapped to a real Anthropic model (e.g. fable -> claude-opus-5-*) makes
    /model report that concrete id, and only exact equality with a slot value
    ties it back to the slot that actually serves it.
    """
    if not model_id:
        return ""
    for tier in MODEL_TIERS:
        model_key = f"ANTHROPIC_DEFAULT_{tier}_MODEL"
        if env.get(model_key) == model_id:
            return env.get(f"{model_key}_NAME") or model_id
    if env.get("ANTHROPIC_CUSTOM_MODEL_OPTION") == model_id:
        return env.get("ANTHROPIC_CUSTOM_MODEL_OPTION_NAME") or model_id
    return ""


def _model_from_env(model_id: str, env: dict[str, str]) -> str:
    if not model_id:
        return env.get("ANTHROPIC_MODEL", "")
    return _exact_slot_model(model_id, env) or model_id


def _gateway_selector_model(model_id: str) -> str:
    """Return the model behind a Hub gateway selector id, when it is one.

    ``handle_models`` advertises ids shaped ``anthropic/<alias>,<model>``, so a
    channel switch performed inside the session is visible here and nowhere
    else: ``CLAUDE1_CHANNEL_SELECTOR`` is frozen at launch and keeps naming the
    startup channel for the whole process.  An id missing either half is left
    to the other resolvers, which own every non-gateway shape.

    The comma is the split point, not the slash: an upstream model name may
    itself contain slashes (``route-a,Qwen/Qwen3.5-9B``) while a channel alias
    never contains a comma.
    """
    prefix, separator, model = model_id.partition(",")
    alias = prefix.rpartition("/")[2]
    if separator and alias and model:
        return model
    return ""


def _slot_model_from_placeholder(model_id: str, env: dict[str, str]) -> str:
    """Return the slot model behind an official Anthropic tier placeholder.

    claude-hub keeps Anthropic's own id (``claude-opus-4-8``) as the slot key
    while routing that tier to a completely different channel, so a slot picked
    in /model is recognisable only by the tier word in the id -- an exact slot
    value match cannot succeed.  Deliberately limited to the official
    ``claude-<tier>-`` shape: a third-party id must still match a slot value
    exactly and is never resolved by keyword.
    """
    lowered = model_id.lower()
    for tier in MODEL_TIERS:
        if not lowered.startswith(f"claude-{tier.lower()}-"):
            continue
        slot_key = f"ANTHROPIC_DEFAULT_{tier}_MODEL"
        selector = env.get(slot_key, "")
        if not selector:
            return ""
        name = env.get(f"{slot_key}_NAME", "")
        if name:
            return name
        _alias, separator, model = selector.partition(",")
        return model if separator and model else selector
    return ""


def _claude1_live_route_model(env: dict[str, str]) -> str:
    """Return the model selected by claude1, when this is a claude1 process."""
    source = env.get("CLAUDE1_SESSION_SOURCE", "")
    if source == "hub":
        selector = env.get("CLAUDE1_CHANNEL_SELECTOR", "")
        _alias, separator, model = selector.partition(",")
        return model if separator and model else selector
    if source == "provider":
        model = env.get("ANTHROPIC_MODEL", "")
        if model:
            return model
        for tier in MODEL_TIERS:
            model = env.get(f"ANTHROPIC_DEFAULT_{tier}_MODEL", "")
            if model:
                return env.get(f"ANTHROPIC_DEFAULT_{tier}_MODEL_NAME") or model
    return ""


def _is_official_tier_placeholder(model_id: str) -> bool:
    """Whether Claude Code's stdin id is an official tier placeholder.

    Claude Code keeps the id ``claude-opus-*``/``claude-sonnet-*`` when a
    claude1 provider maps that tier to a third-party model.  In that one case
    the process environment is the only source of the real route.  A concrete
    third-party id, however, is already the authoritative result of an
    in-session ``/model`` switch and must never be replaced by the startup
    model from ``ANTHROPIC_MODEL``.
    """
    lowered = model_id.casefold()
    return any(lowered.startswith(f"claude-{tier.casefold()}-") for tier in MODEL_TIERS)


def _current_provider_env(db_path: Path) -> dict[str, str]:
    if not db_path.is_file():
        return {}
    uri = db_path.resolve(strict=False).as_uri() + "?mode=ro"
    connection = None
    try:
        connection = sqlite3.connect(uri, uri=True)
        rows = connection.execute(
            "SELECT settings_config FROM providers "
            "WHERE app_type='claude' AND is_current=1"
        ).fetchall()
    except sqlite3.Error:
        return {}
    finally:
        if connection is not None:
            connection.close()
    if len(rows) != 1:
        return {}
    try:
        settings = json.loads(rows[0][0] or "{}")
    except (json.JSONDecodeError, TypeError):
        return {}
    return _string_env(settings.get("env") if isinstance(settings, dict) else None)


def mapped_model(payload: dict, process_env: dict[str, str]) -> str:
    model = payload.get("model")
    model_id = str(model.get("id") or "") if isinstance(model, dict) else ""
    mapped = _model_from_env(model_id, process_env)
    if mapped != model_id or not model_id:
        return mapped

    base_url = process_env.get("ANTHROPIC_BASE_URL", "")
    if not base_url:
        settings_path = Path.home() / ".claude" / "settings.json"
        try:
            settings = json.loads(settings_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError):
            settings = {}
        env = settings.get("env") if isinstance(settings, dict) else None
        settings_env = _string_env(env)
        base_url = settings_env.get("ANTHROPIC_BASE_URL", "")
    try:
        host = urlparse(base_url).hostname or ""
        is_loopback = host == "localhost" or ip_address(host).is_loopback
    except ValueError:
        is_loopback = False
    if not is_loopback:
        return mapped

    db_path = Path(
        process_env.get(
            "CLAUDE1_DB_PATH",
            str(Path.home() / ".cc-switch" / "cc-switch.db"),
        )
    ).expanduser()
    return _model_from_env(model_id, _current_provider_env(db_path))


def _without_1m(model: str) -> str:
    lowered = model.lower()
    return model[:-4] if lowered.endswith("[1m]") else model


def resolve_model(
    payload: dict,
    process_env: dict[str, str] | None = None,
    *,
    now: float | None = None,
) -> str:
    env = dict(os.environ if process_env is None else process_env)
    model = payload.get("model")
    ui_name = str(model.get("display_name") or "?") if isinstance(model, dict) else "?"
    model_id = str(model.get("id") or "") if isinstance(model, dict) else ""
    gateway_route = _gateway_selector_model(model_id)
    if gateway_route:
        return gateway_route
    # Exact slot-value equality is a stronger signal than the tier-word guess
    # below: a slot mapped to a real Anthropic id (fable -> claude-opus-5-*)
    # reports that official-shaped id, and it belongs to the slot that serves
    # it, not to the tier named by its prefix.
    exact_route = _exact_slot_model(model_id, env)
    if exact_route:
        return exact_route
    slot_route = _slot_model_from_placeholder(model_id, env)
    if slot_route:
        return slot_route
    mapped = mapped_model(payload, env)
    # For a concrete third-party id, stdin reflects the model selected by the
    # current session.  The launcher env is only a startup fallback for the
    # official tier placeholders (or when Claude omitted the id altogether).
    if (
        not model_id
        or _is_official_tier_placeholder(model_id)
        or model_id.casefold().startswith("anthropic/")
    ):
        live_route = _claude1_live_route_model(env)
        if live_route:
            return live_route
    actual = latest_response_model(payload.get("transcript_path"), now=now)
    if actual:
        if mapped and _without_1m(mapped) == _without_1m(actual):
            return mapped
        return actual
    return mapped or model_id or ui_name


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, TypeError):
        print("?", end="")
        return 1
    if not isinstance(payload, dict):
        print("?", end="")
        return 1
    print(resolve_model(payload), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
