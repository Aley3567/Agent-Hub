package repair

import (
	"bytes"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func loadEvents(t *testing.T, path string) [][]byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	// Split on blank lines, keeping event/data pairs simple for tests.
	var events [][]byte
	for _, raw := range bytes.Split(data, []byte("\n\n")) {
		raw = bytes.TrimSpace(raw)
		if len(raw) == 0 {
			continue
		}
		events = append(events, raw)
	}
	return events
}

func parseEvent(t *testing.T, raw []byte) (eventType string, data []byte) {
	t.Helper()
	for _, line := range bytes.Split(raw, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if bytes.HasPrefix(line, []byte("event:")) {
			eventType = string(bytes.TrimSpace(line[len("event:"):]))
		} else if bytes.HasPrefix(line, []byte("data:")) {
			data = bytes.TrimSpace(line[len("data:"):])
		}
	}
	return eventType, data
}

func feedEvents(t *testing.T, m *Machine, events [][]byte) {
	t.Helper()
	for _, ev := range events {
		et, data := parseEvent(t, ev)
		if et != "" {
			m.Observe(et, data)
		}
	}
}

func TestGoodStreamNoRepair(t *testing.T) {
	m := NewMachine()
	feedEvents(t, m, loadEvents(t, "../../testdata/sse/opus5-thinking.sse"))
	frames := m.Finalize(true)
	if len(frames) != 0 {
		t.Fatalf("good stream produced %d repair frames, want 0", len(frames))
	}
}

func TestBadStreamRepairsThreeEvents(t *testing.T) {
	m := NewMachine()
	feedEvents(t, m, loadEvents(t, "../../testdata/sse/deepv4f-thinking.sse"))
	frames := m.Finalize(true)
	if len(frames) != 4 {
		t.Fatalf("bad stream produced %d repair frames, want 4 (comment + stop + delta + stop)", len(frames))
	}

	if !bytes.Equal(frames[0], []byte(": repaired-by-gateway\n\n")) {
		t.Errorf("frame 0 = %q, want repair comment", frames[0])
	}

	// The text block at index 1 is still open.
	stop := frames[1]
	if !bytes.HasPrefix(stop, []byte("event: content_block_stop\ndata: ")) {
		t.Fatalf("frame 1 is not content_block_stop: %q", stop)
	}
	var stopBody struct {
		Type  string `json:"type"`
		Index int    `json:"index"`
	}
	stopData := bytes.TrimPrefix(stop, []byte("event: content_block_stop\ndata: "))
	if err := json.Unmarshal(stopData, &stopBody); err != nil {
		t.Fatalf("frame 1 data invalid: %v", err)
	}
	if stopBody.Type != "content_block_stop" || stopBody.Index != 1 {
		t.Errorf("frame 1 body = %+v, want type content_block_stop index 1", stopBody)
	}

	delta := frames[2]
	if !bytes.HasPrefix(delta, []byte("event: message_delta\ndata: ")) {
		t.Fatalf("frame 2 is not message_delta: %q", delta)
	}
	deltaData := bytes.TrimPrefix(delta, []byte("event: message_delta\ndata: "))
	var deltaBody struct {
		Type  string                 `json:"type"`
		Delta map[string]interface{} `json:"delta"`
	}
	if err := json.Unmarshal(deltaData, &deltaBody); err != nil {
		t.Fatalf("frame 2 data invalid: %v", err)
	}
	if deltaBody.Type != "message_delta" {
		t.Errorf("frame 2 type = %q, want message_delta", deltaBody.Type)
	}
	if deltaBody.Delta["stop_reason"] != "end_turn" {
		t.Errorf("frame 2 stop_reason = %v, want end_turn", deltaBody.Delta["stop_reason"])
	}
	if _, hasUsage := deltaBody.Delta["usage"]; hasUsage {
		t.Errorf("frame 2 must not contain usage in delta")
	}

	end := frames[3]
	if !bytes.Equal(end, []byte("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")) {
		t.Errorf("frame 3 = %q, want message_stop", end)
	}
}

