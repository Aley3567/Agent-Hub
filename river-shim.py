#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["river-client>=0.6.2"]
# ///
"""river-shim — expose River's gRPC chat channel as an OpenAI Chat endpoint.

claude-hub already owns a complete ``openai_chat`` adapter, and River's chat
RPCs carry a verbatim OpenAI request/response body (``request_json`` /
``response_json`` in ``river.proto``).  The only real mismatch is transport:
a River base model is reachable only over gRPC, while the Hub speaks HTTP.

This process supplies that one missing layer and nothing else.  It never
touches Anthropic semantics — tool calls, reasoning carriers, usage
accounting and SSE framing all stay in the Hub, which already has contract
and invariant suites covering them.

Credentials ride in on the downstream ``Authorization: Bearer`` header, so the
River API key stays in the CC Switch database that owns it.  The shim reads no
config file, writes no key to disk, and keeps keys out of its log lines.

Usage::

    ./river-shim.py                 # 127.0.0.1:18790
    ./river-shim.py --port 18790
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import river_client as river
from river_client.types import (
    AuthenticationError,
    ModelNotFoundError,
    RiverConnectionError,
    RiverError,
    RiverTimeoutError,
)

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18790
DEFAULT_ENDPOINT = "api.river.ai"

# Fields the Hub sends that River's blocking chat RPC cannot accept.
#
# ``stream``/``stream_options``: ``Client.chat_complete`` re-routes any
# ``stream=True`` call to ``chat_complete_stream``, which requires a promoted
# streaming replica.  Base models have none (the control plane answers 404
# ``streaming_replica_not_found``), so leaving the flag in place turns every
# request into an error.  The shim strips it and re-frames the completed
# response as SSE itself.
#
# ``model``: River builds ``request_json`` as
# ``{"model": base_model, "messages": ..., **kwargs}`` and would receive a
# duplicate key.
_STRIPPED_REQUEST_FIELDS = ("stream", "stream_options", "model")

# Client construction opens a gRPC channel and costs roughly a second, so
# clients are reused per credential for the lifetime of the process.
_clients: dict[tuple[str, str], river.Client] = {}
_clients_lock = threading.Lock()


def log(message: str) -> None:
    """Write one timestamped line to stderr.  Never called with a key."""
    stamp = time.strftime("%H:%M:%S")
    print(f"[river-shim {stamp}] {message}", file=sys.stderr, flush=True)


def key_fingerprint(api_key: str) -> str:
    """Short non-reversible label for log lines."""
    import hashlib

    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:8]


def get_client(api_key: str, endpoint: str) -> river.Client:
    cache_key = (endpoint, api_key)
    with _clients_lock:
        client = _clients.get(cache_key)
        if client is None:
            client = river.Client(api_key=api_key, endpoint=endpoint, timeout=1800.0)
            _clients[cache_key] = client
            log(f"opened gRPC channel to {endpoint} for key {key_fingerprint(api_key)}")
        return client


def error_body(message: str, kind: str, code: str | None = None) -> dict:
    """Shape an error the way OpenAI-compatible gateways do.

    The Hub's ``upstream_error_evidence`` reads ``$.error.message`` and
    ``$.error.code``, so keeping this shape means an upstream failure reaches
    Claude Code with its own reason attached rather than a generic wrapper.
    """
    error: dict[str, object] = {"message": message, "type": kind}
    if code:
        error["code"] = code
    return {"error": error}


def status_for_exception(exc: Exception) -> tuple[int, str]:
    """Map a River client exception onto an HTTP status and error type.

    River's own status code is preferred wherever it exists; these are only
    for failures raised before or instead of a backend reply.
    """
    if isinstance(exc, AuthenticationError):
        return 401, "authentication_error"
    if isinstance(exc, ModelNotFoundError):
        return 404, "not_found_error"
    if isinstance(exc, RiverTimeoutError):
        return 504, "timeout_error"
    if isinstance(exc, RiverConnectionError):
        return 502, "connection_error"
    if isinstance(exc, RiverError):
        return 502, "upstream_error"
    return 500, "internal_error"


def normalize_usage(body: dict) -> None:
    """Rewrite River's usage dialect into the plain OpenAI shape, in place.

    Two differences matter downstream:

    * The backend reports ``"prompt_tokens_details": null`` to mean "no
      details".  The Hub treats a present detail key as authoritative and
      requires an object (``HUB_UPSTREAM_USAGE_INVALID``), so a null
      placeholder is dropped instead of forwarded — absence of detail is not
      a detail.
    * ``reasoning_tokens`` arrives at the top level, whereas OpenAI carries it
      under ``completion_tokens_details``.  Moving it there is what lets the
      Hub count reasoning tokens instead of discarding an unknown field.
    """
    usage = body.get("usage")
    if not isinstance(usage, dict):
        return

    for key in [key for key, value in usage.items() if value is None]:
        del usage[key]

    reasoning = usage.pop("reasoning_tokens", None)
    if isinstance(reasoning, int) and not isinstance(reasoning, bool):
        details = usage.get("completion_tokens_details")
        if not isinstance(details, dict):
            details = {}
            usage["completion_tokens_details"] = details
        details.setdefault("reasoning_tokens", reasoning)


def stream_chunks(body: dict, model: str) -> list[dict]:
    """Re-frame one completed OpenAI response as OpenAI streaming chunks.

    River converts a blocking reply into a single stream-shaped chunk in
    ``_stream_chunk_from_blocking_response``; this follows that precedent and
    adds the trailing usage chunk, because the Hub requests
    ``stream_options.include_usage`` and downgrades usage provenance to
    ``HUB_USAGE_PROVENANCE_UNAVAILABLE`` without it.

    Only fields the Hub's ``_feed_chat`` delta allowlist recognises are
    emitted, and ``None`` values are dropped rather than forwarded — a null
    ``content`` is absence of text, not text.
    """
    chunk_id = body.get("id") or f"chatcmpl-{uuid.uuid4().hex}"
    created = body.get("created") or int(time.time())
    model_out = body.get("model") or model

    def envelope(choices: list[dict], usage: dict | None = None) -> dict:
        chunk: dict[str, object] = {
            "id": chunk_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_out,
            "choices": choices,
        }
        if usage is not None:
            chunk["usage"] = usage
        return chunk

    choices: list[dict] = []
    for index, choice in enumerate(body.get("choices") or []):
        if not isinstance(choice, dict):
            continue
        message = choice.get("message")
        message = message if isinstance(message, dict) else {}
        delta: dict[str, object] = {"role": message.get("role") or "assistant"}
        for field in ("reasoning_content", "reasoning", "content", "refusal"):
            value = message.get(field)
            if isinstance(value, str) and value:
                delta[field] = value
        tool_calls = message.get("tool_calls")
        if isinstance(tool_calls, list) and tool_calls:
            # Streaming tool calls are indexed; River's backend already sets
            # ``index``, so only fill it in when the backend omitted it.
            delta["tool_calls"] = [
                {**call, "index": call.get("index", position)}
                for position, call in enumerate(tool_calls)
                if isinstance(call, dict)
            ]
        choices.append(
            {
                "index": choice.get("index", index),
                "delta": delta,
                "finish_reason": choice.get("finish_reason"),
            }
        )

    chunks = [envelope(choices)]
    usage = body.get("usage")
    if isinstance(usage, dict):
        # The Hub rejects choices that arrive after a finish reason but keeps
        # a trailing ``choices: []`` usage event, which is what this is.
        chunks.append(envelope([], usage))
    return chunks


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "river-shim"

    # Silence BaseHTTPRequestHandler's stderr access log; log() covers what
    # matters and never echoes a request header.
    def log_message(self, fmt: str, *args: object) -> None:
        return

    # ── plumbing ────────────────────────────────────────────────────────

    def _send_json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _send_sse(self, chunks: list[dict]) -> None:
        body = bytearray()
        for chunk in chunks:
            body += b"data: " + json.dumps(chunk).encode("utf-8") + b"\n\n"
        body += b"data: [DONE]\n\n"
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.send_header("cache-control", "no-cache")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(bytes(body))

    def _send_error_json(self, status: int, message: str, kind: str) -> None:
        self._send_json(status, error_body(message, kind))

    def _bearer_token(self) -> str | None:
        header = self.headers.get("Authorization", "")
        if header.startswith("Bearer "):
            token = header[len("Bearer ") :].strip()
            if token:
                return token
        return None

    # ── routes ──────────────────────────────────────────────────────────

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = self.path.split("?", 1)[0]
        if path == "/healthz":
            self._send_json(200, {"status": "ok"})
            return
        if path == "/v1/models":
            self._handle_models()
            return
        self._send_error_json(404, f"unknown path {path}", "not_found_error")

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        path = self.path.split("?", 1)[0]
        if path == "/v1/chat/completions":
            self._handle_chat_completions()
            return
        self._send_error_json(404, f"unknown path {path}", "not_found_error")

    def _handle_models(self) -> None:
        api_key = self._bearer_token()
        if not api_key:
            self._send_error_json(
                401, "missing Authorization: Bearer <river-api-key>", "authentication_error"
            )
            return
        try:
            client = get_client(api_key, self.server.river_endpoint)
            models = client.get_capabilities()
        except Exception as exc:  # noqa: BLE001 - surfaced verbatim below
            status, kind = status_for_exception(exc)
            self._send_error_json(status, str(exc), kind)
            return
        self._send_json(
            200,
            {
                "object": "list",
                "data": [
                    {"id": name, "object": "model", "owned_by": "river"}
                    for name in models
                ],
            },
        )

    def _handle_chat_completions(self) -> None:
        api_key = self._bearer_token()
        if not api_key:
            self._send_error_json(
                401, "missing Authorization: Bearer <river-api-key>", "authentication_error"
            )
            return

        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            self._send_error_json(400, "invalid content-length", "invalid_request_error")
            return
        raw = self.rfile.read(length) if length > 0 else b""
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            self._send_error_json(400, f"invalid JSON body: {exc}", "invalid_request_error")
            return
        if not isinstance(payload, dict):
            self._send_error_json(400, "request body must be an object", "invalid_request_error")
            return

        model = payload.get("model")
        if not isinstance(model, str) or not model:
            self._send_error_json(400, "'model' must be a non-empty string", "invalid_request_error")
            return
        messages = payload.get("messages")
        if not isinstance(messages, list) or not messages:
            self._send_error_json(400, "'messages' must be a non-empty array", "invalid_request_error")
            return

        wants_stream = payload.get("stream") is True
        forwarded = {
            key: value
            for key, value in payload.items()
            if key not in _STRIPPED_REQUEST_FIELDS and key != "messages"
        }

        started = time.monotonic()
        try:
            client = get_client(api_key, self.server.river_endpoint)
            result = client.chat_complete(messages, base_model=model, **forwarded)
        except TypeError as exc:
            # An unexpected keyword reaches chat_complete only for fields River
            # does not model; report it as a request problem, not a 502.
            self._send_error_json(400, str(exc), "invalid_request_error")
            return
        except Exception as exc:  # noqa: BLE001 - surfaced verbatim below
            status, kind = status_for_exception(exc)
            log(f"chat_complete failed for {model}: {type(exc).__name__}")
            self._send_error_json(status, str(exc), kind)
            return

        elapsed = time.monotonic() - started
        status_code = getattr(result, "status_code", 200) or 200
        try:
            body = json.loads(result.response_json)
        except (AttributeError, json.JSONDecodeError) as exc:
            self._send_error_json(
                502, f"River returned a non-JSON chat body: {exc}", "upstream_error"
            )
            return
        if not isinstance(body, dict):
            self._send_error_json(
                502, "River returned a non-object chat body", "upstream_error"
            )
            return

        normalize_usage(body)

        finish = ""
        first = (body.get("choices") or [{}])[0]
        if isinstance(first, dict):
            finish = str(first.get("finish_reason") or "")
        usage = body.get("usage") if isinstance(body.get("usage"), dict) else {}
        log(
            f"{model} {status_code} {'sse' if wants_stream else 'json'} "
            f"finish={finish or '-'} "
            f"in={usage.get('prompt_tokens', '-')} out={usage.get('completion_tokens', '-')} "
            f"{elapsed:.1f}s"
        )

        # A non-200 from the backend is passed through untouched: the Hub
        # forwards the upstream status and reason rather than masking it.
        if status_code != 200 or not wants_stream:
            self._send_json(status_code, body)
            return
        self._send_sse(stream_chunks(body, model))


class ShimServer(ThreadingHTTPServer):
    daemon_threads = True
    # Reuse is safe on loopback and avoids TIME_WAIT churn across restarts.
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], endpoint: str) -> None:
        super().__init__(address, Handler)
        self.river_endpoint = endpoint


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="river-shim",
        description="Serve River's gRPC chat channel as an OpenAI Chat endpoint.",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("RIVER_SHIM_HOST", DEFAULT_HOST),
        help=f"bind address (default {DEFAULT_HOST}; loopback only)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("RIVER_SHIM_PORT", DEFAULT_PORT)),
        help=f"bind port (default {DEFAULT_PORT})",
    )
    parser.add_argument(
        "--river-endpoint",
        default=os.environ.get("RIVER_ENDPOINT", DEFAULT_ENDPOINT),
        help=f"River API hostname (default {DEFAULT_ENDPOINT})",
    )
    args = parser.parse_args(argv)

    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        # The shim authenticates nothing of its own: it forwards whatever
        # bearer token it is handed. Binding it off loopback would expose that
        # relay to the network.
        parser.error("--host must stay on loopback (127.0.0.1, localhost or ::1)")

    server = ShimServer((args.host, args.port), args.river_endpoint)
    log(f"listening on http://{args.host}:{args.port} -> {args.river_endpoint}")
    log("POST /v1/chat/completions | GET /v1/models | GET /healthz")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log("shutting down")
    finally:
        server.server_close()
        with _clients_lock:
            for client in _clients.values():
                client.close()
            _clients.clear()
    return 0


if __name__ == "__main__":
    sys.exit(main())
