# gateway — M0/M1 transparent repair proxy + M2 forward-conversion gateway

A defensive HTTP proxy that sits between an Anthropic client (e.g. Claude Code)
and an upstream OpenAI-to-Anthropic converter that is known to omit the final
SSE termination events. The proxy relays every upstream byte unchanged and only
intervenes when the upstream stream ends prematurely. With a policy file
configured it additionally rewrites thinking budgets on requests and cuts off
runaway thinking streams with an honest `max_tokens` ending.

**M2 adds a forward-conversion mode** (path B from the root-cause roadmap):
when `TRANSFORM_MODE=openai-responses`, POST `/v1/messages` is converted into
an OpenAI Responses API request and posted to the upstream's
`/v1/responses` endpoint. The upstream OpenAI SSE stream is parsed by the
openairesponses adapter, fed through the canonical event layer, and rendered
back to Anthropic SSE for the downstream client. **The upstream's broken
OpenAI→Anthropic reverse-conversion path is bypassed entirely — termination
semantics are owned by the local renderer.** See `docs/PRD-M2.md` for design.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `LISTEN_ADDR` | `127.0.0.1:3458` | Address the proxy listens on. |
| `UPSTREAM_BASE_URL` | `http://127.0.0.1:9999` | Base URL of the upstream API. |
| `POLICY_FILE` | *(empty)* | Path to the per-model policy JSON file. Empty means no policy: the gateway behaves exactly like M0 (pure transparent repair). |
| `TRANSFORM_MODE` | *(empty)* | Forward-conversion mode. Empty = M0/M1 transparent repair. `openai-responses` = path B (Anthropic↔OpenAI Responses). Other values log a warning and fall back to M0. |
| `UPSTREAM_RESPONSES_PATH` | `/v1/responses` | Upstream path to POST converted OpenAI Responses requests to (used only when `TRANSFORM_MODE=openai-responses`). |

## Two operating modes

### Mode 1: transparent repair (default, M0/M1 behavior)

When `TRANSFORM_MODE` is empty, the gateway preserves upstream bytes verbatim
and only intervenes on premature EOF (M0) and runaway thinking (M1). This is
the original mode; it is the only behavior compatible with upstreams that
already speak Anthropic correctly (e.g. DeepSeek's official Anthropic endpoint,
阿里百炼 anthropic adapter).

```
Claude Code → gateway[transparent + repair] → upstream /v1/messages
```

### Mode 2: forward-conversion (path B, M2)

When `TRANSFORM_MODE=openai-responses`, the gateway owns the translation
itself. It accepts Anthropic `/v1/messages` requests from the client,
converts them to OpenAI Responses API requests, POSTs them to the upstream's
`/v1/responses` endpoint (which is healthy on agentrouter per the
consultation evidence matrix), parses the OpenAI SSE stream back through the
local adapter → canonical layer → renderer, and emits a fresh Anthropic SSE
stream to the client. **The termination trio (content_block_stop /
message_delta / message_stop) is synthesized by the local renderer when
`response.completed` arrives — it is never "discovered missing after the
fact" the way M0 repair does.**

```
Claude Code → gateway[Anthropic→OpenAI Responses→Anthropic] → upstream /v1/responses
```

**When to use which:**

- Upstream speaks Anthropic correctly (DeepSeek official, 百炼) → Mode 1.
- Upstream's `/v1/messages` path is broken but `/v1/responses` is healthy
  (agentrouter / new-api) → Mode 2.
- Other tools (Codex) and other upstream paths (`/v1/chat/completions`) →
  unaffected; both modes pass through unchanged.

**Limitations of Mode 2 (M2 scope, see PRD):**

- Only OpenAI Responses API adapter is implemented; Chat Completions adapter
  is M3+.
- Tool calls / images / tool_result content blocks in requests are dropped
  (text-only M2; full tool support is a future addition).
- M1 runaway detector is not yet wired into the transform path; thinking
  runaway detection currently only runs in Mode 1.
- **Not yet validated against a live agentrouter** — M2 ships with unit
  tests + golden fixtures + end-to-end mock tests, but live acceptance
  requires the user to supply agentrouter credentials and run a real
  streaming request. See "Live acceptance" below.

## Live acceptance (not yet performed)

To validate Mode 2 against a real agentrouter:

