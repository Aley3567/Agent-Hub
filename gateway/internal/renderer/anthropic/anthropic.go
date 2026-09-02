// Package anthropic renders canonical stream events into Anthropic SSE
// frames suitable for a Claude Code (or any Anthropic /v1/messages) client.
//
// The renderer is the downstream half of the M2 "正向转换" path: it consumes
// canonical events produced by an upstream adapter (e.g. OpenAI Responses)
// and emits wire-format SSE bytes. Unlike the M0 repair pass, the renderer
// does not "hold back" message_stop until clean EOF — termination events are
// emitted as soon as the canonical layer produces them. The semantic
// guarantee comes from the adapter seeing response.completed, not from the
// renderer synthesizing frames after upstream EOF.
//
// Design red lines (inherited from M0/M1, see docs/PRD-M2.md):
//  1. Byte fidelity on deltas — delta text is written verbatim to the client.
//  2. No forged signatures — signature deltas are only emitted when the
//     adapter explicitly produced them. Missing signatures are not invented.
//  3. Errors stay errors — an Error event yields an Anthropic error frame,
//     not a synthetic message_stop.
//  4. Idempotent MessageStart — duplicate canonical MessageStart (which
//     should not occur but is defensive) does not re-emit message_start.
package anthropic

import (
	"encoding/json"
	"sort"

	"gateway/internal/canonical"
)

// Renderer accumulates canonical events into Anthropic SSE frames.
//
// A Renderer is single-use per stream: construct a new one for each incoming
// request. Methods are not safe for concurrent use; the proxy drives a
// Renderer sequentially from a single goroutine.
type Renderer struct {
	// messageStartEmitted guards against duplicate message_start frames.
	// Even though the canonical layer suppresses duplicates, the renderer
	// defends in depth — it never emits message_start twice on one stream.
	messageStartEmitted bool

	// messageStopEmitted is set once message_stop has been rendered. After
	// this, FinalizeFrames is a no-op (the stream already closed cleanly).
	messageStopEmitted bool

	// openBlocks tracks indices of currently-open content blocks, so that
	// if a MessageStop arrives while blocks are still open, the renderer
	// can close them defensively (a sign of upstream misbehavior, but we
	// still produce a syntactically valid client stream).
	openBlocks map[int]struct{}
}

// New returns a fresh Renderer.
func New() *Renderer {
	return &Renderer{openBlocks: make(map[int]struct{})}
}

// Render converts one canonical event into zero or more Anthropic SSE frames
// (each frame is a complete `event: <type>\ndata: <json>\n\n` byte slice).
//
// Most events produce exactly one frame. MessageStop may produce more: if
// any content blocks are still open, the renderer closes them in ascending
// index order before emitting message_delta and message_stop. Error produces
// a single error frame and never a message_stop.
func (r *Renderer) Render(e canonical.Event) [][]byte {
	switch e.Kind {
	case canonical.MessageStart:
		return r.renderMessageStart(e)
	case canonical.ContentBlockStart:
		return r.renderContentBlockStart(e)
	case canonical.ContentBlockDelta:
		return r.renderContentBlockDelta(e)
	case canonical.ContentBlockStop:
		return r.renderContentBlockStop(e)
	case canonical.MessageDelta:
		return r.renderMessageDelta(e)
	case canonical.MessageStop:
		return r.renderMessageStop()
	case canonical.Error:
		return r.renderError(e)
	}
	return nil
}

// FinalizeFrames returns the frames that must be flushed when the upstream
// connection ends without an explicit MessageStop (the M0 repair-equivalent
// path in the transform mode). The proxy calls this after the upstream EOF
// if no MessageStop was produced by the adapter.
//
// Behavior:
//   - If message_start was never emitted, emit nothing (the stream was
//     empty; client should not see a partial message).
//   - If message_stop was already emitted, return nil.
//   - Otherwise, close any open blocks, emit a comment marking the repair,
//     then message_delta{stop_reason:end_turn} + message_stop.
//     end_turn is the M0 default: we cannot know why upstream stopped, so we
//     do not invent a more specific reason. The comment carries observability.
func (r *Renderer) FinalizeFrames() [][]byte {
	if !r.messageStartEmitted || r.messageStopEmitted {
		return nil
	}
	var out [][]byte
	out = append(out, r.closeAllOpenBlocks()...)
	out = append(out, []byte(": repaired-by-transform\n\n"))
	out = append(out, messageDeltaFrame("end_turn"))
	out = append(out, messageStopFrame())
	r.messageStopEmitted = true
	return out
}

// closeAllOpenBlocks returns content_block_stop frames for every currently
// open block in ascending index order, and clears the open-blocks set.
func (r *Renderer) closeAllOpenBlocks() [][]byte {
	if len(r.openBlocks) == 0 {
		return nil
	}
	indices := make([]int, 0, len(r.openBlocks))
	for i := range r.openBlocks {
		indices = append(indices, i)
	}
	sort.Ints(indices)
	var out [][]byte
	for _, i := range indices {
		out = append(out, contentBlockStopFrame(i))
		delete(r.openBlocks, i)
	}
	return out
}

