// Package repair implements a pure, network-free state machine that observes
// Anthropic SSE event types and decides which frames must be appended when an
// upstream stream ends prematurely, plus (M1) a side-channel degenerate-text
// detector that can ask the proxy to truncate a runaway stream honestly.
package repair

import (
	"encoding/json"
	"sort"
)

// Machine tracks the lifecycle of an Anthropic message stream.
//
// The machine is intentionally minimal: it watches only the SSE event type and
// the block index embedded in the data line. It never re-serializes payload
// bytes that will be relayed to the client.
type Machine struct {
	messageStartSeen bool
	messageStopSeen  bool
	openBlocks       map[int]struct{}

	detector  *Detector // nil when runaway detection is disabled
	truncated bool
}

// NewMachine creates a fresh repair state machine with no runaway detector.
func NewMachine() *Machine {
	return &Machine{openBlocks: make(map[int]struct{})}
}

// NewMachineWithDetector creates a repair state machine that also feeds
// incremental thinking/text text to a runaway detector.
func NewMachineWithDetector(cfg DetectorConfig) *Machine {
	m := NewMachine()
	m.detector = NewDetector(cfg)
	return m
}

// eventJSON is the minimal shape we need from a data line to track block
// indices. Only the "type" and "index" fields are consulted.
type eventJSON struct {
	Type  string `json:"type"`
	Index int    `json:"index"`
}

// deltaJSON is the minimal shape needed to extract incremental text from a
// content_block_delta event for the runaway detector.
type deltaJSON struct {
	Delta struct {
		Type     string `json:"type"`
		Thinking string `json:"thinking"`
		Text     string `json:"text"`
	} `json:"delta"`
}

// Observe records a single SSE event.
//
// eventType is the value of the SSE "event:" line. data is the value of the
// matching "data:" line (a JSON object). The function ignores unknown or
// malformed data. A duplicate message_start (observed in the wild from
// converters that lag one chunk behind) never resets completed state.
func (m *Machine) Observe(eventType string, data []byte) {
	switch eventType {
	case "message_start":
		if m.messageStartSeen {
			return
		}
		m.messageStartSeen = true
	case "message_stop":
		m.messageStopSeen = true
	case "content_block_start":
		if idx, ok := extractIndex(data); ok {
			m.openBlocks[idx] = struct{}{}
		}
	case "content_block_stop":
		if idx, ok := extractIndex(data); ok {
			delete(m.openBlocks, idx)
		}
	case "content_block_delta":
		if m.detector != nil && !m.truncated {
			m.truncated = m.detector.Feed(extractDeltaText(data))
		}
	}
}

// extractIndex pulls the "index" field from a data payload without failing on
// extra fields.
func extractIndex(data []byte) (int, bool) {
	var ev eventJSON
	if err := json.Unmarshal(data, &ev); err != nil {
		return 0, false
	}
	return ev.Index, true
}

// extractDeltaText pulls the incremental text (thinking or text delta) from a
// content_block_delta payload. It returns "" for signature deltas, malformed
// payloads, and any other delta without text.
func extractDeltaText(data []byte) string {
	var ev deltaJSON
	if err := json.Unmarshal(data, &ev); err != nil {
		return ""
	}
	switch ev.Delta.Type {
	case "thinking_delta":
		return ev.Delta.Thinking
	case "text_delta":
		return ev.Delta.Text
	}
	return ""
}

// Truncated reports whether the runaway detector has fired. The proxy polls
// this after every observed event and, once true, stops relaying upstream
// bytes and writes the frames returned by Truncate.
func (m *Machine) Truncated() bool {
	return m.truncated
}