```bash
export LISTEN_ADDR=127.0.0.1:3458
export UPSTREAM_BASE_URL=<your-upstream-base-url>
export UPSTREAM_RESPONSES_PATH=/v1/responses
export TRANSFORM_MODE=openai-responses
# POLICY_FILE optional; the policy's reasoning.effort mapping is M2.1.
# thinking.budget_tokens injection was removed entirely: upstream discards
# it, injecting breaks request byte fidelity, and current models (Opus
# 4.7/4.8, Opus 5, Sonnet 5, Fable 5) reject budget_tokens with 400.
./gateway &

# Then point Claude Code at the gateway:
#   ANTHROPIC_BASE_URL=http://127.0.0.1:3458
#   ANTHROPIC_AUTH_TOKEN=<your-agentrouter-key>
#
# Send a streaming /v1/messages request and observe:
#   - gateway log: "transform: ..." lines
#   - downstream SSE contains full message_start → ... → message_stop trio
#   - no "Connection lost mid-response" error from Claude Code
```

Requests carrying `tool_use` or `tool_result` content blocks are refused
with a 400 in this mode: the conversion cannot represent them, and dropping
them while still rendering `end_turn` would report a tool call as completed
when it never ran. Use the default passthrough mode for tool-using requests.
Blocks that are lossy but not causally load-bearing (`image`, `thinking`) are
dropped with a `HUB_DEGRADE_TRANSFORM_BLOCK_DROPPED` log line.

If agentrouter's `/v1/responses` path is not available or returns non-SSE,
the gateway emits a single Anthropic error event (never a silent truncation).
See `docs/PRD-M2.md` §"Design red lines" for the failure-mode contract.

## Policy file

```json
{
  "models": {
    "deepseek-v4f": {
      "thinking": {"max_budget_tokens": 8192},
      "runaway_detection": {"enabled": true}
    }
  }
}
```

Matched by the request body's `model` field. Models with no entry are
forwarded byte-identical. Changes require a restart (no hot reload).

- **Request rewrite** (only `POST /v1/messages`, only Mode 1; Mode 2 will
  apply reasoning.effort injection in M2.1):
  - no `thinking` field → forwarded verbatim (injection was removed);
  - `budget_tokens` above `max_budget_tokens` → clamped down;
  - `thinking.type == "disabled"` → left alone.
- **Runaway detection** (streaming responses, Mode 1 only in M2): when any
  model entry enables `runaway_detection`, the observer feeds incremental
  thinking/text text to a sliding-window detector with two independent
  signals:
  1. *Pattern repeat* — the last `window` bytes (default 512) end with one
     pattern of at most `max_pattern` bytes (default 64) repeated at least
     `min_repeats` times (default 6).
  2. *Digit interleave density* — in the last `digit_window` runes (default
     512) the ASCII-digit fraction reaches `digit_ratio` (default 0.45). This
     catches the observed deepseek-v4 failure where incrementing numbers are
     inserted between every character ("中1世2纪3…"), which no verbatim-repeat
     check can see. Judged only on a full window, so short numeric fragments
     never trip it.

  When the detector fires, the proxy stops relaying upstream bytes, writes a
  `: truncated-by-gateway: runaway-thinking` comment, closes every open
  content block, emits `message_delta` with `stop_reason: "max_tokens"` and
  `message_stop`, then cancels the upstream request. `max_tokens` is
  approximately honest (the effect equals budget exhaustion); the comment
  carries the real reason.

## What it does

- `GET /healthz` returns `200 OK` with body `ok`.
- All `/v1/*` requests are forwarded to `UPSTREAM_BASE_URL` with bodies and
  headers preserved. Hop-by-hop headers (`Host`, `Connection`, etc.) are
  stripped; client headers such as `Authorization`, `x-api-key`,
  `anthropic-version`, and `anthropic-beta` pass through unchanged.
- For `POST /v1/messages` responses whose `Content-Type` contains
  `text/event-stream`, the proxy watches the SSE event lifecycle in a side
  channel. The SSE scanner accepts both `data: {...}` and `data:{...}`
  (no-space) framing.
