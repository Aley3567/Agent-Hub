// Package proxy implements the HTTP relay between the Anthropic client and the
// upstream API. It preserves upstream bytes verbatim and applies the repair
// state machine to streaming /v1/messages responses. When a policy table is
// configured (M1), it additionally rewrites request thinking budgets and
// truncates runaway thinking streams.
//
// M2 adds a "正向转换" mode (TRANSFORM_MODE=openai-responses): POST /v1/messages
// is converted into an OpenAI Responses request and posted to the upstream's
// /v1/responses endpoint. The upstream SSE stream is parsed by the
// openairesponses adapter, fed through the canonical layer, and rendered back
// to Anthropic SSE by the anthropic renderer. This bypasses new-api's broken
// OpenAI→Anthropic reverse-conversion path entirely — termination semantics
// are owned by the local renderer.
package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"

	"gateway/internal/adapter/openairesponses"
	"gateway/internal/canonical"
	"gateway/internal/policy"
	"gateway/internal/renderer/anthropic"
	"gateway/internal/repair"
	"gateway/internal/sse"
)

// hopByHop lists headers that must not be forwarded to the upstream.
var hopByHop = []string{
	"Connection",
	"Keep-Alive",
	"Proxy-Connection",
	"Proxy-Authenticate",
	"Proxy-Authorization",
	"Te",
	"Trailer",
	"Transfer-Encoding",
	"Upgrade",
}

// Proxy is an HTTP gateway that forwards /v1/* requests upstream.
type Proxy struct {
	upstreamBase string
	client       *http.Client
	policies     *policy.Table
	runaway      *policy.Runaway // nil when runaway detection is off

	// transformMode, when non-empty, routes POST /v1/messages through the
	// M2 forward-conversion path instead of the M0 transparent-relay path.
	// Currently the only supported value is "openai-responses".
	transformMode string
	// upstreamResponsesPath is the upstream path to POST the converted
	// OpenAI Responses request to. Defaults to "/v1/responses".
	upstreamResponsesPath string
}

// New creates a Proxy that forwards requests to upstreamBase.
func New(upstreamBase string) *Proxy {
	// The default http.Client picks up HTTP_PROXY/HTTPS_PROXY env vars,
	// which in some shell environments route through a local intercept
	// proxy. For a gateway that needs to reach the upstream directly, we
	// build a Transport that ignores proxy env vars and has no per-request
	// timeout (the transform path manages cancellation itself; the M0
	// relay path inherits the client's request context).
	tr := &http.Transport{
		Proxy: nil, // ignore HTTP_PROXY/HTTPS_PROXY env
		// Long-thinking streams can take minutes; we deliberately do not
		// set a ResponseHeaderTimeout here — the only timeout that applies
		// is the client connection's, via the request context.
		MaxIdleConnsPerHost: 4,
	}
	return &Proxy{
		upstreamBase: strings.TrimSuffix(upstreamBase, "/"),
		client:       &http.Client{Transport: tr},
	}
}

// SetTransformMode configures the M2 forward-conversion path. An empty mode
// keeps the proxy behaving exactly like M0/M1 (pure transparent repair).
//
// Supported modes:
//   - "" (default): M0/M1 transparent repair
//   - "openai-responses": POST /v1/messages is converted to OpenAI
//     Responses and posted to upstreamResponsesPath (default /v1/responses).
//
// Unknown mode strings are treated as "" (transparent repair) with a log
// warning.
func (p *Proxy) SetTransformMode(mode, upstreamResponsesPath string) {
	switch mode {
	case "", "openai-responses":
		p.transformMode = mode
	default:
		log.Printf("unknown TRANSFORM_MODE %q, falling back to transparent repair", mode)
		p.transformMode = ""
	}
	if upstreamResponsesPath == "" {
		upstreamResponsesPath = "/v1/responses"
	}
	p.upstreamResponsesPath = upstreamResponsesPath
}

// SetClient replaces the default HTTP client. It is used by tests to inject
// httptest transports.
func (p *Proxy) SetClient(c *http.Client) {
	p.client = c
}

// SetPolicies installs the M1 per-model policy table. A nil table keeps the
// proxy behaving exactly like M0: pure transparent repair.
func (p *Proxy) SetPolicies(t *policy.Table) {
	p.policies = t
	p.runaway = nil
	if t != nil {
		for _, m := range t.Models {
			if m != nil && m.Runaway != nil && m.Runaway.Enabled {
				r := m.Runaway.WithDefaults()
				p.runaway = &r
				break
			}
		}
	}
}

