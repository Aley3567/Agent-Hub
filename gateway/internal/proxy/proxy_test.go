package proxy

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"gateway/internal/policy"
)

const capturesDir = "../../testdata/sse"

func TestHealthz(t *testing.T) {
	p := New("http://unused")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	p.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.String() != "ok" {
		t.Fatalf("body = %q, want ok", rec.Body.String())
	}
}

func TestProxyGoodStreamByteIdentical(t *testing.T) {
	golden, err := os.ReadFile(capturesDir + "/opus5-thinking.sse")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write(golden)
	}))
	defer upstream.Close()

	p := New(upstream.URL)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if !bytes.Equal(rec.Body.Bytes(), golden) {
		t.Fatalf("response body differs from golden file; got %d bytes, want %d bytes", rec.Body.Len(), len(golden))
	}
}

func TestProxyBadStreamRepairs(t *testing.T) {
	bad, err := os.ReadFile(capturesDir + "/deepv4f-thinking.sse")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write(bad)
	}))
	defer upstream.Close()

	p := New(upstream.URL)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}

	body := rec.Body.Bytes()
	if !bytes.HasPrefix(body, bad) {
		t.Fatalf("response does not start with original bad stream bytes")
	}
	suffix := body[len(bad):]

	// Comment.
	if !bytes.HasPrefix(suffix, []byte(": repaired-by-gateway\n\n")) {
		t.Fatalf("repair suffix does not start with comment: %q", suffix)
	}
	suffix = suffix[len(": repaired-by-gateway\n\n"):]

	// content_block_stop for index 1.
	if !bytes.HasPrefix(suffix, []byte("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n")) {
		t.Fatalf("expected content_block_stop index 1, got: %q", suffix)
	}
	suffix = suffix[len("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":1}\n\n"):]

	// message_delta.
	if !bytes.HasPrefix(suffix, []byte("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n")) {
		t.Fatalf("expected message_delta, got: %q", suffix)
	}
	suffix = suffix[len("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}\n\n"):]

	// message_stop.
	if !bytes.Equal(suffix, []byte("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")) {
		t.Fatalf("expected message_stop, got: %q", suffix)
	}
}

func TestProxyClientDisconnectCancelsUpstream(t *testing.T) {
	canceled := make(chan struct{})
	started := make(chan struct{})

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("event: ping\ndata: {}\n\n"))
		w.(http.Flusher).Flush()

		// Wait until the client has consumed the first event before blocking.
		close(started)

		select {
		case <-r.Context().Done():
			close(canceled)
		case <-time.After(5 * time.Second):
			t.Error("upstream was not canceled in time")
		}
	}))
	defer upstream.Close()

	p := New(upstream.URL)
	server := httptest.NewServer(p)
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+"/v1/messages", nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do request: %v", err)
	}

	// Wait until the upstream handler has flushed its first event.
	<-started

	// Consume the event; the proxy will then block waiting for more upstream
	// bytes until we cancel the client request.
	go func() {
		io.Copy(io.Discard, resp.Body)
	}()

	// Client disconnects.
	cancel()

	select {
	case <-canceled:
		// Expected.
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request was not canceled after client disconnect")
	}

	resp.Body.Close()
}

func TestProxyNonStreamPathNotRepaired(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	defer upstream.Close()

	p := New(upstream.URL)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/models", nil)
	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if rec.Body.String() != `{"ok":true}` {
		t.Fatalf("body = %q, want {\"ok\":true}", rec.Body.String())
	}
}

