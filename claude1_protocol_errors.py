"""Upstream error bodies -> sanitized, forwardable Anthropic error evidence.

This module is the sole owner of what a downstream client is allowed to read
about an upstream failure on the transformed (OpenAI Chat / Responses) path.
Nothing here touches the wire, the account pool or the stream state machine, so
it is importable and testable on its own; it must never import
``claude1_protocol`` back.

Entry points, outermost first:

``transform_error(body, status)``
    The full downstream shell: an Anthropic ``{"type": "error", ...}`` dict
    whose ``error.type`` is derived from the HTTP status alone and whose
    message carries the sanitized upstream reason.
``upstream_error_evidence(body)``
    The ``(code, message)`` pair behind that shell. The hub reuses it directly
    for journal entries and response headers, so raw upstream bodies are parsed
    in exactly one place.
``sanitize_error_text(text)``
    The redaction pass every string above goes through.

Invariants this module holds:

- **Nothing credential-shaped leaves.** Error text reaches clients through
  mid-stream SSE and response bodies they may echo into logs or UIs, so
  bearer/basic payloads, URLs, JWTs, ``key=value`` assignments, ``sk-``-style
  keys and header-adjacent opaque values are redacted before return. On the
  credential boundary the rules are deliberately fail-closed: an all-caps
  ordinary word next to header wording is redacted rather than risked.
- **The real reason survives redaction.** Redaction is targeted, not blanket
  truncation to a status code: the upstream code and message are forwarded so
  an operator can still attribute the failure. Text is bounded at 512
  characters and stripped of control characters.
- **Shape tolerance, not invention.** Canonical ``{"error": {...}}``, a
  double-JSON-encoded wrapper, top-level ``message``/``detail``/``msg``, a
  string ``error`` and an HTML relay page are all accepted; a body that yields
  nothing usable returns ``None`` rather than a fabricated reason. Only
  ``[A-Za-z0-9_.-]{1,64}`` is forwarded as a code.

Failure mode: these functions do not raise. Unparseable or empty input becomes
``None`` (or, for :func:`transform_error`, a status-only message).
"""

from __future__ import annotations

import json
import re


def transform_error(body: object, status: int) -> dict:
    safe_code, safe_message = upstream_error_evidence(body)
    message = f"upstream HTTP {status}"
    if safe_code:
        message += f" ({safe_code})"
    if safe_message:
        message += f": {safe_message}"
    if status in {401, 403}:
        kind = "authentication_error" if status == 401 else "permission_error"
    elif status == 429:
        kind = "rate_limit_error"
    elif status == 404:
        kind = "not_found_error"
    elif status in {408, 504}:
        kind = "timeout_error"
    elif status == 529:
        kind = "overloaded_error"
    elif status >= 500:
        kind = "api_error"
    else:
        kind = "invalid_request_error"
    return {"type": "error", "error": {"type": kind, "message": str(message)}}


def upstream_error_evidence(body: object) -> tuple[str | None, str | None]:
    """Extract sanitized (code, message) evidence from an upstream error body.

    The same rules serve both the downstream Anthropic error shell and the
    hub's logging/response headers, so no caller re-parses raw upstream
    bodies. Some OpenAI-compatible gateways JSON-encode their JSON error
    object a second time; decode that wrapper once so a structured error does
    not collapse to an opaque status-only fallback. Numeric codes (common for
    OpenAI-compatible providers) are accepted alongside strings; anything that
    is not a short identifier becomes None rather than being forwarded.
    Besides the canonical ``{"error": {...}}`` envelope, common relay shapes
    (top-level ``message``/``detail``/``msg``, string ``error``) are accepted
    so gateways that skip the envelope still surface their real reason. A body
    that is an HTML error page instead of JSON is reduced to its title and
    server signature rather than discarded.
    """
    if isinstance(body, str):
        try:
            decoded_body = json.loads(body)
        except json.JSONDecodeError:
            decoded_body = None
        if isinstance(decoded_body, dict):
            body = decoded_body
        else:
            html_summary = _html_error_summary(body)
            if html_summary is not None:
                return None, sanitize_error_text(html_summary)
    error = body.get("error") if isinstance(body, dict) else None
    source_code = error.get("code") if isinstance(error, dict) else None
    source_message = error.get("message") if isinstance(error, dict) else None
    if source_message is None and isinstance(body, dict):
        if isinstance(error, str) and error.strip():
            source_message = error
        else:
            for field in ("message", "detail", "msg"):
                value = body.get(field)
                if isinstance(value, str) and value.strip():
                    source_message = value
                    break
        if source_message is not None and source_code is None:
            source_code = body.get("code")
    if isinstance(source_message, str):
        try:
            nested_body = json.loads(source_message)
        except json.JSONDecodeError:
            nested_body = None
        nested_error = (
            nested_body.get("error") if isinstance(nested_body, dict) else None
        )
        if isinstance(nested_error, dict):
            nested_code = nested_error.get("code")
            nested_message = nested_error.get("message")
            if nested_code not in (None, ""):
                source_code = nested_code
            if isinstance(nested_message, str) and nested_message.strip():
                source_message = nested_message
    if isinstance(source_code, bool) or not isinstance(source_code, (str, int)):
        source_code = None
    safe_code = (
        str(source_code)
        if source_code is not None
        and re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", str(source_code))
        else None
    )
    safe_message = None
    if isinstance(source_message, str) and source_message.strip():
        safe_message = sanitize_error_text(source_message)
    return safe_code, safe_message


def sanitize_error_text(text: str) -> str | None:
    """Bound and redact one line of upstream error text for downstream reuse."""
    candidate = text.strip()[:512]
    candidate = re.sub(
        r"(?i)\b(Bearer|Basic)\s+\S+",
        # Basic carries base64 user:password, so the scheme word alone is not
        # the secret — the payload after it is.
        lambda match: f"{match.group(1)} [redacted-token]",
        candidate,
    )
    candidate = re.sub(r"(?i)https?://\S+", "[redacted-url]", candidate)
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
# 512-char bound can cut the closing quote off entirely. A same-quote
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
