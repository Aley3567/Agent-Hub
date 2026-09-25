"""Upstream error bodies -> sanitized, forwardable Anthropic error evidence.

This module is the sole owner of what a downstream client is allowed to read
about an upstream failure on the transformed (OpenAI Chat / Responses) path,
and of how that failure is classified and worded. Nothing here touches the
wire, the account pool or the stream state machine, so it is importable and
testable on its own; it must never import ``claude1_protocol`` back.

Entry points, outermost first:

``report_upstream_error(evidence, status=..., channel=..., api_format=...)``
    The full downstream verdict: Anthropic ``error.type``, whether a retry can
    help, and the one-line message. ``transform_error(body, status)`` is the
    same verdict rendered as an Anthropic ``{"type": "error", ...}`` dict.
``format_error_message`` / ``resolve_error_type``
    The two halves of that verdict. Non-streaming responses and mid-stream SSE
    error events share them, so a rate limit reads and classifies the same
    whichever path it arrives on. The message is "upstream text first":
    ``<upstream reason> [<channel> · <format> · 上游 <status> <type> · <code>]``.
``upstream_error_details(body)``
    The :class:`UpstreamErrorEvidence` (code, message, type, param) behind
    that verdict. ``upstream_error_evidence(body)`` is its ``(code, message)``
    projection, kept for journal entries and response headers, so raw
    upstream bodies are parsed in exactly one place.
``embedded_upstream_error(body, api_format)``
    Recognizes an HTTP 200 whose body is really an error (Chat ``{"error":
    ...}``, Responses ``status: "failed"``) and infers the status it stands
    for, so shape validation never runs over — and hides — the real reason.
``sanitize_error_text(text)``
    The redaction pass every string above goes through.

Invariants this module holds:

- **Nothing credential-shaped leaves.** Error text reaches clients through
  mid-stream SSE and response bodies they may echo into logs or UIs, so
  bearer/basic payloads, URL userinfo and query strings, JWTs, ``key=value``
  assignments, ``sk-``-style keys and header-adjacent opaque values are
  redacted before return. A URL keeps its scheme, host and path — the part
  that names the failing hop — and loses ``user:pass@``, ``?query#frag`` and
  any key-shaped path segment, where credentials actually travel. On the credential boundary the rules are
  deliberately fail-closed: an all-caps ordinary word next to header wording
  is redacted rather than risked.
- **The real reason survives redaction.** Redaction is targeted, not blanket
  truncation to a status code: the upstream code, type, param and message are
  forwarded so an operator can still attribute the failure. Text is bounded
  at 1024 characters and stripped of control characters.
- **Shape tolerance, not invention.** Canonical ``{"error": {...}}``, a
  double-JSON-encoded wrapper, top-level ``message``/``detail``/``msg``, a
  FastAPI ``detail`` list, a string ``error``, an HTML relay page and a plain
  text body are all accepted; a body that yields nothing usable returns empty
  evidence rather than a fabricated reason. A code is forwarded when it is
  at most 64 printable characters after redaction.
- **Failure is never dressed as success.** Classification only chooses which
  Anthropic error an upstream failure becomes; nothing here turns an error or
  an unknown terminal reason into a completed response.

Failure mode: these functions do not raise. Unparseable or empty input becomes
empty evidence (or, for the message, a status-only fallback).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class UpstreamErrorEvidence:
    """Sanitized fields of one upstream error; every field may be absent."""

    code: str | None = None
    message: str | None = None
    type: str | None = None
    param: str | None = None

    @property
    def empty(self) -> bool:
        return not (self.code or self.message or self.type or self.param)


@dataclass(frozen=True)
class UpstreamErrorReport:
    """What the downstream client is told about one upstream failure."""

    evidence: UpstreamErrorEvidence
    error_type: str
    retryable: bool
    message: str

    def body(self) -> dict:
        return {
            "type": "error",
            "error": {"type": self.error_type, "message": self.message},
        }


def transform_error(
    body: object,
    status: int,
    *,
    channel: str | None = None,
    api_format: str | None = None,
) -> dict:
    """Render an upstream error body as the downstream Anthropic error dict."""
    return report_upstream_error(
        upstream_error_details(body),
        status=status,
        channel=channel,
        api_format=api_format,
    ).body()


def report_upstream_error(
    evidence: UpstreamErrorEvidence,
    *,
    status: int | None,
    channel: str | None = None,
    api_format: str | None = None,
    hub_code: str | None = None,
) -> UpstreamErrorReport:
    """Classify and word one upstream failure in a single step."""
    error_type, retryable = resolve_error_type(evidence, status)
    return UpstreamErrorReport(
        evidence=evidence,
        error_type=error_type,
        retryable=retryable,
        message=format_error_message(
            evidence,
            status=status,
            channel=channel,
            api_format=api_format,
            hub_code=hub_code,
        ),
    )


# Upstream ``error.code`` / ``error.type`` values whose Anthropic meaning is
# unambiguous. Claude Code classifies by status and ``error.type`` (and, for a
# mid-stream error, by nothing else), so a rate limit reported as api_error is
# retried and worded as a generic failure. The code is consulted before the
# type because OpenAI files most client errors under one broad type
# (``invalid_request_error``) and puts the real distinction in the code.
_UPSTREAM_ERROR_TYPES = {
    "rate_limit_exceeded": "rate_limit_error",
    "rate_limited": "rate_limit_error",
    "too_many_requests": "rate_limit_error",
    "insufficient_quota": "rate_limit_error",
    "quota_exceeded": "rate_limit_error",
    "overloaded": "overloaded_error",
    "model_overloaded": "overloaded_error",
    "server_overloaded": "overloaded_error",
    # DeepSeek's finish_reason for "the service is out of capacity".
    "insufficient_system_resource": "overloaded_error",
    "invalid_api_key": "authentication_error",  # secret-guard: allow generic-secret-assignment
    "invalid_authentication": "authentication_error",
    "model_not_found": "not_found_error",
    "context_length_exceeded": "invalid_request_error",
    "server_error": "api_error",
}
_ANTHROPIC_ERROR_TYPES = frozenset(
    {
        "invalid_request_error",
        "authentication_error",
        "billing_error",
        "permission_error",
        "not_found_error",
        "request_too_large",
        "rate_limit_error",
        "api_error",
        "timeout_error",
        "overloaded_error",
    }
)
# Retrying an exhausted balance cannot succeed and only burns the retry budget
# before the user sees why; ``x-should-retry: false`` is read by both the SDK
# and Claude Code's own retry decision ahead of the status code.
_NON_RETRYABLE_CODES = frozenset({"insufficient_quota", "quota_exceeded"})
_CONTEXT_OVERFLOW_CODES = frozenset(
    {
        "context_length_exceeded",
        "context_window_exceeded",
        "model_context_window_exceeded",
    }
)
_CONTEXT_OVERFLOW_TEXT = re.compile(
    r"(?i)context_length_exceeded|maximum context length|context window"
    r"|prompt is too long"
)
# Claude Code offers /compact only when the message contains this phrase.
_CONTEXT_OVERFLOW_MARKER = "prompt is too long"
# The status an HTTP 200 error body stands for, by its Anthropic type.
_STATUS_BY_ERROR_TYPE = {
    "invalid_request_error": 400,
    "authentication_error": 401,
    "billing_error": 402,
    "permission_error": 403,
    "not_found_error": 404,
    "request_too_large": 413,
    "rate_limit_error": 429,
    "timeout_error": 504,
    "overloaded_error": 529,
}


def _evidence_keys(evidence: UpstreamErrorEvidence) -> list[str]:
    return [
        value.casefold()
        for value in (evidence.code, evidence.type)
        if isinstance(value, str) and value
    ]


def _mapped_error_type(evidence: UpstreamErrorEvidence) -> str | None:
    """The Anthropic type the upstream itself named, if any."""
    for key in _evidence_keys(evidence):
        mapped = _UPSTREAM_ERROR_TYPES.get(key)
        if mapped is None and key in _ANTHROPIC_ERROR_TYPES:
            mapped = key
        if mapped is not None:
            return mapped
    return None


def _status_error_type(status: int | None) -> str:
    """The Anthropic type an HTTP status implies when the body names none."""
    if status is None or status < 400:
        return "api_error"
    if status in {401, 403}:
        return "authentication_error" if status == 401 else "permission_error"
    if status == 429:
        return "rate_limit_error"
    if status == 404:
        return "not_found_error"
    if status in {408, 504}:
        return "timeout_error"
    if status == 529:
        return "overloaded_error"
    if status >= 500:
        return "api_error"
    return "invalid_request_error"


def resolve_error_type(
    evidence: UpstreamErrorEvidence, status: int | None
) -> tuple[str, bool]:
    """Return ``(anthropic_error_type, retryable)`` for one upstream failure.

    The upstream's own code/type wins; the HTTP status only decides when the
    body names nothing recognizable. ``status`` is ``None`` for a mid-stream
    error, where no HTTP status exists to fall back on.
    """
    keys = _evidence_keys(evidence)
    retryable = not any(
        key in _NON_RETRYABLE_CODES or key.startswith("billing_") for key in keys
    )
    return _mapped_error_type(evidence) or _status_error_type(status), retryable


def _is_context_overflow(evidence: UpstreamErrorEvidence) -> bool:
    if any(key in _CONTEXT_OVERFLOW_CODES for key in _evidence_keys(evidence)):
        return True
    return bool(evidence.message and _CONTEXT_OVERFLOW_TEXT.search(evidence.message))


def format_error_message(
    evidence: UpstreamErrorEvidence,
    *,
    status: int | None,
    channel: str | None,
    api_format: str | None,
    hub_code: str | None = None,
) -> str:
    """Word one upstream failure as ``<upstream text> [<where> · <what>]``.

    ``status`` is the status the upstream actually sent (``None`` mid-stream),
    not the one the hub answers with. The bracket names a type only when the
    upstream named one or its status implies one, so an HTTP 200 the hub could
    not translate is not dressed up as a client error; mid-stream, the type
    the error event carries is named. ``hub_code`` replaces
    the upstream code when the failure is the hub's own verdict.
    """
    message = evidence.message or (
        f"upstream HTTP {status}"
        if status is not None and status >= 400
        else "upstream error without details"
    )
    if _is_context_overflow(evidence) and (
        _CONTEXT_OVERFLOW_MARKER not in message.casefold()
    ):
        message += f" ({_CONTEXT_OVERFLOW_MARKER})"
    kind = _mapped_error_type(evidence)
    if kind is None and (status is None or status >= 400):
        # Mid-stream there is no status to mislead, so the type the SSE error
        # event carries is named; a 2xx names none.
        kind = _status_error_type(status)
    upstream = " ".join(
        part for part in ("上游", str(status) if status is not None else "", kind or "")
        if part
    )
    segments = [
        (sanitize_error_text(str(channel)) or "")[:80] if channel else "",
        api_format or "",
        upstream,
    ]
    if hub_code:
        segments.append(hub_code)
    else:
        if evidence.code:
            segments.append(evidence.code)
        if evidence.type and evidence.type not in (evidence.code, kind):
            segments.append(evidence.type)
        if evidence.param:
            segments.append(f"param {evidence.param}")
    return f"{message} [{' · '.join(part for part in segments if part)}]"


def embedded_upstream_error(
    body: object, api_format: str
) -> tuple[UpstreamErrorEvidence, int] | None:
    """Detect an HTTP 200 body that is really an upstream error.

    Returns the evidence and the status the failure stands for: inferred from
    the upstream's own error type, 502 when it names nothing recognizable.
    ``None`` means the body is a normal response and belongs to the response
    translator. A body that carries output alongside an ``error`` is left to
    the translator too, because discarding produced output is not this
    function's call.
    """
    if not isinstance(body, dict):
        return None
    error = body.get("error")
    has_error = error not in (None, "", {})
    if api_format == "openai_responses":
        failed = body.get("status") == "failed"
        has_output = body.get("output") not in (None, [])
        if not failed and (not has_error or has_output):
            return None
    else:
        choices = body.get("choices")
        if not has_error or (isinstance(choices, list) and choices):
            return None
    evidence = (
        upstream_error_details({"error": error}) if has_error else UpstreamErrorEvidence()
    )
    mapped = _mapped_error_type(evidence)
    return evidence, _STATUS_BY_ERROR_TYPE.get(mapped, 502) if mapped else 502


def terminal_reason_evidence(reason: str, field_name: str) -> UpstreamErrorEvidence:
    """Evidence for an upstream terminal reason that has no Anthropic meaning.

    Mapping such a reason (``network_error``, ``insufficient_system_resource``)
    to ``end_turn`` would present a failed generation as a finished one, so it
    becomes an error carrying the reason verbatim instead.
    """
    safe_reason = sanitize_error_text(reason) or "unknown"
    code = (
        safe_reason if re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", safe_reason) else None
    )
    return UpstreamErrorEvidence(
        code=code,
        message=sanitize_error_text(
            f"上游以非成功的终止原因结束了响应：{field_name} {safe_reason!r}"
        ),
    )


def upstream_error_evidence(body: object) -> tuple[str | None, str | None]:
    """Extract sanitized (code, message) evidence from an upstream error body."""
    evidence = upstream_error_details(body)
    return evidence.code, evidence.message


def upstream_error_details(body: object) -> UpstreamErrorEvidence:
    """Extract sanitized code/message/type/param from an upstream error body.

    The same rules serve both the downstream Anthropic error shell and the
    hub's logging/response headers, so no caller re-parses raw upstream
    bodies. Some OpenAI-compatible gateways JSON-encode their JSON error
    object a second time; decode that wrapper once so a structured error does
    not collapse to an opaque status-only fallback. Numeric codes (common for
    OpenAI-compatible providers) are accepted alongside strings, and so is a
    non-identifier code such as new-api's ``"upstream error"``.
    Besides the canonical ``{"error": {...}}`` envelope, common relay shapes
    (top-level ``message``/``detail``/``msg``, a FastAPI ``detail`` list, a
    string ``error``, a one-element JSON array) are accepted so gateways that
    skip the envelope still surface their real reason. A body that is an HTML
    error page is reduced to its title and server signature; any other text
    body contributes its first non-empty line.
    """
    if isinstance(body, str):
        try:
            decoded_body = json.loads(body)
        except json.JSONDecodeError:
            decoded_body = None
        if isinstance(decoded_body, list) and decoded_body:
            decoded_body = decoded_body[0]
        if isinstance(decoded_body, dict):
            body = decoded_body
        elif isinstance(decoded_body, str):
            return UpstreamErrorEvidence(message=_first_text_line(decoded_body))
        else:
            if _HTML_ERROR_MARKUP.search(body[:_HTML_ERROR_SCAN_CHARS]):
                # Markup is never forwarded: a page without a title yields
                # nothing rather than its first line of tags.
                html_summary = _html_error_summary(body)
                return UpstreamErrorEvidence(
                    message=sanitize_error_text(html_summary) if html_summary else None
                )
            return UpstreamErrorEvidence(message=_first_text_line(body))
    if not isinstance(body, dict):
        return UpstreamErrorEvidence()
    error = body.get("error")
    fields = (
        {name: error.get(name) for name in ("code", "message", "type", "param")}
        if isinstance(error, dict)
        else {}
    )
    if fields.get("message") is None:
        fields["message"] = _relay_error_message(body, error)
        if fields["message"] is not None and fields.get("code") is None:
            fields["code"] = body.get("code")
    if isinstance(fields["message"], str):
        _merge_nested_error(fields)
    message = fields["message"]
    return UpstreamErrorEvidence(
        code=_safe_code(fields.get("code")),
        message=(
            sanitize_error_text(message)
            if isinstance(message, str) and message.strip()
            else None
        ),
        type=_bounded_text(fields.get("type"), 64),
        param=_bounded_text(fields.get("param"), 128),
    )


def _relay_error_message(body: dict, error: object) -> str | None:
    """The reason a relay put somewhere other than ``error.message``."""
    if isinstance(error, str) and error.strip():
        return error
    for field_name in ("message", "detail", "msg"):
        value = body.get(field_name)
        if isinstance(value, str) and value.strip():
            return value
        if field_name == "detail" and isinstance(value, list):
            joined = _detail_list_text(value)
            if joined:
                return joined
    return None


def _merge_nested_error(fields: dict) -> None:
    """Unwrap an error object JSON-encoded inside ``error.message``."""
    try:
        nested_body = json.loads(fields["message"])
    except json.JSONDecodeError:
        return
    nested_error = nested_body.get("error") if isinstance(nested_body, dict) else None
    if not isinstance(nested_error, dict):
        return
    for name in ("code", "type", "param"):
        if nested_error.get(name) not in (None, ""):
            fields[name] = nested_error[name]
    nested_message = nested_error.get("message")
    if isinstance(nested_message, str) and nested_message.strip():
        fields["message"] = nested_message


def _detail_list_text(items: list) -> str | None:
    """Join a FastAPI validation ``detail`` list into one line."""
    parts: list[str] = []
    for item in items[:8]:
        if isinstance(item, str) and item.strip():
            parts.append(item.strip())
            continue
        if not isinstance(item, dict):
            continue
        text = item.get("msg")
        if not isinstance(text, str) or not text.strip():
            continue
        location = item.get("loc")
        if isinstance(location, list) and location:
            parts.append(f"{'.'.join(str(part) for part in location)}: {text.strip()}")
        else:
            parts.append(text.strip())
    return "; ".join(parts) or None


def _first_text_line(text: str) -> str | None:
    """The first non-empty line of a non-JSON, non-HTML body."""
    for line in text[:_HTML_ERROR_SCAN_CHARS].splitlines():
        if line.strip():
            return sanitize_error_text(line)
    return None


def _safe_code(value: object) -> str | None:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    cleaned = sanitize_error_text(str(value))
    if cleaned is None or len(cleaned) > 64 or not cleaned.isprintable():
        return None
    return cleaned


def _bounded_text(value: object, limit: int) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    cleaned = sanitize_error_text(value)
    return cleaned[:limit] if cleaned else None


# Credential-bearing parts of a URL: everything up to the last '@' of the
# authority (userinfo, even when a stray '/' makes it look like a path) and
# everything from the first '?' or '#'. Scheme, host and path stay: they name
# the hop that failed, which is the point of forwarding the error at all.
_URL = re.compile(r"(?i)\b(https?://)([^\s?#]*)([?#]\S*)?")
# Some APIs carry the key as a path segment (``/bot<token>/``, ``/key/<key>``).
# Route segments are short words; a long segment mixing letters and digits is
# machine-generated and is redacted rather than risked.
_URL_OPAQUE_SEGMENT = re.compile(
    r"(?<=/)(?=[^/]*[A-Za-z])(?=[^/]*\d)[A-Za-z0-9_\-.~:]{20,}(?=/|$)"
)


def _redact_url(match: re.Match) -> str:
    authority_and_path = match.group(2)
    if "@" in authority_and_path:
        authority_and_path = authority_and_path.rsplit("@", 1)[1]
    authority_and_path = _URL_OPAQUE_SEGMENT.sub("[redacted]", authority_and_path)
    suffix = match.group(3)
    redacted_suffix = f"{suffix[0]}[redacted]" if suffix else ""
    return f"{match.group(1)}{authority_and_path}{redacted_suffix}"


def sanitize_error_text(text: str) -> str | None:
    """Bound and redact one line of upstream error text for downstream reuse."""
    candidate = text.strip()[:1024]
    candidate = re.sub(
        r"(?i)\b(Bearer|Basic)\s+\S+",
        # Basic carries base64 user:password, so the scheme word alone is not
        # the secret — the payload after it is.
        lambda match: f"{match.group(1)} [redacted-token]",
        candidate,
    )
    candidate = _URL.sub(_redact_url, candidate)
    candidate = _ERROR_TEXT_JWT_SHAPE.sub("[redacted-token]", candidate)
    candidate = _ERROR_TEXT_QUOTED_ASSIGNMENT.sub(
        lambda match: f"{match.group(1)}=[redacted]", candidate
    )
    candidate = _ERROR_TEXT_ASSIGNMENT.sub(
        lambda match: f"{match.group(1)}=[redacted]", candidate
    )
    candidate = _ERROR_TEXT_KEY_SHAPE.sub("[redacted-key]", candidate)
    candidate = _ERROR_TEXT_QUOTED_HEADER_VALUE.sub(
        lambda match: f"{match.group(1)}[redacted]", candidate
    )
    candidate = _ERROR_TEXT_HEADER_VALUE.sub(
        lambda match: (
            f"{match.group(1)}[redacted]"
            if _is_opaque_header_value(match.group(2))
            else match.group(0)
        ),
        candidate,
    )
    candidate = _ERROR_TEXT_NEARBY_VALUE.sub(
        lambda match: (
            f"{match.group(1)}[redacted]"
            if _is_credential_shaped(match.group(2))
            else match.group(0)
        ),
        candidate,
    )
    candidate = re.sub(r"[\x00-\x1f\x7f]+", " ", candidate).strip()
    return candidate or None


# ---------------------------------------------------------------------------
# Mechanisms: HTML relay pages

# Relays answer their own timeouts with an nginx or CDN error page rather than
# a JSON envelope. Only the head of such a body is worth scanning: the useful
# evidence is in <title>/<h1> and the server signature that follows the rule.
_HTML_ERROR_SCAN_CHARS = 4096
_HTML_ERROR_MARKUP = re.compile(
    r"<\s*(?:!doctype\s+html|html|head|title|body|center|h1)\b", re.IGNORECASE
)
_HTML_ERROR_TITLE = re.compile(
    r"<title[^>]*>(.*?)</\s*title\s*>", re.IGNORECASE | re.DOTALL
)
_HTML_ERROR_HEADING = re.compile(
    r"<h1[^>]*>(.*?)</\s*h1\s*>", re.IGNORECASE | re.DOTALL
)
_HTML_ERROR_SERVER = re.compile(
    r"<hr\s*/?>\s*<center[^>]*>(.*?)</\s*center\s*>", re.IGNORECASE | re.DOTALL
)
_HTML_ERROR_TAG = re.compile(r"<[^>]*>")


def _html_error_summary(text: str) -> str | None:
    """Reduce an HTML error page to one line of forwardable evidence.

    A dropped HTML body left a bare status code in the journal, which cannot
    distinguish a gateway-imposed read timeout from an origin failure, nor
    attribute it to the hop that produced it. The page's own title and server
    signature answer both, so they are kept while the markup is discarded.
    """
    head = text[:_HTML_ERROR_SCAN_CHARS]
    if not _HTML_ERROR_MARKUP.search(head):
        return None
    parts: list[str] = []
    for pattern in (_HTML_ERROR_TITLE, _HTML_ERROR_HEADING):
        match = pattern.search(head)
        if match is not None:
            parts.append(match.group(1))
            break
    server = _HTML_ERROR_SERVER.search(head)
    if server is not None:
        parts.append(server.group(1))
    cleaned = [
        " ".join(_HTML_ERROR_TAG.sub(" ", part).split()) for part in parts
    ]
    return " / ".join(part for part in cleaned if part) or None


# ---------------------------------------------------------------------------
# Mechanisms: credential redaction rules

# Credential-shaped fragments must never survive into downstream error text,
# because these messages travel through mid-stream SSE and response bodies
# that clients may echo into logs or UIs.
_ERROR_TEXT_CREDENTIAL_WORDS = (
    r"token|secret|password|passwd|authorization|credential"
    r"|api[-_]?key|access[-_]?token|refresh[-_]?token|key"
    r"|set[-_]?cookie|cookie|session"
)
# One quoted value, matched the way upstream text actually quotes rather than
# the way it ought to: a relay may close with the other quote character, a
# JSON-encoded error body arrives with every quote backslash-escaped, and the
# 1024-char bound can cut the closing quote off entirely. A same-quote
# backreference missed all three, and the miss was not inert — it handed the
# value to the `\S+` assignment rule below, which redacted up to the first
# space and left the rest of the credential in the text. The body can never
# cross a quote, so a tolerant closer still stops at the nearest one.
_ERROR_TEXT_QUOTED_VALUE = r"\\?['\"][^'\"\r\n]*(?:['\"]|(?=[\r\n])|\Z)"
_ERROR_TEXT_QUOTED_ASSIGNMENT = re.compile(
    r"(?i)\b(" + _ERROR_TEXT_CREDENTIAL_WORDS + r")\s*[=:]\s*"
    + _ERROR_TEXT_QUOTED_VALUE
)
_ERROR_TEXT_ASSIGNMENT = re.compile(
    r"(?i)\b(" + _ERROR_TEXT_CREDENTIAL_WORDS + r")\s*[=:]\s*\S+"
)
_ERROR_TEXT_HEADER_WORDS = (
    r"authorization|x-api-key|api[-_]?key|api\s+key"
    r"|set[-_]?cookie|cookie|session"
)
# Explicit header/value wording is strong context, so a value of letters alone
# still counts here — but the context is not strong enough to skip the shape
# check, or "authorization header verification failed" loses the one word that
# names the failure.
_ERROR_TEXT_HEADER_VALUE = re.compile(
    r"(?i)(\b(?:" + _ERROR_TEXT_HEADER_WORDS + r")\b"
    r"(?:\s+(?:header|value))?\s+)"
    r"([A-Za-z0-9_\-./+=]{12,})"
)
_ERROR_TEXT_QUOTED_HEADER_VALUE = re.compile(
    r"(?i)(\b(?:" + _ERROR_TEXT_HEADER_WORDS + r")\b"
    r"(?:\s+(?:header|value))?\s+)" + _ERROR_TEXT_QUOTED_VALUE
)
_ERROR_TEXT_KEY_SHAPE = re.compile(r"\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b")
# A JWT carries its own unmistakable shape, so it is redacted without an
# adjacent keyword: upstreams routinely report it as bare "invalid token
# <jwt>", where no separator exists for the assignment rule to anchor on.
_ERROR_TEXT_JWT_SHAPE = re.compile(
    r"\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?"
)
# Header rejections read as "x-api-key header <value> is revoked" — keyword
# and value separated by prose rather than by '='. At most ONE ordinary word
# may sit between them: allowing more would swallow real reasons such as
# "api key for model claude-opus-4-20250514 is invalid", which trades the
# operator's only diagnostic for no additional secrecy.
_ERROR_TEXT_NEARBY_VALUE = re.compile(
    r"(?i)(\b(?:"
    + _ERROR_TEXT_CREDENTIAL_WORDS
    + r")\b(?:\s+[A-Za-z]{1,15}\b)?\s+)"
    r"([A-Za-z0-9_\-./+=]{12,})"
)


def _is_credential_shaped(value: str) -> bool:
    """Tell an opaque credential from an ordinary long word.

    Length alone would redact prose like "specification"; a digit or a
    structural character is what marks a value as machine-generated.
    """
    if value.startswith("[redacted"):
        return False
    return any(char.isdigit() for char in value) or any(
        char in "_-./+=" for char in value
    )


def _is_opaque_header_value(value: str) -> bool:
    """Decide whether a value quoted only by header wording is a secret.

    A credential made of letters alone carries no digit or separator for
    :func:`_is_credential_shaped` to key on, so casing is the remaining tell:
    prose arrives lowercase or Capitalized, opaque values arrive SHOUTED or
    camelCased. An all-caps ordinary word is redacted by this rule — that is
    the fail-closed side of the trade, and the credential boundary is where
    the repository takes it.
    """
    if _is_credential_shaped(value):
        return True
    return not (value.islower() or value.istitle())
