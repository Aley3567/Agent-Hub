"""Hub configuration interpretation: raw document in, normalized config out.

`claude-hub.py` owns *reading* the external facts -- resolving the config path,
checking its 0600 permissions, caching the parsed JSON by path/mtime/size and
deciding whether the CC Switch provider snapshot is needed at all.  This module
owns *interpreting* them, and nothing else.  The readers live in `claude-hub.py`
and this module never imports it, so "the normalizer performs no I/O" is a
structural property here -- there is no name in scope that could open the config
file, the provider database or a socket -- rather than a convention a later edit
could quietly break.

Invariants
    - Every external fact is an argument: ``raw`` (the parsed document),
      ``providers`` (the already-read snapshot, ``None`` when no route group
      declares ``requires``) and ``env`` (the mapping supplying the port and
      local-token overrides).
    - The returned dictionary is detached from ``raw``; a caller may hold it for
      the lifetime of a request without aliasing the cached document.
    - Field order is part of the contract, because it decides which error a
      half-broken config reports first: root -> version -> instance_id ->
      channels -> default_channel -> routes -> v2 slots/effort ->
      local_token_env/local_token -> proxy -> transport -> port.

Error mode
    Exactly one: ``ConfigError``, naming the offending field.  Transport errors
    from ``claude1_transport`` are translated into it rather than escaping.

Owner
    This module is the only definition site for ``ConfigError``, ``ENV_PORT``
    and ``ENV_LOCAL_TOKEN``; ``claude-hub.py`` re-imports all three.
"""

from __future__ import annotations

import re
from collections.abc import Mapping

from claude1_account_pool import normalize_account_endpoint
from claude1_protocol import protocol_capability_matrix
from claude1_routing import HUB_SLOT_ORDER, match_channel_provider
from claude1_transport import TransportConfigError, normalize_transport_config


ENV_PORT = "CLAUDE_HUB_PORT"
ENV_LOCAL_TOKEN = "CLAUDE_HUB_LOCAL_TOKEN"

HUB_EFFORT_LEVELS = {"low", "medium", "high", "xhigh"}
HUB_INSTANCE_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")


class ConfigError(ValueError):
    """The hub configuration is missing or unsafe to use."""


def validate_config(
    raw: object,
    providers: dict | None = None,
    *,
    env: Mapping[str, str],
) -> dict:
    """Validate and return a normalized, detached configuration dictionary.

    Pure interpretation: every external fact arrives as an argument. ``raw`` is
    the parsed config document, ``providers`` the already-read CC Switch
    snapshot (``None`` when no route group declares ``requires``), and ``env``
    the environment mapping supplying the port and local-token overrides. The
    function reads no file, no database and no process state, so its only
    failure mode is ``ConfigError`` describing the offending field.
    """
    if not isinstance(raw, dict):
        raise ConfigError("config root must be a JSON object")

    version = raw.get("version", 1)
    if type(version) is not int or version not in (1, 2):
        raise ConfigError("version must be 1 or 2")

    instance_id = None
    if "instance_id" in raw:
        instance_id_raw = raw["instance_id"]
        if not isinstance(instance_id_raw, str) or not HUB_INSTANCE_ID_RE.fullmatch(
            instance_id_raw
        ):
            raise ConfigError(
                "instance_id must be 1-128 ASCII letters, digits, dots, underscores, "
                "or hyphens, beginning with a letter or digit"
            )
        instance_id = instance_id_raw

    channels = _validate_channels(raw.get("channels"))

    default_channel = _require_nonempty_string(
        raw.get("default_channel"), "default_channel"
    ).lower()
    if default_channel not in channels:
        raise ConfigError(f"default_channel '{default_channel}' is not present in channels")

    routes = _validate_routes(raw.get("routes"), channels, providers)

    launch_slot = None
    model_slots = None
    effort_by_slot = None
    if version == 2:
        launch_slot, model_slots, effort_by_slot = _validate_slot_mapping(
            raw, channels
        )

    token_env = raw.get("local_token_env", ENV_LOCAL_TOKEN)
    token_env = _require_nonempty_string(token_env, "local_token_env")
    local_token = env.get(token_env) or raw.get("local_token")
    local_token = _require_nonempty_string(
        local_token,
        f"local_token (or environment variable {token_env})",
    )

    proxy = raw.get("proxy")
    if proxy is not None and (not isinstance(proxy, str) or not proxy.strip()):
        raise ConfigError("proxy must be a non-empty string or null")

    try:
        transport = normalize_transport_config(raw.get("transport"))
    except TransportConfigError as exc:
        raise ConfigError(str(exc)) from exc

    return {
        "version": version,
        "instance_id": instance_id,
        "port": _config_port(raw.get("port"), env.get(ENV_PORT)),
        "local_token": local_token,
        "default_channel": default_channel,
        "channels": channels,
        "routes": routes,
        "proxy": proxy.strip() if isinstance(proxy, str) else None,
        "transport": transport,
        "launch_slot": launch_slot,
        "model_slots": model_slots,
        "effort_by_slot": effort_by_slot,
    }


