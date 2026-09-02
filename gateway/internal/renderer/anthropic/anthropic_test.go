package anthropic

import (
	"bytes"
	"strings"
	"testing"

	"gateway/internal/adapter/openairesponses"
	"gateway/internal/canonical"
)

// feedEvents feeds a list of canonical events through the renderer and
// concatenates all output frames into a single byte slice for assertion.
func feedEvents(t *testing.T, r *Renderer, events []canonical.Event) []byte {
	t.Helper()
	var out []byte
	for _, e := range events {
		for _, frame := range r.Render(e) {
			out = append(out, frame...)
		}
	}
	return out
}

// driveAdapter runs an upstream SSE byte stream through the adapter and
// returns the concatenated canonical events it produced.
func driveAdapter(t *testing.T, upstreamSSE []byte) []canonical.Event {
	t.Helper()
	// We don't import internal/sse here to avoid an import cycle in tests;
	// the adapter just takes (eventType, data). We parse the SSE ourselves.
	// Each event is delimited by a blank line. event: line gives the type,
	// data: line gives the JSON payload.
	var events []canonical.Event
	a := openairesponses.New()
	for _, frame := range splitSSEFrames(upstreamSSE) {
		et, data := parseFrame(frame)
		got, err := a.Feed(et, data)
		if err != nil {
			t.Fatalf("adapter.Feed(%q, %q) returned error: %v", et, data, err)
		}
		events = append(events, got...)
	}
	return events
}

// splitSSEFrames splits raw SSE bytes into individual frames (each frame
// includes its event: and data: lines but no leading/trailing blank line).
func splitSSEFrames(b []byte) [][]byte {
	var out [][]byte
	for len(b) > 0 {
		// find the next blank line that terminates this frame
		idx := bytes.Index(b, []byte("\n\n"))
		if idx < 0 {
			// last frame without trailing blank line — still process it
			if len(strings.TrimSpace(string(b))) > 0 {
				out = append(out, b)
			}
			return out
		}
		out = append(out, b[:idx])
		b = b[idx+2:]
	}
	return out
}

// parseFrame extracts the event type and data payload from one frame.
func parseFrame(frame []byte) (string, []byte) {
	var eventType string
	var data []byte
	for _, line := range bytes.Split(frame, []byte("\n")) {
		line = bytes.TrimSpace(line)
		switch {
		case bytes.HasPrefix(line, []byte("event:")):
			eventType = string(bytes.TrimSpace(line[len("event:"):]))
		case bytes.HasPrefix(line, []byte("data:")):
			data = bytes.TrimSpace(line[len("data:"):])
		}
	}
	return eventType, data
}

// countEventType counts how many full SSE frames of the given event type
// appear in the rendered output.
func countEventType(output []byte, eventType string) int {
	count := 0
	for _, frame := range bytes.Split(output, []byte("\n\n")) {
		// Each frame has "event: <type>\n..."
		lines := bytes.Split(frame, []byte("\n"))
		if len(lines) == 0 {
			continue
		}
		first := bytes.TrimSpace(lines[0])
		if bytes.HasPrefix(first, []byte("event:")) {
			val := bytes.TrimSpace(first[len("event:"):])
			if string(val) == eventType {
				count++
			}
		}
	}
	return count
}

