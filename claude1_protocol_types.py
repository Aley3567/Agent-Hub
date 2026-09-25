"""Shared types for the Anthropic protocol translation modules.

This module is the stable in-process seam shared by request, response, usage,
and stream implementations.  It contains no provider routing or wire-shape
conversion logic.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum


class ProtocolTransformError(ValueError):
    """Raised when a provider response cannot be represented as Anthropic."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "HUB_UPSTREAM_PROTOCOL_ERROR",
        path: str | None = None,
        phase: str = "upstream",
        http_status: int = 502,
    ):
        super().__init__(message)
        self.code = code
        self.path = path
        self.phase = phase
        self.http_status = http_status


class UpstreamStopReasonError(ProtocolTransformError):
    """The upstream ended with a terminal reason that has no Anthropic meaning.

    Unlike a malformed response, this is the upstream reporting that the
    generation did not finish (``network_error``,
    ``insufficient_system_resource``), so callers surface ``reason`` verbatim
    as an upstream error instead of a translation failure.
    """

    def __init__(self, reason: str, *, field_name: str):
        super().__init__(
            f"upstream stop reason {reason!r} cannot be represented",
            code="HUB_UPSTREAM_STOP_REASON_UNMAPPABLE",
        )
        self.reason = reason
        self.field_name = field_name


class ProtocolRequestError(ProtocolTransformError):
    """An Anthropic request is invalid or unsupported by the target adapter."""

    def __init__(self, message: str, *, code: str, path: str):
        super().__init__(
            message,
            code=code,
            path=path,
            phase="request",
            http_status=400,
        )


class SupportDisposition(str, Enum):
    EXACT = "exact"
    DEGRADED = "observable_degradation"
    REJECTED = "reject"


@dataclass(frozen=True)
class CapabilityDecision:
    disposition: SupportDisposition
    code: str
    path: str
    feature: str


@dataclass
class ConversionPlan:
    adapter: str
    decisions: list[CapabilityDecision] = field(default_factory=list)

    def add(
        self,
        disposition: SupportDisposition,
        code: str,
        path: str,
        feature: str,
    ) -> None:
        self.decisions.append(
            CapabilityDecision(disposition, code, path, feature)
        )

    @property
    def warning_codes(self) -> tuple[str, ...]:
        return tuple(
            dict.fromkeys(
                decision.code
                for decision in self.decisions
                if decision.disposition is SupportDisposition.DEGRADED
            )
        )

    @property
    def warning_details(self) -> tuple[str, ...]:
        return tuple(
            dict.fromkeys(
                f"{decision.code}@{decision.path}"
                for decision in self.decisions
                if decision.disposition is SupportDisposition.DEGRADED
            )
        )


@dataclass(frozen=True)
class CapabilityProfile:
    name: str
    endpoint: str
    availability: str = "available"


@dataclass(frozen=True)
class PreparedRequest:
    endpoint: str
    payload: dict
    plan: ConversionPlan


@dataclass(frozen=True)
class ContentBlockIR:
    kind: str
    value: dict
    path: str


@dataclass(frozen=True)
class MessageIR:
    role: str
    blocks: tuple[ContentBlockIR, ...]
    content_was_string: bool
    path: str


@dataclass(frozen=True)
class RequestIR:
    """Canonical, ordered Anthropic conversation used by target adapters."""

    source: dict
    system_blocks: tuple[ContentBlockIR, ...]
    messages: tuple[MessageIR, ...]
    tools: tuple[dict, ...]
    controls: dict