- If the upstream connection ends before `message_stop`:
  - A clean EOF closes every still-open content block (in ascending index
    order), emits a `message_delta` with `stop_reason: "end_turn"`, and finally
    emits `message_stop`. A clean EOF stays `end_turn`: the gateway cannot
    know why the upstream stopped and does not invent a reason.
  - An upstream read error emits an Anthropic `event: error` frame and **does
    not** emit `message_stop`, so an interruption is never disguised as a clean
    end.
- If the gateway itself truncates a runaway stream, the closing frames use
  `stop_reason: "max_tokens"` (see above).
- A duplicated `message_start` (observed from converters that lag one chunk
  behind on 1–2 chunk streams) never resets completed observer state.
- **In Mode 2**, the same termination invariants hold, but they are produced
  by the renderer when the adapter sees `response.completed` (not by the M0
  repair pass). If the upstream EOFs without `response.completed`, the
  renderer falls back to M0-equivalent finalize (close blocks + end_turn +
  message_stop + `: repaired-by-transform` comment).

## Design red lines

1. **Byte fidelity** applies to deltas in both modes. In Mode 1, upstream
   bytes are written to the client exactly as received. In Mode 2, delta
   text emitted by the adapter is written to the client verbatim — the
   gateway never re-serializes signature or thinking bytes that the
   adapter produced.
2. **No forged signatures.** Repair, truncation, and transform-renderer
   frames only synthesize control events (`content_block_stop`,
   `message_delta`, `message_stop`). They never invent or rewrite
   `signature` fields. Missing signatures are simply omitted.
3. **Errors stay errors.** A broken upstream connection (Mode 1) or a
   `response.failed` / non-SSE upstream (Mode 2) produces an `api_error`
   event; it does not get a synthetic `message_stop`.
4. **No global streaming timeout.** Long thinking phases are not aborted by an
   arbitrary deadline. The only timeout is the client connection itself.
5. **Downstream write failures cancel upstream.** If the client goes away or
   the response writer fails, the upstream request is canceled immediately.
6. **Avoid false positives first.** The runaway detector prefers missing a
   degeneration over cutting healthy output: a miss merely falls back to M0
   behavior, while a false positive destroys good content. Every detection
   threshold defaults to the conservative side and is tunable in the policy
   file.

## Layout

```
gateway/
├── cmd/gateway/main.go   # entrypoint: reads env and starts the server
├── internal/
│   ├── sse/              # read-only SSE frame scanner (both "data: " and "data:" framing)
│   ├── repair/           # M0/M1 stream lifecycle state machine + runaway detector
│   ├── policy/           # per-model policy table: load, match, request rewrite
│   ├── proxy/            # HTTP relay and IO orchestration (both modes)
│   ├── canonical/        # M2 protocol-neutral event types (adapter↔renderer contract)
│   ├── adapter/openairesponses/  # M2 OpenAI Responses SSE → canonical events
│   └── renderer/anthropic/       # M2 canonical events → Anthropic SSE bytes
├── docs/
│   ├── PRD-M1.md         # M1 (transparent repair + runaway detection) scope
│   └── PRD-M2.md         # M2 (forward-conversion path B) scope
└── testdata/sse/        # golden SSE captures for M0/M1 tests
```

`internal/repair` is a deep module: its public surface is
`Observe(eventType, data)`, `Truncated()`, `Truncate()`, and
`Finalize(cleanEOF)`, while all lifecycle and detector state stays hidden
inside.

`internal/canonical` is intentionally tiny — pure data types and
constructors, no IO. It is the contract between adapter and renderer; both
sides depend on it but neither depends on the other.

`internal/renderer/anthropic.Renderer` exposes `Render(canonical.Event) →
[][]byte` and `FinalizeFrames() → [][]byte`. It is single-use per stream.

`internal/adapter/openairesponses.Adapter` exposes `Feed(eventType, data) →
([]canonical.Event, error)`. It is also single-use per stream and tracks
block lifecycle internally.

## Build & test

```bash
export PATH=/Users/admin/Desktop/claude-hub/tools/go-sdk/bin:$PATH
export GOPATH=/Users/admin/Desktop/claude-hub/tools/go-sdk-cache
export GOMODCACHE=/Users/admin/Desktop/claude-hub/tools/go-sdk-cache/pkg/mod

gofmt -l .
go vet ./...
go test ./...
go build ./cmd/gateway
```

The project uses only the Go standard library.