func TestProxyPreservesAuthorizationHeader(t *testing.T) {
	var gotAuth string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{}`))
	}))
	defer upstream.Close()

	p := New(upstream.URL)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	req.Header.Set("x-api-key", "x-key")
	req.Header.Set("anthropic-version", "2023-06-01")
	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if gotAuth != "Bearer secret-token" {
		t.Fatalf("Authorization = %q, want Bearer secret-token", gotAuth)
	}
	if !strings.Contains(rec.Body.String(), "{}") {
		t.Fatalf("unexpected body: %q", rec.Body.String())
	}
}

// testPolicy returns the M1 policy table used across proxy tests: thinking
// budgets for deepseek-v4f plus runaway detection.
func testPolicy() *policy.Table {
	return &policy.Table{Models: map[string]*policy.Model{
		"deepseek-v4f": {
			Thinking: &policy.Thinking{MaxBudgetTokens: 8192},
			Runaway:  &policy.Runaway{Enabled: true},
		},
	}}
}

// captureUpstream records the request body it receives and replies with a
// minimal non-streaming JSON response.
func captureUpstream(t *testing.T) (*httptest.Server, *([]byte)) {
	t.Helper()
	var got []byte
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, _ = io.ReadAll(r.Body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(upstream.Close)
	return upstream, &got
}

func TestProxyPolicyDoesNotInjectThinkingBudget(t *testing.T) {
	// The request must reach upstream without a synthesized thinking field:
	// current models reject budget_tokens with 400 and upstream discards it.
	upstream, got := captureUpstream(t)
	p := New(upstream.URL)
	p.SetPolicies(testPolicy())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"deepseek-v4f","max_tokens":1024}`))
	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(*got, &body); err != nil {
		t.Fatalf("upstream received invalid JSON: %v", err)
	}
	if _, ok := body["thinking"]; ok {
		t.Errorf("gateway injected a thinking field: %s", *got)
	}
}

func TestProxyPolicyClampsThinkingBudget(t *testing.T) {
	upstream, got := captureUpstream(t)
	p := New(upstream.URL)
	p.SetPolicies(testPolicy())

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages",
		strings.NewReader(`{"model":"deepseek-v4f","thinking":{"type":"enabled","budget_tokens":20000}}`))
	p.ServeHTTP(rec, req)

	var body struct {
		Thinking struct {
			BudgetTokens int `json:"budget_tokens"`
		} `json:"thinking"`
	}
	if err := json.Unmarshal(*got, &body); err != nil {
		t.Fatalf("upstream received invalid JSON: %v", err)
	}
	if body.Thinking.BudgetTokens != 8192 {
		t.Errorf("budget_tokens = %d, want clamped 8192", body.Thinking.BudgetTokens)
	}
}

func TestProxyPolicyDisabledThinkingUntouched(t *testing.T) {
	upstream, got := captureUpstream(t)
	p := New(upstream.URL)
	p.SetPolicies(testPolicy())

	sent := `{"model":"deepseek-v4f","thinking":{"type":"disabled"}}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(sent))
	p.ServeHTTP(rec, req)

	if string(*got) != sent {
		t.Errorf("disabled thinking body changed: %q", *got)
	}
}

func TestProxyPolicyUnmatchedModelByteIdentical(t *testing.T) {
	upstream, got := captureUpstream(t)
	p := New(upstream.URL)
	p.SetPolicies(testPolicy())

	sent := `{"model":"claude-opus-5","thinking":{"type":"enabled","budget_tokens":99999}}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", strings.NewReader(sent))
	p.ServeHTTP(rec, req)

	if string(*got) != sent {
		t.Errorf("unmatched model body changed: %q", *got)
	}
}

func TestProxyPolicyNoRewriteOnNonMessagesPath(t *testing.T) {
	upstream, got := captureUpstream(t)
	p := New(upstream.URL)
	p.SetPolicies(testPolicy())

	sent := `{"model":"deepseek-v4f"}`
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/other", strings.NewReader(sent))
	p.ServeHTTP(rec, req)

	if string(*got) != sent {
		t.Errorf("non-messages body changed: %q", *got)
	}
}