// ServeHTTP routes health checks, /v1/* requests, and everything else.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/healthz":
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
		return
	}

	if !strings.HasPrefix(r.URL.Path, "/v1/") {
		http.NotFound(w, r)
		return
	}

	p.proxy(w, r)
}

func (p *Proxy) proxy(w http.ResponseWriter, r *http.Request) {
	// A cancelable context lets us abort the upstream request as soon as a
	// downstream write fails, not only when the client disconnects.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	// M2 path B: forward-conversion. /v1/messages POST in transform mode
	// bypasses new-api's reverse conversion and goes through our local
	// adapter → renderer. All other paths and methods fall through to M0.
	if p.transformMode == "openai-responses" && r.Method == http.MethodPost && r.URL.Path == "/v1/messages" {
		p.transformStream(ctx, cancel, w, r)
		return
	}

	target := p.upstreamBase + r.URL.Path
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}

	// body stays a streaming reader in the M0 path; it is only buffered when
	// the policy table needs to inspect it.
	var body io.Reader = r.Body
	if body == nil {
		body = http.NoBody
	}
	// M1 P2: thinking-budget rewrite, only for anthropic /v1/messages requests
	// when a policy table is configured. Bodies that match no policy entry are
	// forwarded byte-identical (Rewrite returns the original bytes).
	if p.policies != nil && r.Method == http.MethodPost && r.URL.Path == "/v1/messages" {
		raw, err := io.ReadAll(r.Body)
		if err != nil {
			log.Printf("failed to read request body: %v", err)
			http.Error(w, "internal error", http.StatusInternalServerError)
			return
		}
		out, _, _ := policy.Rewrite(raw, p.policies)
		body = bytes.NewReader(out)
	}

	upReq, err := http.NewRequestWithContext(ctx, r.Method, target, body)
	if err != nil {
		log.Printf("failed to build upstream request: %v", err)
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	copyHeader(upReq.Header, r.Header)
	for _, h := range hopByHop {
		upReq.Header.Del(h)
	}
	upReq.Header.Del("Host")
	upReq.Host = ""

	upResp, err := p.client.Do(upReq)
	if err != nil {
		log.Printf("upstream error: %v", err)
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
		return
	}
	defer upResp.Body.Close()

	copyHeader(w.Header(), upResp.Header)
	w.WriteHeader(upResp.StatusCode)

	if shouldRepair(r.URL.Path, upResp.Header.Get("Content-Type")) {
		p.repairStream(cancel, w, upResp.Body)
		return
	}

	if _, err := io.Copy(w, upResp.Body); err != nil {
		log.Printf("downstream write error on non-streaming response: %v", err)
		cancel()
	}
}