func TestUpstreamErrorDoesNotEmitMessageStop(t *testing.T) {
	m := NewMachine()
	m.Observe("message_start", []byte(`{"type":"message_start"}`))
	m.Observe("content_block_start", []byte(`{"type":"content_block_start","index":0}`))
	frames := m.Finalize(false)
	if len(frames) != 1 {
		t.Fatalf("got %d frames, want 1 error frame", len(frames))
	}
	if !bytes.HasPrefix(frames[0], []byte("event: error\n")) {
		t.Fatalf("frame is not error event: %q", frames[0])
	}
	if strings.Contains(string(frames[0]), "message_stop") {
		t.Errorf("error finalization must not contain message_stop: %q", frames[0])
	}
}

func TestMultipleOpenBlocksClosedInOrder(t *testing.T) {
	m := NewMachine()
	m.Observe("content_block_start", []byte(`{"type":"content_block_start","index":2}`))
	m.Observe("content_block_start", []byte(`{"type":"content_block_start","index":0}`))
	m.Observe("content_block_start", []byte(`{"type":"content_block_start","index":1}`))
	frames := m.Finalize(true)

	var indices []int
	for _, f := range frames {
		if !bytes.HasPrefix(f, []byte("event: content_block_stop")) {
			continue
		}
		data := bytes.TrimPrefix(f, []byte("event: content_block_stop\ndata: "))
		var body struct {
			Index int `json:"index"`
		}
		if err := json.Unmarshal(data, &body); err != nil {
			t.Fatalf("invalid stop frame: %v", err)
		}
		indices = append(indices, body.Index)
	}
	want := []int{0, 1, 2}
	if len(indices) != len(want) {
		t.Fatalf("got indices %v, want %v", indices, want)
	}
	for i := range want {
		if indices[i] != want[i] {
			t.Errorf("index %d = %d, want %d", i, indices[i], want[i])
		}
	}
}

func TestEmptyStreamEmitsMessageDeltaAndStop(t *testing.T) {
	m := NewMachine()
	frames := m.Finalize(true)
	if len(frames) != 3 {
		t.Fatalf("empty stream produced %d frames, want 3", len(frames))
	}
	if !bytes.Equal(frames[0], []byte(": repaired-by-gateway\n\n")) {
		t.Errorf("frame 0 = %q, want repair comment", frames[0])
	}
	if !bytes.HasPrefix(frames[1], []byte("event: message_delta\n")) {
		t.Errorf("frame 1 = %q, want message_delta", frames[1])
	}
	if !bytes.HasPrefix(frames[2], []byte("event: message_stop\n")) {
		t.Errorf("frame 2 = %q, want message_stop", frames[2])
	}
}

// feedEventsUntilTruncated feeds events one at a time and reports the index
// of the event on which the machine first reported truncation, or -1.
func feedEventsUntilTruncated(t *testing.T, m *Machine, events [][]byte) int {
	t.Helper()
	for i, ev := range events {
		et, data := parseEvent(t, ev)
		if et != "" {
			m.Observe(et, data)
		}
		if m.Truncated() {
			return i
		}
	}
	return -1
}

func TestRunawayGoldenBPlainLongTruncates(t *testing.T) {
	events := loadEvents(t, "../../testdata/sse/B-plain-long.sse")
	m := NewMachineWithDetector(DetectorConfig{})
	idx := feedEventsUntilTruncated(t, m, events)
	if idx < 0 {
		t.Fatal("detector never fired on B-plain-long.sse (runaway thinking, 14k chars degenerate)")
	}
	if idx >= len(events)-1 {
		t.Fatalf("detector fired only on the last event (%d/%d); want early truncation", idx, len(events))
	}

	frames := m.Truncate()
	if len(frames) != 4 {
		t.Fatalf("Truncate produced %d frames, want 4 (comment + stop + delta + stop)", len(frames))
	}
	if !bytes.Equal(frames[0], []byte(": truncated-by-gateway: runaway-thinking\n\n")) {
		t.Errorf("frame 0 = %q, want truncation comment", frames[0])
	}
	if !bytes.HasPrefix(frames[1], []byte("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}")) {
		t.Errorf("frame 1 = %q, want content_block_stop index 0", frames[1])
	}
	if !bytes.Contains(frames[2], []byte(`"stop_reason":"max_tokens"`)) {
		t.Errorf("frame 2 = %q, want stop_reason max_tokens", frames[2])
	}
	if !bytes.HasPrefix(frames[3], []byte("event: message_stop\n")) {
		t.Errorf("frame 3 = %q, want message_stop", frames[3])
	}

	// After truncation the stream is finished: Finalize must not add frames.
	if rest := m.Finalize(true); len(rest) != 0 {
		t.Fatalf("Finalize after Truncate produced %d frames, want 0", len(rest))
	}
}