func TestProxyRunawayTruncatesBPlainLong(t *testing.T) {
	golden, err := os.ReadFile(capturesDir + "/B-plain-long.sse")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write(golden)
	}))
	defer upstream.Close()

	p := New(upstream.URL)
	p.SetPolicies(testPolicy())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := rec.Body.Bytes()

	marker := []byte(": truncated-by-gateway: runaway-thinking\n\n")
	idx := bytes.Index(body, marker)
	if idx < 0 {
		t.Fatal("response lacks the truncation marker; runaway stream was not cut")
	}
	// Everything before the marker must be a strict prefix of the golden
	// stream, and truncation must stop before the file ends.
	if idx >= len(golden) {
		t.Fatalf("relayed prefix (%d bytes) is not shorter than the golden stream (%d bytes)", idx, len(golden))
	}
	if !bytes.Equal(body[:idx], golden[:idx]) {
		t.Fatal("relayed prefix is not byte-identical to the golden stream")
	}
	suffix := body[idx:]
	if !bytes.Contains(suffix, []byte(`"stop_reason":"max_tokens"`)) {
		t.Errorf("truncation suffix lacks stop_reason max_tokens: %q", suffix)
	}
	if !bytes.Contains(suffix, []byte("event: content_block_stop")) {
		t.Errorf("truncation suffix does not close the open block: %q", suffix)
	}
	if !bytes.HasSuffix(suffix, []byte("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")) {
		t.Errorf("truncation suffix does not end with message_stop: %q", suffix)
	}
}

func TestProxyBLPlainPassthroughWithPolicy(t *testing.T) {
	// Degenerate thinking that nevertheless terminates cleanly must pass
	// through byte-identical even with runaway detection enabled.
	golden, err := os.ReadFile(capturesDir + "/BL-plain.sse")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write(golden)
	}))
	defer upstream.Close()

	p := New(upstream.URL)
	p.SetPolicies(testPolicy())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	p.ServeHTTP(rec, req)

	if !bytes.Equal(rec.Body.Bytes(), golden) {
		t.Fatalf("BL-plain stream was modified: got %d bytes, want %d", rec.Body.Len(), len(golden))
	}
}

func TestProxyBLThinkPassthroughWithPolicy(t *testing.T) {
	// BL-think uses the no-space "data:{...}" SSE format; it must scan
	// cleanly and pass through byte-identical with policies enabled.
	golden, err := os.ReadFile(capturesDir + "/BL-think.sse")
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write(golden)
	}))
	defer upstream.Close()

	p := New(upstream.URL)
	p.SetPolicies(testPolicy())
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	p.ServeHTTP(rec, req)

	if !bytes.Equal(rec.Body.Bytes(), golden) {
		t.Fatalf("BL-think stream was modified: got %d bytes, want %d", rec.Body.Len(), len(golden))
	}
}

func TestProxyRunawayCancelsUpstream(t *testing.T) {
	canceled := make(chan struct{})

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("event: message_start\ndata: {\"type\":\"message_start\"}\n\n"))
		w.Write([]byte("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0}\n\n"))
		w.(http.Flusher).Flush()

		for {
			select {
			case <-r.Context().Done():
				close(canceled)
				return
			default:
			}
			_, err := w.Write([]byte("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"ab\"}}\n\n"))
			if err != nil {
				close(canceled)
				return
			}
			w.(http.Flusher).Flush()
		}
	}))
	defer upstream.Close()

	p := New(upstream.URL)
	p.SetPolicies(testPolicy())
	server := httptest.NewServer(p)
	defer server.Close()

	resp, err := http.Post(server.URL+"/v1/messages", "application/json",
		strings.NewReader(`{"model":"deepseek-v4f"}`))
	if err != nil {
		t.Fatalf("do request: %v", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if !bytes.Contains(body, []byte(": truncated-by-gateway: runaway-thinking")) {
		t.Fatalf("response lacks truncation marker: %q", body)
	}

	select {
	case <-canceled:
		// Expected: truncation cancels the upstream request.
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request was not canceled after truncation")
	}
}

func TestProxyDuplicateMessageStartShortStream(t *testing.T) {
	// 1-2 chunk streams from new-api repeat message_start; the repair layer
	// must tolerate the duplicate and close the stream exactly once.
	stream := "event: message_start\n" +
		"data: {\"type\":\"message_start\"}\n\n" +
		"event: message_start\n" +
		"data: {\"type\":\"message_start\"}\n\n" +
		"event: content_block_start\n" +
		"data: {\"type\":\"content_block_start\",\"index\":0}\n\n"

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(stream))
	}))
	defer upstream.Close()

	p := New(upstream.URL)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", nil)
	p.ServeHTTP(rec, req)

	body := rec.Body.Bytes()
	if !bytes.HasPrefix(body, []byte(stream)) {
		t.Fatalf("response does not start with the original stream bytes: %q", body)
	}
	suffix := body[len(stream):]
	if bytes.Count(body, []byte("event: message_stop")) != 1 {
		t.Errorf("response contains %d message_stop events, want exactly 1", bytes.Count(body, []byte("event: message_stop")))
	}
	if !bytes.HasPrefix(suffix, []byte(": repaired-by-gateway\n\n")) {
		t.Errorf("repair suffix = %q, want repair comment first", suffix)
	}
	if !bytes.Contains(suffix, []byte(`{"type":"content_block_stop","index":0}`)) {
		t.Errorf("repair suffix does not close block 0: %q", suffix)
	}
}

