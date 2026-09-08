"""Model selectors and channel matching, without database or network I/O.

The HTTP handler owns reading configuration and the provider snapshot. This
module only decides which configured channel and model that request selects.
"""

from __future__ import annotations

import re

from claude1_account_pool import normalize_account_endpoint


HUB_SLOT_ORDER = ("fable", "opus", "sonnet", "haiku")
ROUTE_GROUP_PREFIX = "route:"


class RouteError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


def route_group_name(model_in: str, cfg: dict) -> str | None:
    """Return the route group named by a ``route:<name>`` model selector."""
    model = (model_in or "").strip()
    if model.startswith("anthropic/"):
        model = model[len("anthropic/") :]
    if not model.startswith(ROUTE_GROUP_PREFIX):
        return None
    if not cfg.get("routes"):
        # Without route groups the prefix carries no routing meaning; leave
        # the model name to the legacy routing path, which may still forward
        # it unchanged (e.g. route_unknown_to_default channels).
        return None
    name = model[len(ROUTE_GROUP_PREFIX) :].strip().lower()
    known = sorted(cfg.get("routes", {}))
    if not name or name not in cfg.get("routes", {}):
        raise RouteError(400, f"unknown route '{name}'; known: {known}")
    return name


def route(
    model_in: str,
    cfg: dict,
    providers: dict,
) -> tuple[str, str]:
    """Resolve a selector using validated config and an explicit provider snapshot.

    This function performs no I/O and does not mutate either input.
    """
    model = (model_in or "").strip()
    if model.startswith("anthropic/"):
        model = model[len("anthropic/") :]
    if "," in model:
        alias, _, upstream_model = model.partition(",")
        alias, upstream_model = alias.strip().lower(), upstream_model.strip()
        if alias not in cfg["channels"]:
            raise RouteError(
                400, f"unknown channel alias '{alias}'; known: {sorted(cfg['channels'])}"
            )
        if not upstream_model:
            raise RouteError(400, f"empty model after channel alias '{alias}'")
        return alias, upstream_model

    channels = cfg["channels"]
    # Hub v2 owns the four native Claude model slots.  Resolve those mappings
    # before looking for a coincidentally named bare upstream model so callers
    # such as Workflow ``agent(..., {model: "haiku"})`` get the exact same
    # route as Claude Code's /model picker and launcher settings.
    model_slots = cfg.get("model_slots")
    slot = model.casefold()
    if slot in HUB_SLOT_ORDER and isinstance(model_slots, dict):
        selector = model_slots.get(slot)
        if isinstance(selector, str):
            slot_alias, separator, slot_model = selector.partition(",")
            slot_alias, slot_model = slot_alias.strip().lower(), slot_model.strip()
            if separator and slot_alias in channels and slot_model:
                return slot_alias, slot_model

    aliases = [
        alias
        for alias, channel in channels.items()
        if model in channel.get("models", [])
    ]
    if len(aliases) == 1:
        return aliases[0], model
    if len(aliases) > 1:
        raise RouteError(
            400,
            f"ambiguous model '{model}'; use channel,model",
        )

    # Claude Code treats ``[1m]`` as a client-side context selector and can
    # strip it from the model field before sending the request.  Match that
    # bare name back to an explicitly declared 1M model so the gateway can
    # preserve both the upstream model ID and the required beta header,
    # instead of 400ing or silently forwarding without the 1M context.
    context_1m_matches = {
        (alias, declared_model)
        for alias, channel in channels.items()
        for declared_model in channel.get("models", [])
        if declared_model.casefold().endswith("[1m]")
        and declared_model[:-4] == model
    }
    if len(context_1m_matches) == 1:
        return next(iter(context_1m_matches))
    if len(context_1m_matches) > 1:
        raise RouteError(
            400,
            f"ambiguous model '{model}'; use channel,model",
        )

    return _route_default_model(model, cfg, providers)


def _route_default_model(model: str, cfg: dict, providers: dict) -> tuple[str, str]:
    """Resolve official aliases and the explicitly configured default channel."""
    channels = cfg["channels"]
    model_slots = cfg.get("model_slots")
    # Treat an undeclared official-style Claude model ID as a request for the
    # matching claude1 slot.  This keeps generated Workflow code portable while
    # the Hub remains authoritative about the actual upstream model.
    official_slot = re.fullmatch(
        r"claude-(fable|opus|sonnet|haiku)(?:-.+)?",
        model,
        re.IGNORECASE,
    )
    if official_slot:
        slot_name = official_slot.group(1).casefold()
        if isinstance(model_slots, dict):
            selector = model_slots.get(slot_name)
            if isinstance(selector, str):
                slot_alias, _, slot_model = selector.partition(",")
                return slot_alias, slot_model
        # Isolated v1 protocol bridges carry no model_slots, so an official
        # Claude model ID would otherwise fall through to
        # route_unknown_to_default and be forwarded unchanged to a
        # name/case-sensitive upstream that 400s on "invalid model".  Remap it
        # to the matched provider tier model, mirroring the bare-slot path.
        # Scoped to route_unknown_to_default bridges so a configured Hub without
        # model_slots keeps raising "unknown model" instead of guessing.
        fallback_alias = cfg["default_channel"]
        fallback_channel = channels.get(fallback_alias)
        if (
            fallback_channel is not None
            and fallback_channel.get("route_unknown_to_default")
        ):
            fallback_provider = match_channel_provider(
                fallback_channel, providers
            )
            if fallback_provider:
                mapped = fallback_provider["model_map"].get(slot_name)
                if mapped:
                    return fallback_alias, mapped

    alias = cfg["default_channel"]
    channel = channels.get(alias)
    if not channel:
        raise RouteError(500, f"default_channel '{alias}' not in channels config")
    provider = match_channel_provider(channel, providers)
    model_lower = model.lower()
    if provider:
        for tier in HUB_SLOT_ORDER:
            mapped = provider["model_map"].get(tier)
            if model_lower == tier and mapped:
                return alias, mapped
    if channel.get("route_unknown_to_default"):
        # Explicit opt-in for isolated single-channel protocol bridges:
        # unlisted models are forwarded to the default channel unchanged.
        return alias, model
    available_slots = (
        ", ".join(slot for slot in HUB_SLOT_ORDER if slot in model_slots)
        if isinstance(model_slots, dict)
        else "fable, opus, sonnet, haiku"
    )
    raise RouteError(
        400,
        f"unknown model '{model}'; use channel,model or an available model slot: "
        f"{available_slots}",
    )


def match_channel_provider(channel: dict, providers: dict) -> dict | None:
    """Resolve a channel without mutating provider or gateway configuration.

    Current channels use a CC Switch provider selector. Legacy local-gateway
    channels used ``base_url`` instead; for those, match exactly one existing
    CC Switch provider by normalized URL in the supplied snapshot.
    """
    selector = channel.get("provider")
    if isinstance(selector, str) and selector:
        return providers.get(selector)
    base_url = normalize_account_endpoint(channel.get("provider_base_url"))
    if not base_url:
        return None
    matches: list[dict] = []
    seen: set[int] = set()
    for candidate in providers.values():
        marker = id(candidate)
        if marker in seen:
            continue
        seen.add(marker)
        if normalize_account_endpoint(candidate.get("base_url")) == base_url:
            matches.append(candidate)
    return matches[0] if len(matches) == 1 else None