func TestRunawayGoldenBLPlainNoIntervention(t *testing.T) {
	// BL-plain is degenerate thinking that ended cleanly with a complete
	// termination sequence (upstream stop_reason max_tokens). The gateway
	// must not truncate it mid-stream and Finalize must stay silent.
	events := loadEvents(t, "../../testdata/sse/BL-plain.sse")
	m := NewMachineWithDetector(DetectorConfig{})
	if idx := feedEventsUntilTruncated(t, m, events); idx >= 0 {
		t.Fatalf("detector fired on BL-plain.sse at event %d; clean-terminated streams pass through", idx)
	}
	if frames := m.Finalize(true); len(frames) != 0 {
		t.Fatalf("Finalize produced %d frames on a terminated stream, want 0", len(frames))
	}
}

func TestRunawayGoldenBLThinkNoIntervention(t *testing.T) {
	// BL-think is a healthy deepseek-v4 relay stream in the no-space "data:{...}"
	// format; the detector must stay silent.
	events := loadEvents(t, "../../testdata/sse/BL-think.sse")
	m := NewMachineWithDetector(DetectorConfig{})
	if idx := feedEventsUntilTruncated(t, m, events); idx >= 0 {
		t.Fatalf("detector fired on healthy BL-think.sse at event %d", idx)
	}
}

func TestRunawayGoldenOpus5NoIntervention(t *testing.T) {
	events := loadEvents(t, "../../testdata/sse/opus5-thinking.sse")
	m := NewMachineWithDetector(DetectorConfig{})
	if idx := feedEventsUntilTruncated(t, m, events); idx >= 0 {
		t.Fatalf("detector fired on healthy opus5-thinking.sse at event %d", idx)
	}
	if frames := m.Finalize(true); len(frames) != 0 {
		t.Fatalf("Finalize produced %d frames on a good stream, want 0", len(frames))
	}
}

func TestDuplicateMessageStartDoesNotResetState(t *testing.T) {
	// new-api repeats message_start on 1-2 chunk streams; a duplicate must
	// not reset completed state.
	m := NewMachine()
	m.Observe("message_start", []byte(`{"type":"message_start"}`))
	m.Observe("content_block_start", []byte(`{"type":"content_block_start","index":0}`))
	m.Observe("content_block_stop", []byte(`{"type":"content_block_stop","index":0}`))
	m.Observe("message_delta", []byte(`{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`))
	m.Observe("message_stop", []byte(`{"type":"message_stop"}`))
	// Duplicate message_start after a fully terminated stream.
	m.Observe("message_start", []byte(`{"type":"message_start"}`))
	if frames := m.Finalize(true); len(frames) != 0 {
		t.Fatalf("duplicate message_start resurrected a finished stream: %d frames", len(frames))
	}
}

func TestDuplicateMessageStartShortStream(t *testing.T) {
	// 1-2 chunk stream: converter repeats message_start, then EOFs without
	// termination. The block bookkeeping must survive the duplicate.
	m := NewMachine()
	m.Observe("message_start", []byte(`{"type":"message_start"}`))
	m.Observe("message_start", []byte(`{"type":"message_start"}`))
	m.Observe("content_block_start", []byte(`{"type":"content_block_start","index":0}`))
	frames := m.Finalize(true)
	if len(frames) != 4 {
		t.Fatalf("got %d frames, want 4 (comment + stop + delta + stop)", len(frames))
	}
	if !bytes.HasPrefix(frames[1], []byte("event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}")) {
		t.Errorf("frame 1 = %q, want content_block_stop index 0", frames[1])
	}
}

func TestTruncateOnEmptyStream(t *testing.T) {
	m := NewMachine()
	frames := m.Truncate()
	if len(frames) != 3 {
		t.Fatalf("Truncate on empty stream produced %d frames, want 3 (comment + delta + stop)", len(frames))
	}
	if !bytes.Contains(frames[1], []byte(`"stop_reason":"max_tokens"`)) {
		t.Errorf("frame 1 = %q, want stop_reason max_tokens", frames[1])
	}
	if rest := m.Finalize(true); len(rest) != 0 {
		t.Fatalf("Finalize after Truncate produced %d frames, want 0", len(rest))
	}
}
