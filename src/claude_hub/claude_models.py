"""Claude-specific projection of generic model-purpose slots.

Only this adapter knows Claude's environment field names. Callers exchange
the generic :class:`~claude_hub.domain.ModelMapping` DTO, while patching works
on a deep copy so unrelated provider settings survive a round trip.
"""

from __future__ import annotations

import hashlib
import json
import re
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Mapping

from .domain import ModelMapping


CLAUDE_MODEL_FIELDS: tuple[tuple[str, str], ...] = (
    ("default", "ANTHROPIC_MODEL"),
    ("fast", "ANTHROPIC_DEFAULT_HAIKU_MODEL"),
    ("reasoning", "ANTHROPIC_REASONING_MODEL"),
    ("coding", "ANTHROPIC_DEFAULT_SONNET_MODEL"),
    ("long_context", "ANTHROPIC_DEFAULT_OPUS_MODEL"),
    ("fallback", "ANTHROPIC_DEFAULT_FABLE_MODEL"),
)
CLAUDE_MODEL_FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "fast": ("ANTHROPIC_SMALL_FAST_MODEL",),
}

_ALL_RECOGNIZED_ENV_KEYS: frozenset[str] = frozenset(
    [canonical for _, canonical in CLAUDE_MODEL_FIELDS]
    + [alias for aliases in CLAUDE_MODEL_FIELD_ALIASES.values() for alias in aliases]
)


def _candidate_fields(slot: str, canonical: str) -> tuple[str, ...]:
    return (canonical, *CLAUDE_MODEL_FIELD_ALIASES.get(slot, ()))


class ClaudeModelDocumentError(ValueError):
    """Raised when a Claude settings document cannot be projected safely."""


@dataclass(frozen=True, slots=True)
class UnknownFieldSummary:
    """Irreversible summary of fields outside the model adapter's contract."""

    count: int
    fingerprint: str

    def __post_init__(self) -> None:
        if (
            not isinstance(self.count, int)
            or isinstance(self.count, bool)
            or self.count < 0
        ):
            raise TypeError("count must be a non-negative int")
        if (
            not isinstance(self.fingerprint, str)
            or re.fullmatch(r"[0-9a-f]{64}", self.fingerprint) is None
        ):
            raise ValueError("fingerprint must be a SHA-256 digest")


class ClaudeModelAdapter:
    """Project and patch Claude model fields without exposing their paths."""

    __slots__ = ()

    def project(self, document: Mapping[str, Any]) -> ModelMapping:
        if not isinstance(document, Mapping):
            raise ClaudeModelDocumentError("model document must be an object")
        env = document.get("env")
        if env is None:
            env = {}
        if not isinstance(env, Mapping):
            raise ClaudeModelDocumentError("model environment must be an object")

        projected: dict[str, str | None] = {}
        for slot, field_name in CLAUDE_MODEL_FIELDS:
            value = None
            for candidate in _candidate_fields(slot, field_name):
                candidate_value = env.get(candidate)
                if candidate_value is not None:
                    if not isinstance(candidate_value, str) or not candidate_value.strip():
                        raise ClaudeModelDocumentError(
                            f"model setting {candidate!r} must be a non-empty string"
                        )
                    value = candidate_value.strip()
                    break
            projected[slot] = value

        try:
            return ModelMapping(**projected)
        except (TypeError, ValueError) as exc:
            raise ClaudeModelDocumentError(
                f"model mapping has invalid values: {exc}"
            ) from exc

    def unknown_fields(self, document: Mapping[str, Any]) -> UnknownFieldSummary:
        if not isinstance(document, Mapping):
            raise ClaudeModelDocumentError("model document must be an object")
        env = document.get("env")
        if env is None:
            env = {}
        if not isinstance(env, Mapping):
            raise ClaudeModelDocumentError("model environment must be an object")

        unknown_keys = sorted(k for k in env.keys() if k not in _ALL_RECOGNIZED_ENV_KEYS)
        payload = json.dumps(unknown_keys, sort_keys=True).encode("utf-8")
        digest = hashlib.sha256(payload).hexdigest()
        return UnknownFieldSummary(count=len(unknown_keys), fingerprint=digest)

    def fingerprint(self, document: Mapping[str, Any]) -> str:
        if not isinstance(document, Mapping):
            raise ClaudeModelDocumentError("model document must be an object")
        normalized = json.dumps(document, sort_keys=True, ensure_ascii=False).encode("utf-8")
        return hashlib.sha256(normalized).hexdigest()

    def patch(
        self,
        document: Mapping[str, Any],
        models: ModelMapping,
    ) -> dict[str, Any]:
        """Apply model mapping updates onto a deep copy of document."""
        if not isinstance(document, Mapping):
            raise ClaudeModelDocumentError("model document must be an object")
        if not isinstance(models, ModelMapping):
            raise TypeError("models must be a ModelMapping")

        try:
            patched = deepcopy(dict(document))
        except RecursionError as exc:
            raise ClaudeModelDocumentError(
                "model document nesting exceeds maximum recursion depth"
            ) from exc

        env = patched.get("env")
        if env is None:
            env = {}
            patched["env"] = env
        elif not isinstance(env, dict):
            raise ClaudeModelDocumentError("model environment must be an object")

        for slot, canonical in CLAUDE_MODEL_FIELDS:
            target_value = getattr(models, slot)
            if target_value is not None:
                env[canonical] = target_value
            else:
                for candidate in _candidate_fields(slot, canonical):
                    env.pop(candidate, None)

        return patched


__all__ = [
    "CLAUDE_MODEL_FIELDS",
    "CLAUDE_MODEL_FIELD_ALIASES",
    "ClaudeModelAdapter",
    "ClaudeModelDocumentError",
    "UnknownFieldSummary",
]