# --------------------------------------------- section and field helpers
#
# Below this line is the machinery ``validate_config`` dispatches to; the
# flow above says in what order, and that order is the contract.


def _require_nonempty_string(value: object, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ConfigError(f"{field} must be a non-empty string")
    return value.strip()


def _config_port(raw: object, override: str | None) -> int:
    """Interpret the configured port, letting a non-empty env override win."""
    value = override if override not in (None, "") else raw
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ConfigError("port must be an integer between 1 and 65535")
    if isinstance(value, str) and not value.strip().isdigit():
        raise ConfigError("port must be an integer between 1 and 65535")
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise ConfigError("port must be an integer between 1 and 65535") from exc
    if not 1 <= port <= 65535:
        raise ConfigError("port must be an integer between 1 and 65535")
    return port


def _normalize_base_url(value: object) -> str:
    # Forwarded paths already begin with /v1. Avoid /v1/v1/messages.
    return normalize_account_endpoint(value)


def _validate_routes(
    raw: object,
    channels: dict[str, dict],
    providers: dict | None = None,
) -> dict[str, dict]:
    """Validate explicit provider route groups against declared channels.

    Each route group is an ordered list of ``{"channel", "model"}`` targets;
    every target must reference an existing channel and a model that channel
    declares, so model IDs are never guessed across providers. An optional
    ``requires`` list names protocol capabilities that must not be rejected
    by the target's effective API format. ``providers`` supplies the CC
    Switch snapshot used to resolve that format exactly the way runtime
    dispatch does; without it only channel-declared overrides are checked.
    """
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ConfigError("routes must be an object")
    matrix = protocol_capability_matrix()
    routes: dict[str, dict] = {}
    for name, entry in raw.items():
        if not isinstance(name, str) or not name.strip():
            raise ConfigError("route names must be non-empty strings")
        if name != name.strip().lower():
            raise ConfigError(
                f"route name '{name}' must be lowercase without outer spaces"
            )
        requires_raw: object = []
        targets_raw: object = entry
        if isinstance(entry, dict):
            targets_raw = entry.get("targets")
            requires_raw = entry.get("requires", [])
        if not isinstance(targets_raw, list) or not targets_raw:
            raise ConfigError(f"routes.{name} must be a non-empty list of targets")
        if not isinstance(requires_raw, list) or any(
            not isinstance(capability, str) for capability in requires_raw
        ):
            raise ConfigError(f"routes.{name}.requires must be a list of strings")
        requires = []
        for capability in requires_raw:
            if capability not in matrix:
                raise ConfigError(
                    f"routes.{name}.requires names unknown capability "
                    f"'{capability}'"
                )
            requires.append(capability)
        targets: list[dict] = []
        for index, target_raw in enumerate(targets_raw):
            where = f"routes.{name}[{index}]"
            if not isinstance(target_raw, dict):
                raise ConfigError(f"{where} must be an object")
            alias = target_raw.get("channel")
            if not isinstance(alias, str) or not alias.strip():
                raise ConfigError(f"{where}.channel must be a non-empty string")
            alias = alias.strip().lower()
            channel = channels.get(alias)
            if channel is None:
                raise ConfigError(
                    f"{where}.channel references unknown channel '{alias}'"
                )
            model = target_raw.get("model")
            if not isinstance(model, str) or not model.strip():
                raise ConfigError(f"{where}.model must be a non-empty string")
            model = model.strip()
            if model not in channel["models"]:
                raise ConfigError(
                    f"{where}.model '{model}' is not declared in "
                    f"channels.{alias}.models"
                )
            # Resolve the target's effective API format the same way runtime
            # dispatch does: an explicit channel override wins, otherwise the
            # provider record carries the format that provider_api_format()
            # derived from the database meta when the snapshot was read.
            api_format = channel.get("api_format")
            if not api_format and providers:
                provider = match_channel_provider(channel, providers)
                if provider is not None:
                    api_format = provider.get("api_format")
            api_format = api_format or "anthropic"
            for capability in requires:
                if matrix[capability].get(api_format) == "reject":
                    raise ConfigError(
                        f"{where} cannot satisfy required capability "
                        f"'{capability}': the {api_format} adapter rejects it"
                    )
            targets.append({"channel": alias, "model": model})
        routes[name] = {"targets": targets, "requires": requires}
    return routes


def _validate_channels(channels_raw: object) -> dict[str, dict]:
    """Normalize every declared channel, in declaration order.

    A channel is validated to completion before the next alias starts, so a
    config with several broken channels reports the first one.
    """
    if not isinstance(channels_raw, dict) or not channels_raw:
        raise ConfigError("channels must be a non-empty object")

    channels: dict[str, dict] = {}
    for alias, channel_raw in channels_raw.items():
        if not isinstance(alias, str) or not alias.strip():
            raise ConfigError("channel aliases must be non-empty strings")
        if alias != alias.strip().lower():
            raise ConfigError(f"channel alias '{alias}' must be lowercase without outer spaces")
        if not isinstance(channel_raw, dict):
            raise ConfigError(f"channels.{alias} must be an object")

        provider_raw = channel_raw.get("provider")
        provider = (
            provider_raw.strip()
            if isinstance(provider_raw, str) and provider_raw.strip()
            else ""
        )
        provider_base_url = _normalize_base_url(channel_raw.get("base_url"))
        if not provider and not provider_base_url:
            raise ConfigError(
                f"channels.{alias}.provider or base_url must be a non-empty string"
            )
        models_raw = channel_raw.get("models", [])
        if not isinstance(models_raw, list) or any(
            not isinstance(model, str) or not model.strip() for model in models_raw
        ):
            raise ConfigError(f"channels.{alias}.models must be a list of non-empty strings")

        allow_insecure = channel_raw.get("allow_insecure_http", False)
        if not isinstance(allow_insecure, bool):
            raise ConfigError(f"channels.{alias}.allow_insecure_http must be a boolean")

        route_unknown = channel_raw.get("route_unknown_to_default", False)
        if not isinstance(route_unknown, bool):
            raise ConfigError(
                f"channels.{alias}.route_unknown_to_default must be a boolean"
            )

        channel = {
            "provider": provider,
            "provider_base_url": provider_base_url,
            "models": [model.strip() for model in models_raw],
            "allow_insecure_http": allow_insecure,
            "route_unknown_to_default": route_unknown,
        }
        if "transport" in channel_raw:
            try:
                channel["transport"] = normalize_transport_config(
                    channel_raw["transport"]
                )
            except TransportConfigError as exc:
                raise ConfigError(f"channels.{alias}.{exc}") from exc
        api_format = channel_raw.get("api_format")
        if api_format is not None:
            if api_format not in {
                "anthropic",
                "openai_chat",
                "openai_responses",
            }:
                raise ConfigError(
                    f"channels.{alias}.api_format must be anthropic, "
                    "openai_chat, or openai_responses"
                )
            channel["api_format"] = api_format
        native_system_role_mode = channel_raw.get("native_system_role_mode")
        if native_system_role_mode is not None:
            if native_system_role_mode not in {"passthrough", "promote"}:
                raise ConfigError(
                    f"channels.{alias}.native_system_role_mode must be "
                    "passthrough or promote"
                )
            channel["native_system_role_mode"] = native_system_role_mode
        if "proxy" in channel_raw:
            proxy = channel_raw["proxy"]
            if proxy is not None and (not isinstance(proxy, str) or not proxy.strip()):
                raise ConfigError(f"channels.{alias}.proxy must be a non-empty string or null")
            channel["proxy"] = proxy.strip() if isinstance(proxy, str) else None
        channels[alias] = channel
    return channels


def _validate_slot_mapping(
    raw: dict,
    channels: dict[str, dict],
) -> tuple[str, dict[str, str], dict[str, str]]:
    """Validate the version-2 launch slot, model slots and effort levels.

    Every slot must resolve to a model the target channel declares, so a slot
    can never introduce a model ID that routing would have to guess.
    """
    launch_slot = raw.get("launch_slot")
    if launch_slot not in HUB_SLOT_ORDER:
        raise ConfigError("launch_slot must be fable, opus, sonnet, or haiku")
    model_slots = raw.get("model_slots")
    if not isinstance(model_slots, dict):
        raise ConfigError("model_slots must be an object")
    normalized_slots: dict[str, str] = {}
    for slot in HUB_SLOT_ORDER:
        selector = model_slots.get(slot)
        if not isinstance(selector, str):
            raise ConfigError(f"model_slots.{slot} must be channel,model")
        alias, separator, model = selector.strip().partition(",")
        alias, model = alias.strip().lower(), model.strip()
        if (
            not separator
            or alias not in channels
            or model not in channels[alias]["models"]
        ):
            raise ConfigError(
                f"model_slots.{slot} must reference a declared channel model"
            )
        normalized_slots[slot] = f"{alias},{model}"
    model_slots = normalized_slots
    effort_by_slot = raw.get("effort_by_slot")
    if not isinstance(effort_by_slot, dict):
        raise ConfigError("effort_by_slot must be an object")
    normalized_efforts: dict[str, str] = {}
    for slot in HUB_SLOT_ORDER:
        effort = effort_by_slot.get(slot)
        if effort not in HUB_EFFORT_LEVELS:
            raise ConfigError(
                f"effort_by_slot.{slot} must be low, medium, high, or xhigh"
            )
        normalized_efforts[slot] = effort
    effort_by_slot = normalized_efforts
    return launch_slot, model_slots, effort_by_slot