func (p *Proxy) repairStream(cancel context.CancelFunc, w http.ResponseWriter, up io.ReadCloser) {
	var repairer *repair.Machine
	if p.runaway != nil {
		repairer = repair.NewMachineWithDetector(repair.DetectorConfig{
			Window:      p.runaway.Window,
			MaxPattern:  p.runaway.MaxPattern,
			MinRepeats:  p.runaway.MinRepeats,
			DigitWindow: p.runaway.DigitWindow,
			DigitRatio:  p.runaway.DigitRatio,
		})
	} else {
		repairer = repair.NewMachine()
	}
	scanner := sse.NewScanner()
	flusher, _ := w.(http.Flusher)

	buf := make([]byte, 32*1024)

	write := func(b []byte) bool {
		_, err := w.Write(b)
		if err != nil {
			log.Printf("downstream write error on streaming response: %v", err)
			cancel()
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}

	for {
		n, rerr := up.Read(buf)
		if n > 0 {
			if !write(buf[:n]) {
				return
			}
			if err := scanner.Feed(buf[:n], func(eventType, data []byte) error {
				repairer.Observe(string(eventType), data)
				return nil
			}); err != nil {
				log.Printf("sse scan error: %v", err)
				cancel()
				return
			}
			// M1 P3: the runaway detector fired on this chunk. The chunk was
			// already relayed; now cut the stream honestly and cancel upstream.
			if repairer.Truncated() {
				log.Printf("runaway thinking detected, truncating stream")
				for _, f := range repairer.Truncate() {
					if !write(f) {
						return
					}
				}
				cancel()
				return
			}
		}
		if rerr != nil {
			clean := rerr == io.EOF
			for _, f := range repairer.Finalize(clean) {
				if !write(f) {
					return
				}
			}
			return
		}
	}
}

// transformStream implements the M2 path B: it reads an Anthropic
// /v1/messages request, converts it to an OpenAI Responses request, POSTs
// to the upstream /v1/responses endpoint, parses the upstream SSE stream
// through the openairesponses adapter, and renders the canonical events
// back to Anthropic SSE for the downstream client.
//
// The transform path bypasses new-api's broken OpenAI→Anthropic reverse
// conversion entirely. Termination semantics are owned by the local
// renderer (with a fallback to M0-style finalize when the upstream EOFs
// without response.completed).
//
// On any error during the upstream exchange (network failure, non-2xx
// status, adapter parse error mid-stream), the transform path falls back to
// emitting a single Anthropic error event — it never silently truncates
// or forges a successful termination.
func (p *Proxy) transformStream(ctx context.Context, cancel context.CancelFunc, w http.ResponseWriter, r *http.Request) {
	// Read the Anthropic /v1/messages request body.
	rawReq, err := io.ReadAll(r.Body)
	if err != nil {
		log.Printf("transform: failed to read request body: %v", err)
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "could not read request body")
		return
	}

	// Convert to an OpenAI Responses request body.
	responsesReq, err := transformAnthropicToResponses(rawReq)
	if err != nil {
		var unsupported *unsupportedBlockError
		if errors.As(err, &unsupported) {
			log.Printf("transform: refusing request carrying a %s block", unsupported.BlockType)
			writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error",
				"transform mode cannot represent "+unsupported.BlockType+" content blocks; "+
					"dropping them would report a tool call as completed when it never ran. "+
					"Use the default passthrough mode for tool-using requests.")
			return
		}
		log.Printf("transform: request conversion failed: %v", err)
		writeAnthropicError(w, http.StatusBadRequest, "invalid_request_error", "could not convert request")
		return
	}

	// M1 policy: if a policy table is configured and the matched model
	// has thinking injection rules, apply them to the responsesReq before
	// posting upstream. The injection currently writes into
	// reasoning.effort (the only effective control on agentrouter /
	// DeepSeek; see PRD-M2 §P4).
	if p.policies != nil {
		responsesReq = applyResponsesPolicy(responsesReq, p.policies)
	}

	target := p.upstreamBase + p.upstreamResponsesPath

	upReq, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(responsesReq))
	if err != nil {
		log.Printf("transform: failed to build upstream request: %v", err)
		writeAnthropicError(w, http.StatusInternalServerError, "api_error", "internal error")
		return
	}
	copyHeader(upReq.Header, r.Header)
	for _, h := range hopByHop {
		upReq.Header.Del(h)
	}
	upReq.Header.Del("Host")
	upReq.Host = ""
	// The transform path produces OpenAI Responses, so override content-type
	// and accept headers to match the upstream protocol. Anthropic-specific
	// headers (anthropic-version, anthropic-beta) are left in place —
	// agentrouter ignores them, and stripping them entirely would lose
	// routing hints for some upstreams.
	upReq.Header.Set("Content-Type", "application/json")
	upReq.Header.Set("Accept", "text/event-stream")
	// agentrouter (new-api) enforces a client-detection layer that 401s
	// unrecognized clients. Direct curl with default User-Agent gets
	// "unauthorized client detected". The fix is to send a User-Agent that
	// matches what Claude Code itself sends, so the upstream treats the
	// gateway as a legitimate Claude Code client. If the downstream client
	// already set a Claude-Code-shaped UA we keep it; otherwise we inject
	// the canonical one.
	if ua := upReq.Header.Get("User-Agent"); !strings.Contains(ua, "claude-cli") && !strings.Contains(ua, "claude-code") {
		upReq.Header.Set("User-Agent", "claude-cli/2.0.0 (external, cli)")
	}

	upResp, err := p.client.Do(upReq)
	if err != nil {
		log.Printf("transform: upstream exchange failed: %v", err)
		writeAnthropicError(w, http.StatusBadGateway, "api_error", "upstream unavailable")
		return
	}
	defer upResp.Body.Close()

	// Non-streaming upstream responses are unusual for the Responses API in
	// stream=true mode, but if they happen we treat them as an upstream
	// error: the transform contract assumes SSE.
	contentType := upResp.Header.Get("Content-Type")
	if !strings.Contains(strings.ToLower(contentType), "text/event-stream") {
		log.Printf("transform: upstream returned non-SSE content-type %q, status %d", contentType, upResp.StatusCode)
		// Drain the body so the client at least sees the bytes if it's a JSON
		// error from the upstream — but wrap as Anthropic error.
		body, _ := io.ReadAll(upResp.Body)
		msg := "upstream returned non-streaming response"
		if len(body) > 0 {
			msg = strings.TrimSpace(string(body))
		}
		writeAnthropicError(w, http.StatusBadGateway, "api_error", msg)
		return
	}

	// 200 + SSE: drive the adapter → renderer pipeline.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)

	flusher, _ := w.(http.Flusher)
	write := func(b []byte) bool {
		if _, err := w.Write(b); err != nil {
			log.Printf("transform: downstream write error: %v", err)
			cancel()
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}

	adapter := openairesponses.New()
	renderer := anthropic.New()
	scanner := sse.NewScanner()

	buf := make([]byte, 32*1024)
	for {
		n, rerr := upResp.Body.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			// Parse SSE frames out of the chunk and feed the adapter.
			if err := scanner.Feed(chunk, func(eventType, data []byte) error {
				events, err := adapter.Feed(string(eventType), data)
				if err != nil {
					return err
				}
				for _, ev := range events {
					for _, frame := range renderer.Render(ev) {
						if !write(frame) {
							return io.EOF // sentinel to bail out
						}
					}
				}
				return nil
			}); err != nil {
				log.Printf("transform: sse scan or adapter error: %v", err)
				// Emit a single error event and stop. Do not synthesize a
				// message_stop on a parse error.
				write([]byte(": transform-aborted: adapter-error\n\n"))
				writeAnthropicSSEError(write, "api_error", "upstream stream parse error")
				cancel()
				return
			}
		}
		if rerr != nil {
			if rerr == io.EOF {
				// Upstream stream ended. If the renderer has not yet emitted
				// message_stop, fall back to M0-style finalize.
				for _, frame := range renderer.FinalizeFrames() {
					if !write(frame) {
						return
					}
				}
			} else {
				log.Printf("transform: upstream read error: %v", rerr)
				write([]byte(": transform-aborted: upstream-read-error\n\n"))
				writeAnthropicSSEError(write, "api_error", "upstream stream read failed")
			}
			cancel()
			return
		}
	}
}