// Finalize returns the frames that must be written to close out the stream
// after the upstream connection has ended (M0 semantics, unchanged).
//
// If the stream already saw message_stop or was truncated by Truncate,
// nothing is returned.
//
// If cleanEOF is false (the upstream connection errored out), a single
// Anthropic error event is returned and message_stop is intentionally omitted
// so the client does not mistake the interruption for a graceful end.
//
// If cleanEOF is true, the machine emits:
//  1. an SSE comment marking the repair,
//  2. content_block_stop for every still-open block, in ascending index order,
//  3. message_delta with stop_reason "end_turn" and no usage field,
//  4. message_stop.
//
// A clean EOF without termination events stays "end_turn": the gateway cannot
// know why the upstream stopped and does not invent a reason.
func (m *Machine) Finalize(cleanEOF bool) [][]byte {
	if m.messageStopSeen {
		return nil
	}

	if !cleanEOF {
		return [][]byte{errorFrame()}
	}

	return m.closingFrames(": repaired-by-gateway\n\n", "end_turn")
}

// Truncate returns the frames that close out a stream the gateway itself is
// cutting short because the runaway detector fired (M1 P3/P4):
//  1. an SSE comment marking the truncation,
//  2. content_block_stop for every still-open block, in ascending index order,
//  3. message_delta with stop_reason "max_tokens" and no usage field,
//  4. message_stop.
//
// stop_reason "max_tokens" is approximately honest: budget exhaustion has the
// same observable effect, and the comment carries the real reason. Calling
// Truncate marks the stream as finished; a later Finalize returns nil.
func (m *Machine) Truncate() [][]byte {
	if m.messageStopSeen {
		return nil
	}
	frames := m.closingFrames(": truncated-by-gateway: runaway-thinking\n\n", "max_tokens")
	m.messageStopSeen = true
	return frames
}

// closingFrames builds the comment + block stops + message_delta +
// message_stop sequence shared by Finalize and Truncate.
func (m *Machine) closingFrames(comment, stopReason string) [][]byte {
	var out [][]byte
	out = append(out, []byte(comment))

	if len(m.openBlocks) > 0 {
		indices := make([]int, 0, len(m.openBlocks))
		for idx := range m.openBlocks {
			indices = append(indices, idx)
		}
		sort.Ints(indices)
		for _, idx := range indices {
			out = append(out, contentBlockStopFrame(idx))
		}
	}

	out = append(out, messageDeltaFrame(stopReason))
	out = append(out, messageStopFrame())
	return out
}

func contentBlockStopFrame(index int) []byte {
	payload, _ := json.Marshal(struct {
		Type  string `json:"type"`
		Index int    `json:"index"`
	}{
		Type:  "content_block_stop",
		Index: index,
	})
	return encodeFrame("content_block_stop", payload)
}

func messageDeltaFrame(stopReason string) []byte {
	payload, _ := json.Marshal(struct {
		Type  string `json:"type"`
		Delta struct {
			StopReason string `json:"stop_reason"`
		} `json:"delta"`
	}{
		Type: "message_delta",
		Delta: struct {
			StopReason string `json:"stop_reason"`
		}{StopReason: stopReason},
	})
	return encodeFrame("message_delta", payload)
}

func messageStopFrame() []byte {
	payload, _ := json.Marshal(struct {
		Type string `json:"type"`
	}{
		Type: "message_stop",
	})
	return encodeFrame("message_stop", payload)
}

func errorFrame() []byte {
	payload, _ := json.Marshal(struct {
		Type  string `json:"type"`
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}{
		Type: "error",
		Error: struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		}{
			Type:    "api_error",
			Message: "upstream stream interrupted",
		},
	})
	return encodeFrame("error", payload)
}

func encodeFrame(eventType string, payload []byte) []byte {
	out := make([]byte, 0, len("event: \ndata: \n\n")+len(eventType)+len(payload))
	out = append(out, []byte("event: ")...)
	out = append(out, []byte(eventType)...)
	out = append(out, '\n')
	out = append(out, []byte("data: ")...)
	out = append(out, payload...)
	out = append(out, '\n', '\n')
	return out
}