// --- M2 path B: request conversion tests ---

func TestTransformAnthropicToResponsesBasic(t *testing.T) {
	anthropicReq := []byte(`{
		"model": "claude-haiku-4-5",
		"max_tokens": 1024,
		"stream": true,
		"system": "You are concise.",
		"messages": [
			{"role": "user", "content": [{"type": "text", "text": "Hi"}]}
		]
	}`)

	out, err := transformAnthropicToResponses(anthropicReq)
	if err != nil {
		t.Fatalf("transform returned error: %v", err)
	}

	// Verify shape: must have model, input, instructions, max_output_tokens, stream=true.
	var got map[string]json.RawMessage
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatalf("transform output is not valid JSON: %v", err)
	}
	if string(got["model"]) != `"claude-haiku-4-5"` {
		t.Errorf("model = %s, want \"claude-haiku-4-5\"", string(got["model"]))
	}
	if string(got["stream"]) != "true" {
		t.Errorf("stream = %s, want true (M2 always streams upstream)", string(got["stream"]))
	}
	if string(got["max_output_tokens"]) != "1024" {
		t.Errorf("max_output_tokens = %s, want 1024", string(got["max_output_tokens"]))
	}
	if string(got["instructions"]) != `"You are concise."` {
		t.Errorf("instructions = %s, want the system prompt verbatim", string(got["instructions"]))
	}

	// input should be a single message item with role=user and a single
	// input_text content piece.
	var input []struct {
		Type    string `json:"type"`
		Role    string `json:"role"`
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(got["input"], &input); err != nil {
		t.Fatalf("input is not a valid array: %v", err)
	}
	if len(input) != 1 {
		t.Fatalf("input has %d items, want 1", len(input))
	}
	if input[0].Type != "message" || input[0].Role != "user" {
		t.Errorf("input[0] = %+v, want type=message role=user", input[0])
	}
	if len(input[0].Content) != 1 || input[0].Content[0].Type != "input_text" || input[0].Content[0].Text != "Hi" {
		t.Errorf("input[0].Content = %+v, want one input_text with text=Hi", input[0].Content)
	}
}

func TestTransformAnthropicToResponsesPreservesThinkingEffort(t *testing.T) {
	anthropicReq := []byte(`{
		"model": "m1",
		"max_tokens": 512,
		"messages": [{"role": "user", "content": "ping"}],
		"thinking": {"type": "enabled", "effort": "low"}
	}`)
	out, err := transformAnthropicToResponses(anthropicReq)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Reasoning *struct {
			Effort string `json:"effort"`
		} `json:"reasoning"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got.Reasoning == nil || got.Reasoning.Effort != "low" {
		t.Errorf("reasoning.effort missing or wrong: %+v", got.Reasoning)
	}
}

func TestTransformAnthropicToResponsesDropsLossyBlocks(t *testing.T) {
	// Lossy-but-usable blocks (image) are dropped with a degrade log line and
	// the remaining text is preserved verbatim.
	anthropicReq := []byte(`{
		"model": "m",
		"max_tokens": 100,
		"messages": [
			{"role": "user", "content": [
				{"type": "image", "source": {"data": "..."}},
				{"type": "text", "text": "describe this"}
			]}
		]
	}`)
	out, err := transformAnthropicToResponses(anthropicReq)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Input []struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			} `json:"content"`
		} `json:"input"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Input) != 1 || len(got.Input[0].Content) != 1 {
		t.Errorf("expected 1 input item with 1 content (text only), got %+v", got.Input)
	}
	if got.Input[0].Content[0].Text != "describe this" {
		t.Errorf("text content not preserved verbatim: %+v", got.Input[0].Content[0])
	}
}