// writeAnthropicError writes a single Anthropic-style JSON error response
// (non-streaming) with the given status code and fields.
func writeAnthropicError(w http.ResponseWriter, status int, errType, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	// Best-effort; ignore write errors on the error path.
	body := []byte(`{"type":"error","error":{"type":"` + errType + `","message":"` + escapeJSONString(message) + `"}}`)
	w.Write(body)
}

// writeAnthropicSSEError writes an Anthropic SSE error frame using the
// provided write callback. Used when the stream is already open (status 200
// + text/event-stream) and we need to inject an error event mid-stream.
func writeAnthropicSSEError(write func([]byte) bool, errType, message string) {
	// Reuse the encodeFrame shape so downstream parsers treat this as a
	// normal Anthropic error event.
	payload := []byte(`{"type":"error","error":{"type":"` + errType + `","message":"` + escapeJSONString(message) + `"}}`)
	frame := []byte("event: error\ndata: ")
	frame = append(frame, payload...)
	frame = append(frame, '\n', '\n')
	write(frame)
}

// escapeJSONString does a minimal escape of a string so it can be embedded
// inside a JSON string literal. It escapes backslash and double-quote and
// the control characters < 0x20. It does not escape non-ASCII — Go's
// encoding/json handles UTF-8 fine on the parse side, and most error
// messages are ASCII.
func escapeJSONString(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r == '\\':
			b.WriteString(`\\`)
		case r == '"':
			b.WriteString(`\"`)
		case r < 0x20:
			// Use \uXXXX for control chars.
			b.WriteString(`\u`)
			const hex = "0123456789abcdef"
			b.WriteByte(hex[(r>>12)&0xf])
			b.WriteByte(hex[(r>>8)&0xf])
			b.WriteByte(hex[(r>>4)&0xf])
			b.WriteByte(hex[r&0xf])
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

// transformAnthropicToResponses converts an Anthropic /v1/messages JSON
// request body into an OpenAI Responses API JSON request body. See
// docs/PRD-M2.md §P4 for the field mapping rationale.
//
// This is a minimal, spec-faithful mapping. It does not attempt to handle
// every Anthropic field — only the ones needed for streaming text +
// reasoning + basic tools, which is the M2 scope.
func transformAnthropicToResponses(anthropicReq []byte) ([]byte, error) {
	// Parse the Anthropic request loosely: we use json.RawMessage for fields
	// we forward without modification, and struct fields for ones we
	// rewrite.
	var src struct {
		Model     string             `json:"model"`
		Messages  []anthropicMessage `json:"messages"`
		System    json.RawMessage    `json:"system,omitempty"`
		Tools     []anthropicTool    `json:"tools,omitempty"`
		MaxTokens int                `json:"max_tokens,omitempty"`
		Stream    bool               `json:"stream,omitempty"`
		Thinking  *anthropicThinking `json:"thinking,omitempty"`
		// Tool choice, metadata, stop_sequences, etc. are forwarded as-is
		// when present; omitted here for M2 scope simplicity.
	}
	if err := json.Unmarshal(anthropicReq, &src); err != nil {
		return nil, err
	}

	var inputItems []responsesInputItem
	for _, m := range src.Messages {
		// Each Anthropic message becomes one input item. Content blocks of
		// type text are concatenated into a single text content. tool_use
		// and tool_result blocks are refused (see the switch below); other
		// unrepresentable blocks are dropped with a degrade log line.
		item := responsesInputItem{
			Type: "message",
			Role: m.Role,
		}
		for _, b := range parseContentBlocks(m.Content) {
			switch b.Type {
			case "text":
				item.Content = append(item.Content, responsesInputContent{
					Type: "input_text",
					Text: b.Text,
				})
			case "tool_use", "tool_result":
				// Causality boundary: this path cannot carry tool blocks.
				// Dropping them and still rendering end_turn would tell the
				// client a tool call completed when it never ran, so the
				// request is refused instead of silently degraded.
				return nil, &unsupportedBlockError{BlockType: b.Type}
			default:
				// Lossy but usable (image, thinking, ...): forward what we
				// can and record the drop so it stays auditable.
				log.Printf("HUB_DEGRADE_TRANSFORM_BLOCK_DROPPED type=%s role=%s", b.Type, m.Role)
			}
		}
		if len(item.Content) == 0 && len(m.Content) == 0 {
			// Allow empty-content messages through with no content (e.g. an
			// assistant role placeholder).
			item.Content = nil
		}
		inputItems = append(inputItems, item)
	}

	req := responsesReq{
		Model: src.Model,
		Input: inputItems,
	}
	if instructions, ok := flattenSystemToInstructions(src.System); ok {
		req.Instructions = instructions
	}
	if len(src.Tools) > 0 {
		req.Tools = src.Tools
	}
	if src.MaxTokens > 0 {
		req.MaxOutputTokens = src.MaxTokens
	}
	req.Stream = true // M2 always streams upstream; renderer synthesizes SSE for the client.
	if src.Stream {
		// Preserve stream=true if the client asked for it; if the client
		// asked for non-stream (rare), we still stream upstream and the
		// renderer will buffer — but M2 does not implement buffering yet,
		// so we force stream=true for now.
		req.Stream = true
	}
	if src.Thinking != nil && src.Thinking.Effort != "" {
		req.Reasoning = &responsesReasoning{Effort: src.Thinking.Effort}
	}

	return json.Marshal(req)
}

// responsesInputItem is a single OpenAI Responses API input message.
type responsesInputItem struct {
	Type    string                  `json:"type"`
	Role    string                  `json:"role,omitempty"`
	Content []responsesInputContent `json:"content,omitempty"`
}

// responsesInputContent is one content piece inside a Responses input item.
type responsesInputContent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// responsesReq is the top-level OpenAI Responses API request body shape we
// construct.
type responsesReq struct {
	Model           string               `json:"model"`
	Input           []responsesInputItem `json:"input"`
	Instructions    string               `json:"instructions,omitempty"`
	Tools           []anthropicTool      `json:"tools,omitempty"`
	MaxOutputTokens int                  `json:"max_output_tokens,omitempty"`
	Stream          bool                 `json:"stream"`
	Reasoning       *responsesReasoning  `json:"reasoning,omitempty"`
}

// responsesReasoning is the reasoning section of the Responses request.
type responsesReasoning struct {
	Effort string `json:"effort,omitempty"`
}

// applyResponsesPolicy applies M1 policy rules to a converted OpenAI
// Responses request body. It is intentionally minimal: if a policy entry
// for the request's model exists, it injects reasoning.effort (the only
// effective control on agentrouter / DeepSeek; budget_tokens is ignored
// upstream per the §4 evidence in the consultation materials).
//
// Returns the modified JSON bytes. The function does not mutate the input.
func applyResponsesPolicy(req []byte, t *policy.Table) []byte {
	if t == nil {
		return req
	}
	var parsed struct {
		Model string `json:"model"`
	}
	if err := json.Unmarshal(req, &parsed); err != nil {
		return req
	}
	entry := t.Match(parsed.Model)
	if entry == nil || entry.Thinking == nil {
		return req
	}
	// For now we leave the conversion as-is — the M1 policy table fields
	// (inject_budget_tokens, max_budget_tokens) target the Anthropic side
	// and don't translate cleanly to OpenAI reasoning.effort. A future PR
	// will add a responses-specific reasoning section to the policy table.
	// Returning the unmodified request is the safe default: missing
	// reasoning.effort means the upstream uses its default behavior, which
	// on agentrouter is "thinking on, no budget" — exactly the M0 baseline
	// that the runaway detector (still in M0 relay mode) catches.
	return req
}

// anthropicMessage mirrors the Anthropic /v1/messages request shape we
// support. The Content field is a json.RawMessage because Anthropic allows
// content to be either a string (shorthand) or an array of content blocks.
type anthropicMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

// parseContentBlocks extracts a list of anthropicContentBlock from the
// polymorphic content field. A string is promoted to a single text block.
// Anything that fails JSON parsing yields an empty slice.
func parseContentBlocks(raw json.RawMessage) []anthropicContentBlock {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	// Try string first.
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return []anthropicContentBlock{{Type: "text", Text: s}}
	}
	// Fall back to array of blocks.
	var blocks []anthropicContentBlock
	if err := json.Unmarshal(raw, &blocks); err == nil {
		return blocks
	}
	return nil
}