func (r *Renderer) renderMessageStart(e canonical.Event) [][]byte {
	if r.messageStartEmitted {
		return nil
	}
	r.messageStartEmitted = true
	id := e.MessageID
	if id == "" {
		id = "msg_transform"
	}
	role := e.Role
	if role == "" {
		role = "assistant"
	}
	type message struct {
		ID      string     `json:"id"`
		Type    string     `json:"type"`
		Role    string     `json:"role"`
		Content []struct{} `json:"content"`
		Usage   struct {
			InputTokens int `json:"input_tokens"`
		} `json:"usage"`
	}
	payload, _ := json.Marshal(struct {
		Type    string  `json:"type"`
		Message message `json:"message"`
	}{
		Type: "message_start",
		Message: message{
			ID:      id,
			Type:    "message",
			Role:    role,
			Content: []struct{}{},
		},
	})
	return [][]byte{encodeFrame("message_start", payload)}
}

func (r *Renderer) renderContentBlockStart(e canonical.Event) [][]byte {
	r.openBlocks[e.Index] = struct{}{}
	payload, _ := json.Marshal(struct {
		Type         string `json:"type"`
		Index        int    `json:"index"`
		ContentBlock struct {
			Type string `json:"type"`
		} `json:"content_block"`
	}{
		Type:  "content_block_start",
		Index: e.Index,
		ContentBlock: struct {
			Type string `json:"type"`
		}{Type: e.BlockType.String()},
	})
	return [][]byte{encodeFrame("content_block_start", payload)}
}

func (r *Renderer) renderContentBlockDelta(e canonical.Event) [][]byte {
	// Build the delta payload with the right field name per delta kind. The
	// JSON encoding for the wrapper is the same structurally; only the inner
	// delta object's field name changes.
	type wrapper struct {
		Type  string          `json:"type"`
		Index int             `json:"index"`
		Delta json.RawMessage `json:"delta"`
	}
	deltaJSON, err := buildDeltaJSON(e.DeltaKind, e.Text)
	if err != nil {
		return nil
	}
	payload, _ := json.Marshal(wrapper{
		Type:  "content_block_delta",
		Index: e.Index,
		Delta: deltaJSON,
	})
	return [][]byte{encodeFrame("content_block_delta", payload)}
}

// buildDeltaJSON returns the JSON bytes for a single delta object inside a
// content_block_delta frame, choosing the correct field name for each delta
// kind (text, thinking, signature, partial_json).
func buildDeltaJSON(kind canonical.DeltaKind, text string) ([]byte, error) {
	switch kind {
	case canonical.DeltaText:
		return json.Marshal(struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}{Type: "text_delta", Text: text})
	case canonical.DeltaThinking:
		return json.Marshal(struct {
			Type     string `json:"type"`
			Thinking string `json:"thinking"`
		}{Type: "thinking_delta", Thinking: text})
	case canonical.DeltaSignature:
		return json.Marshal(struct {
			Type      string `json:"type"`
			Signature string `json:"signature"`
		}{Type: "signature_delta", Signature: text})
	case canonical.DeltaToolInput:
		return json.Marshal(struct {
			Type        string `json:"type"`
			PartialJSON string `json:"partial_json"`
		}{Type: "input_json_delta", PartialJSON: text})
	}
	return nil, nil
}

func (r *Renderer) renderContentBlockStop(e canonical.Event) [][]byte {
	delete(r.openBlocks, e.Index)
	return [][]byte{contentBlockStopFrame(e.Index)}
}

func (r *Renderer) renderMessageDelta(e canonical.Event) [][]byte {
	// stop_reason defaults to end_turn when upstream didn't provide one.
	stopReason := e.StopReason
	if stopReason == "" {
		stopReason = "end_turn"
	}
	type delta struct {
		StopReason string `json:"stop_reason"`
	}
	type frame struct {
		Type  string          `json:"type"`
		Delta delta           `json:"delta"`
		Usage json.RawMessage `json:"usage,omitempty"`
	}
	f := frame{
		Type:  "message_delta",
		Delta: delta{StopReason: stopReason},
	}
	if len(e.Usage) > 0 && string(e.Usage) != "null" {
		f.Usage = json.RawMessage(e.Usage)
	}
	payload, _ := json.Marshal(f)
	return [][]byte{encodeFrame("message_delta", payload)}
}

func (r *Renderer) renderMessageStop() [][]byte {
	if r.messageStopEmitted {
		return nil
	}
	r.messageStopEmitted = true
	out := r.closeAllOpenBlocks()
	out = append(out, messageStopFrame())
	return out
}

func (r *Renderer) renderError(e canonical.Event) [][]byte {
	et := e.ErrorType
	if et == "" {
		et = "api_error"
	}
	em := e.ErrorMessage
	if em == "" {
		em = "upstream stream interrupted"
	}
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
			Type:    et,
			Message: em,
		},
	})
	return [][]byte{encodeFrame("error", payload)}
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

// encodeFrame wraps a JSON payload into a full SSE frame:
//
//	event: <eventType>\n
//	data: <payload>\n
//	\n
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