func TestTransformAnthropicToResponsesRefusesToolBlocks(t *testing.T) {
	// Tool blocks cross the causality boundary: dropping them and still
	// rendering end_turn would report a tool call as completed when it never
	// ran. The request must be refused, not degraded.
	for _, blockType := range []string{"tool_use", "tool_result"} {
		anthropicReq := []byte(`{
			"model": "m",
			"max_tokens": 100,
			"messages": [
				{"role": "user", "content": [
					{"type": "text", "text": "run it"},
					{"type": "` + blockType + `", "id": "x", "name": "bash"}
				]}
			]
		}`)
		_, err := transformAnthropicToResponses(anthropicReq)
		var unsupported *unsupportedBlockError
		if !errors.As(err, &unsupported) {
			t.Fatalf("%s: expected unsupportedBlockError, got %v", blockType, err)
		}
		if unsupported.BlockType != blockType {
			t.Errorf("%s: reported block type is %q", blockType, unsupported.BlockType)
		}
	}
}

func TestTransformAnthropicToResponsesFlattensSystemBlocksToString(t *testing.T) {
	// Claude Code sends `system` as an array of content blocks. Forwarding it
	// verbatim made upstream reject the whole request with
	// "instructions: invalid type: sequence, expected a string".
	anthropicReq := []byte(`{
		"model": "m",
		"max_tokens": 100,
		"system": [
			{"type": "text", "text": "You are Claude Code."},
			{"type": "text", "text": "Be concise."}
		],
		"messages": [{"role": "user", "content": "hi"}]
	}`)
	out, err := transformAnthropicToResponses(anthropicReq)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Instructions string `json:"instructions"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got.Instructions != "You are Claude Code.\n\nBe concise." {
		t.Errorf("instructions not flattened to a single string: %q", got.Instructions)
	}
}

func TestTransformAnthropicToResponsesKeepsStringSystem(t *testing.T) {
	anthropicReq := []byte(`{
		"model": "m",
		"max_tokens": 100,
		"system": "plain string system",
		"messages": [{"role": "user", "content": "hi"}]
	}`)
	out, err := transformAnthropicToResponses(anthropicReq)
	if err != nil {
		t.Fatal(err)
	}
	var got struct {
		Instructions string `json:"instructions"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got.Instructions != "plain string system" {
		t.Errorf("string system not preserved: %q", got.Instructions)
	}
}

func TestTransformAnthropicToResponsesMalformedJSONReturnsError(t *testing.T) {
	_, err := transformAnthropicToResponses([]byte(`{not json`))
	if err == nil {
		t.Fatal("expected error on malformed JSON")
	}
}

// --- M2 path B: end-to-end transform path test (mock upstream) ---