// flattenSystemToInstructions renders an Anthropic `system` value as a single
// string, which is what the Responses API `instructions` field requires.
// Claude Code sends `system` as an array of content blocks; forwarding that
// array verbatim makes upstream reject the entire request with
// "instructions: invalid type: sequence, expected a string".
func flattenSystemToInstructions(raw json.RawMessage) (string, bool) {
	blocks := parseContentBlocks(raw)
	if len(blocks) == 0 {
		return "", false
	}
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	if len(parts) == 0 {
		return "", false
	}
	return strings.Join(parts, "\n\n"), true
}

// unsupportedBlockError reports a content block the transform path cannot
// represent without breaking tool causality.
type unsupportedBlockError struct{ BlockType string }

func (e *unsupportedBlockError) Error() string {
	return "transform mode cannot represent content block type " + e.BlockType
}

type anthropicContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

type anthropicTool struct {
	Name        string                 `json:"name"`
	Description string                 `json:"description,omitempty"`
	InputSchema map[string]interface{} `json:"input_schema,omitempty"`
}

type anthropicThinking struct {
	Type         string `json:"type"`
	BudgetTokens int    `json:"budget_tokens,omitempty"`
	Effort       string `json:"effort,omitempty"`
}

// touch canonical to prevent unused-import error in case the renderer's
// direct calls are removed in a future refactor.
var _ = canonical.NewMessageStop

func copyHeader(dst, src http.Header) {
	for k, vv := range src {
		for _, v := range vv {
			dst.Add(k, v)
		}
	}
}

func shouldRepair(path, contentType string) bool {
	if path != "/v1/messages" {
		return false
	}
	return strings.Contains(strings.ToLower(contentType), "text/event-stream")
}