// TestEndToEndHealthyStream produces a full Anthropic message_start → ...
// → message_stop sequence when fed an OpenAI Responses-style upstream.
func TestEndToEndHealthyStream(t *testing.T) {
	upstream := []byte(strings.Join([]string{
		`event: response.created`,
		`data: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`,
		``,
		`event: response.output_item.added`,
		`data: {"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_1"}}`,
		``,
		`event: response.reasoning_summary_text.delta`,
		`data: {"type":"response.reasoning_summary_text.delta","delta":{"type":"text","text":"Let me think"}}`,
		``,
		`event: response.output_item.done`,
		`data: {"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1","status":"done"}}`,
		``,
		`event: response.output_item.added`,
		`data: {"type":"response.output_item.added","item":{"type":"message","id":"msg_1","role":"assistant"}}`,
		``,
		`event: response.output_text.delta`,
		`data: {"type":"response.output_text.delta","delta":{"type":"text","text":"Hello"}}`,
		``,
		`event: response.output_text.delta`,
		`data: {"type":"response.output_text.delta","delta":{"type":"text","text":" world"}}`,
		``,
		`event: response.output_item.done`,
		`data: {"type":"response.output_item.done","item":{"type":"message","id":"msg_1","status":"done"}}`,
		``,
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}`,
		``,
		``,
	}, "\n"))

	events := driveAdapter(t, upstream)
	r := New()
	out := feedEvents(t, r, events)

	// The hard contract assertions:
	// 1. Exactly one message_start.
	if n := countEventType(out, "message_start"); n != 1 {
		t.Errorf("message_start count = %d, want 1", n)
	}
	// 2. Exactly one message_stop, at the end.
	if n := countEventType(out, "message_stop"); n != 1 {
		t.Errorf("message_stop count = %d, want 1", n)
	}
	// 3. message_stop must be the last frame.
	if !bytes.HasSuffix(bytes.TrimSpace(out), []byte(`{"type":"message_stop"}`)) {
		t.Errorf("stream does not end with message_stop payload; tail = %q", string(out[len(out)-200:]))
	}
	// 4. No error events in a healthy stream.
	if n := countEventType(out, "error"); n != 0 {
		t.Errorf("error count = %d in healthy stream, want 0", n)
	}
	// 5. Exactly two content_block_start events (one reasoning, one text)
	//    and two content_block_stop events.
	if n := countEventType(out, "content_block_start"); n != 2 {
		t.Errorf("content_block_start count = %d, want 2", n)
	}
	if n := countEventType(out, "content_block_stop"); n != 2 {
		t.Errorf("content_block_stop count = %d, want 2", n)
	}
	// 6. message_delta present and carries stop_reason end_turn.
	if n := countEventType(out, "message_delta"); n != 1 {
		t.Errorf("message_delta count = %d, want 1", n)
	}
	if !bytes.Contains(out, []byte(`"stop_reason":"end_turn"`)) {
		t.Errorf("message_delta stop_reason end_turn missing from output")
	}
	// 7. Reasoning deltas rendered as thinking_delta, text deltas as text_delta.
	if !bytes.Contains(out, []byte(`"type":"thinking_delta"`)) {
		t.Errorf("thinking_delta missing")
	}
	if !bytes.Contains(out, []byte(`"type":"text_delta"`)) {
		t.Errorf("text_delta missing")
	}
	// 8. Byte fidelity: the exact delta strings appear verbatim.
	if !bytes.Contains(out, []byte(`"thinking":"Let me think"`)) {
		t.Errorf("thinking delta text not preserved verbatim")
	}
	if !bytes.Contains(out, []byte(`"text":"Hello"`)) || !bytes.Contains(out, []byte(`"text":" world"`)) {
		t.Errorf("text delta not preserved verbatim")
	}
}

// TestEndToEndEarlyStreamEndFallsBackToFinalize asserts the M2 fallback
// path: when the upstream stream ends without response.completed, the proxy
// calls FinalizeFrames to close out the stream with an honest end_turn.
func TestEndToEndEarlyStreamEndFallsBackToFinalize(t *testing.T) {
	upstream := []byte(strings.Join([]string{
		`event: response.created`,
		`data: {"type":"response.created","response":{"id":"resp_2","status":"in_progress"}}`,
		``,
		`event: response.output_item.added`,
		`data: {"type":"response.output_item.added","item":{"type":"message","id":"msg_2","role":"assistant"}}`,
		``,
		`event: response.output_text.delta`,
		`data: {"type":"response.output_text.delta","delta":{"type":"text","text":"partial"}}`,
		``,
		``,
	}, "\n"))

	events := driveAdapter(t, upstream)
	r := New()
	out := feedEvents(t, r, events)

	// Before finalize: stream has message_start, one content_block_start, one
	// delta — but NO message_stop yet (because the adapter never saw
	// response.completed).
	if n := countEventType(out, "message_stop"); n != 0 {
		t.Fatalf("pre-finalize message_stop count = %d, want 0", n)
	}

	// Proxy calls FinalizeFrames on upstream EOF.
	finalFrames := r.FinalizeFrames()
	if len(finalFrames) == 0 {
		t.Fatal("FinalizeFrames returned no frames on incomplete stream")
	}
	// Final frames: comment + content_block_stop + message_delta + message_stop
	out = append(out, bytes.Join(finalFrames, nil)...)

	if n := countEventType(out, "message_stop"); n != 1 {
		t.Errorf("post-finalize message_stop count = %d, want 1", n)
	}
	if n := countEventType(out, "content_block_stop"); n != 1 {
		t.Errorf("content_block_stop count = %d, want 1 (defensive close)", n)
	}
	if !bytes.Contains(out, []byte(`: repaired-by-transform`)) {
		t.Errorf("repair comment missing from finalize output")
	}
	if !bytes.Contains(out, []byte(`"stop_reason":"end_turn"`)) {
		t.Errorf("finalize message_delta stop_reason end_turn missing")
	}
	// Finalize again should be a no-op (idempotent).
	if len(r.FinalizeFrames()) != 0 {
		t.Errorf("FinalizeFrames is not idempotent after first finalize")
	}
}

// TestEndToEndErrorEventDoesNotSynthesizeStop asserts that an upstream
// response.failed produces an Anthropic error frame, NOT a message_stop.
func TestEndToEndErrorEventDoesNotSynthesizeStop(t *testing.T) {
	upstream := []byte(strings.Join([]string{
		`event: response.created`,
		`data: {"type":"response.created","response":{"id":"resp_3","status":"in_progress"}}`,
		``,
		`event: response.failed`,
		`data: {"type":"response.failed","response":{"id":"resp_3","status":"failed","error":{"code":"rate_limit_exceeded","message":"slow down"}}}`,
		``,
		``,
	}, "\n"))

	events := driveAdapter(t, upstream)
	r := New()
	out := feedEvents(t, r, events)

	if n := countEventType(out, "error"); n != 1 {
		t.Errorf("error count = %d, want 1", n)
	}
	if n := countEventType(out, "message_stop"); n != 0 {
		t.Errorf("message_stop count = %d on upstream failure, want 0 (error must not be disguised)", n)
	}
	if !bytes.Contains(out, []byte(`"type":"rate_limit_exceeded"`)) {
		t.Errorf("error type field missing or wrong")
	}
	if !bytes.Contains(out, []byte(`"message":"slow down"`)) {
		t.Errorf("error message field missing or wrong")
	}
}

// TestEndToEndDuplicateMessageStartIsSuppressed mirrors the M0 red line:
// if somehow a duplicate message_start reaches the renderer, only one is
// emitted.
func TestEndToEndDuplicateMessageStartIsSuppressed(t *testing.T) {
	r := New()
	out := feedEvents(t, r, []canonical.Event{
		canonical.NewMessageStart("id1", "assistant"),
		canonical.NewMessageStart("id2", "assistant"),
	})
	if n := countEventType(out, "message_start"); n != 1 {
		t.Errorf("message_start count = %d on duplicate, want 1 (suppressed)", n)
	}
}

// TestEndToEndVeryShortStreamNoDuplicateMessageStart covers the 1-2 chunk
// path that exposed new-api's OaiStreamHandler lag bug. Our renderer must
// not double-emit message_start under any input shape.
func TestEndToEndVeryShortStreamNoDuplicateMessageStart(t *testing.T) {
	upstream := []byte(strings.Join([]string{
		`event: response.created`,
		`data: {"type":"response.created","response":{"id":"resp_short","status":"in_progress"}}`,
		``,
		`event: response.completed`,
		`data: {"type":"response.completed","response":{"id":"resp_short","status":"completed"}}`,
		``,
		``,
	}, "\n"))
	events := driveAdapter(t, upstream)
	r := New()
	out := feedEvents(t, r, events)
	if n := countEventType(out, "message_start"); n != 1 {
		t.Errorf("message_start count = %d on very short stream, want 1", n)
	}
	if n := countEventType(out, "message_stop"); n != 1 {
		t.Errorf("message_stop count = %d on very short stream, want 1", n)
	}
}

// TestEndToEndMessageStopClosesOpenBlocks asserts the defensive path: if
// MessageStop arrives while a content_block is still open (adapter bug or
// upstream misbehavior), the renderer closes it before emitting message_stop.
func TestEndToEndMessageStopClosesOpenBlocks(t *testing.T) {
	r := New()
	out := feedEvents(t, r, []canonical.Event{
		canonical.NewMessageStart("m", "assistant"),
		canonical.NewContentBlockStart(0, canonical.BlockText),
		canonical.NewContentBlockDelta(0, canonical.DeltaText, "hi"),
		// NOTE: no ContentBlockStop(0) — left open on purpose.
		canonical.NewMessageStop(),
	})
	if n := countEventType(out, "content_block_stop"); n != 1 {
		t.Errorf("content_block_stop count = %d on open-block path, want 1 (defensive close)", n)
	}
	if n := countEventType(out, "message_stop"); n != 1 {
		t.Errorf("message_stop count = %d, want 1", n)
	}
}

// TestEndToEndEmptyStreamFinalizeIsNoOp asserts that a stream that never saw
// message_start produces no frames on finalize (no empty message emitted to
// the client).
func TestEndToEndEmptyStreamFinalizeIsNoOp(t *testing.T) {
	r := New()
	if frames := r.FinalizeFrames(); len(frames) != 0 {
		t.Errorf("FinalizeFrames on empty stream returned %d frames, want 0", len(frames))
	}
}