func TestTransformModeEndToEndProducesAnthropicSSEFromOpenAIResponsesUpstream(t *testing.T) {
	// Set up a mock upstream that returns an OpenAI Responses SSE stream.
	upstreamSSE := strings.Join([]string{
		`event: response.created`,
		`data: {"type":"response.created","response":{"id":"r_x","status":"in_progress"}}`,
		``,
		`event: response.output_item.added`,
		`data: {"type":"response.output_item.added","item":{"type":"message","id":"m","role":"assistant"}}`,
		``,
		`event: response.output_text.delta`,
		`data: {"type":"response.output_text.delta","delta":{"type":"text","text":"Hello"}}`,
		``,
		`event: response.output_item.done`,
		`data: {"type":"response.output_item.done","item":{"type":"message","id":"m","status":"done"}}`,
		``,
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"id":"r_x","status":"completed"}}`,
		``,
		``,
	}, "\n")
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The mock upstream should accept POST /v1/responses and return the
		// canned SSE stream. For any other path, 404.
		if r.Method != http.MethodPost || r.URL.Path != "/v1/responses" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(upstreamSSE))
	}))
	defer mock.Close()

	p := New(mock.URL)
	p.SetTransformMode("openai-responses", "/v1/responses")

	// Build an Anthropic /v1/messages request.
	anthropicReq := []byte(`{
		"model": "claude-haiku-4-5",
		"max_tokens": 100,
		"stream": true,
		"messages": [{"role": "user", "content": [{"type": "text", "text": "Hi"}]}]
	}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewReader(anthropicReq))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer test-key")
	rec := httptest.NewRecorder()

	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(strings.ToLower(ct), "text/event-stream") {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}

	body := rec.Body.Bytes()
	// Hard contract: full Anthropic termination trio, no error events, no
	// duplicate message_start.
	if bytes.Count(body, []byte("event: message_start")) != 1 {
		t.Errorf("message_start count = %d, want 1; body = %q", bytes.Count(body, []byte("event: message_start")), body)
	}
	if bytes.Count(body, []byte("event: message_stop")) != 1 {
		t.Errorf("message_stop count = %d, want 1", bytes.Count(body, []byte("event: message_stop")))
	}
	if bytes.Count(body, []byte("event: error")) != 0 {
		t.Errorf("error count = %d in healthy transform stream, want 0", bytes.Count(body, []byte("event: error")))
	}
	// The text delta "Hello" should appear verbatim in a text_delta frame.
	if !bytes.Contains(body, []byte(`"type":"text_delta"`)) || !bytes.Contains(body, []byte(`"text":"Hello"`)) {
		t.Errorf("text delta verbatim missing; body = %q", body)
	}
}

func TestTransformModeErrorOnNonStreamingUpstream(t *testing.T) {
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Upstream returns JSON 500 (non-SSE) — transform path must
		// convert to an Anthropic error, not silently truncate.
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"upstream is broken"}`))
	}))
	defer mock.Close()

	p := New(mock.URL)
	p.SetTransformMode("openai-responses", "/v1/responses")

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewReader([]byte(`{"model":"m","max_tokens":1,"stream":true,"messages":[{"role":"user","content":"hi"}]}`)))
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502 on non-SSE upstream", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"type":"error"`)) {
		t.Errorf("body should be Anthropic error JSON: %q", rec.Body.String())
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`upstream`)) {
		t.Errorf("body should mention upstream in message: %q", rec.Body.String())
	}
}

func TestTransformModeAbsentFallsBackToM0(t *testing.T) {
	// Without SetTransformMode, /v1/messages should go through the M0
	// transparent-relay path, not the transform path.
	mockSSE := "event: message_start\ndata: {\"type\":\"message_start\"}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	mock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The mock upstream should be hit on /v1/messages (M0 path), NOT
		// /v1/responses. If we see /v1/responses, the transform path was
		// wrongly triggered.
		if r.URL.Path != "/v1/messages" {
			t.Errorf("M0 path should hit /v1/messages upstream, got %q", r.URL.Path)
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(mockSSE))
	}))
	defer mock.Close()

	p := New(mock.URL)
	// No SetTransformMode call — defaults to "" (M0 mode).

	req := httptest.NewRequest(http.MethodPost, "/v1/messages", bytes.NewReader([]byte(`{"model":"m","max_tokens":1,"stream":true,"messages":[{"role":"user","content":"hi"}]}`)))
	rec := httptest.NewRecorder()
	p.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (M0 relay)", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte("event: message_start")) {
		t.Errorf("M0 path did not relay upstream bytes verbatim: %q", rec.Body.String())
	}
}
