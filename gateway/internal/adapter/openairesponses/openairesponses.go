// Package openairesponses adapts an upstream OpenAI Responses API SSE stream
// (https://platform.openai.com/docs/api-reference/responses-streaming) into a
// sequence of canonical events.
//
// The adapter owns the protocol-level translation: it understands the upstream
// response.* event types, reconstructs message/block lifecycle, and emits
// canonical events that a downstream renderer (e.g. Anthropic SSE) consumes.
//
// The adapter does not synthesize termination events when the upstream stream
// ends early — that decision belongs to the caller (the proxy/state machine).
// The adapter's contract is: "I emit what I see; if I see response.completed
// or response.failed, I emit MessageStop / Error; if the stream just ends, I
// emit nothing further."
package openairesponses

import (
	"encoding/json"

	"gateway/internal/canonical"
)

// Adapter converts upstream OpenAI Responses SSE events into canonical events.
//
// It tracks the index of the currently-open output item so that
// response.output_item.done can close the right block. The Responses API
// serializes output items sequentially, so only one block is open at a time
// in M2's supported subset (text and reasoning blocks).
type Adapter struct {
	// messageID is captured from response.created.
	messageID string

	// openBlockIndex is the index of the currently open content block, or -1
	// when none is open. The Anthropic side requires sequential integer
	// indices; we re-map OpenAI output_item indices to canonical sequential
	// indices in the order we open them.
	openBlockIndex int

	// nextIndex is the next available canonical block index.
	nextIndex int

	// messageStarted tracks whether MessageStart was emitted (response.created
	// received). Some upstreams emit response.created multiple times (lag); we
	// only emit the first one.
	messageStarted bool
}

// New returns a fresh Adapter.
func New() *Adapter {
	return &Adapter{openBlockIndex: -1}
}

// frame is the minimal envelope shape we parse from each SSE data payload.
// The "type" field discriminates the response.* event kinds.
type frame struct {
	Type         string          `json:"type"`
	Response     *responseBody   `json:"response,omitempty"`
	Item         *outputItem     `json:"item,omitempty"`
	OutputIndex  *int            `json:"output_index,omitempty"`
	Delta        json.RawMessage `json:"delta,omitempty"`
	ResponseID   string          `json:"response_id,omitempty"`
	ItemID       string          `json:"item_id,omitempty"`
	OutputIndex2 *int            `json:"index,omitempty"` // some events use "index"
}

type responseBody struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Error  *struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

type outputItem struct {
	Type    string `json:"type"`
	Role    string `json:"role,omitempty"`
	Status  string `json:"status,omitempty"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text,omitempty"`
	} `json:"content,omitempty"`
}

// deltaEnvelope separates delta events by their type field. Both
// output_text.delta and reasoning_summary_text.delta carry the text in a
// "delta.text" sub-field, so we don't need a separate struct here; the actual
// extraction happens in extractDeltaText.
type deltaEnvelope struct {
	Type string `json:"type"`
}

// Feed parses one SSE event payload and returns zero or more canonical events.
// eventType is the upstream SSE "event:" line value (e.g.
// "response.output_text.delta"); data is the JSON payload of the "data:" line.
//
// Feed returns nil, nil for events it does not understand (forward-compatible).
func (a *Adapter) Feed(eventType string, data []byte) ([]canonical.Event, error) {
	// Many response.* events carry the whole frame envelope. Parse once.
	var f frame
	if err := json.Unmarshal(data, &f); err != nil {
		// Malformed JSON — return a translation error so the proxy can decide.
		return nil, err
	}

	switch eventType {
	case "response.created":
		if a.messageStarted {
			return nil, nil // suppress duplicate, mirror M0 behavior
		}
		a.messageStarted = true
		if f.Response != nil {
			a.messageID = f.Response.ID
		}
		return []canonical.Event{canonical.NewMessageStart(a.messageID, "assistant")}, nil

	case "response.output_item.added":
		if f.Item == nil {
			return nil, nil
		}
		return a.openItem(f.Item), nil

	case "response.output_text.delta":
		idx := a.openBlockIndex
		if idx < 0 {
			// Defensive: some upstreams omit output_item.added. Synthesize a
			// text block at index 0 so the stream stays well-formed.
			idx = a.openBlock("")
			events := []canonical.Event{canonical.NewContentBlockStart(idx, canonical.BlockText)}
			events = append(events, canonical.NewContentBlockDelta(idx, canonical.DeltaText, extractDeltaText(data)))
			return events, nil
		}
		return []canonical.Event{canonical.NewContentBlockDelta(idx, canonical.DeltaText, extractDeltaText(data))}, nil

	case "response.reasoning_text.delta", "response.reasoning_summary_text.delta":
		idx := a.openBlockIndex
		if idx < 0 {
			idx = a.openBlock("")
			events := []canonical.Event{canonical.NewContentBlockStart(idx, canonical.BlockThinking)}
			events = append(events, canonical.NewContentBlockDelta(idx, canonical.DeltaThinking, extractDeltaText(data)))
			return events, nil
		}
		return []canonical.Event{canonical.NewContentBlockDelta(idx, canonical.DeltaThinking, extractDeltaText(data))}, nil

	case "response.output_text.done", "response.reasoning_text.done", "response.reasoning_summary_text.done":
		// The block content is complete; the next event will be
		// response.output_item.done or response.content_part.done. We do
		// not close here to avoid double-closing in case upstream emits
		// both. We just no-op.
		return nil, nil

	// content_part.added / content_part.done are structural events from the
	// newer OpenAI Responses SSE spec. They bracket a content part within an
	// output item. For our purposes the part lifecycle is subsumed by the
	// output_item lifecycle (we treat each output_item as one Anthropic
	// content block), so we no-op on these.
	case "response.content_part.added", "response.content_part.done":
		return nil, nil

	// response.in_progress is a status update emitted between response.created
	// and the first output. We no-op on it — we already emitted MessageStart
	// on response.created.
	case "response.in_progress":
		return nil, nil

	case "response.output_item.done":
		if a.openBlockIndex < 0 {
			return nil, nil
		}
		idx := a.openBlockIndex
		a.openBlockIndex = -1
		return []canonical.Event{canonical.NewContentBlockStop(idx)}, nil

	case "response.completed":
		events := make([]canonical.Event, 0, 2)
		// Close any still-open block defensively (upstream should have
		// emitted output_item.done, but some don't on early completion).
		if a.openBlockIndex >= 0 {
			events = append(events, canonical.NewContentBlockStop(a.openBlockIndex))
			a.openBlockIndex = -1
		}
		stopReason := extractStopReason(data)
		usage := extractUsage(data)
		events = append(events, canonical.NewMessageDelta(stopReason, usage), canonical.NewMessageStop())
		return events, nil

	case "response.failed", "response.error", "response.incomplete":
		errType := "api_error"
		errMsg := eventType
		if f.Response != nil && f.Response.Error != nil {
			if f.Response.Error.Code != "" {
				errType = f.Response.Error.Code
			}
			if f.Response.Error.Message != "" {
				errMsg = f.Response.Error.Message
			}
		}
		return []canonical.Event{canonical.NewError(errType, errMsg)}, nil
	}

	return nil, nil
}

// openItem handles response.output_item.added: it emits a ContentBlockStart
// for the new item and tracks the open index.
//
// For reasoning items we emit a thinking block; for message items we emit a
// text block. Tool call items are not yet supported in M2 (would be a
// future adapter addition); for those we emit nothing — the proxy will
// observe a missing block start and fall through.
func (a *Adapter) openItem(item *outputItem) []canonical.Event {
	idx := a.openBlock(item.Type)
	if idx < 0 {
		return nil
	}
	switch item.Type {
	case "message":
		return []canonical.Event{canonical.NewContentBlockStart(idx, canonical.BlockText)}
	case "reasoning":
		return []canonical.Event{canonical.NewContentBlockStart(idx, canonical.BlockThinking)}
	}
	return nil
}

// openBlock opens a new canonical block index for the given upstream item type,
// returning the new index or -1 if the item type is unsupported.
func (a *Adapter) openBlock(itemType string) int {
	if itemType == "message" || itemType == "reasoning" || itemType == "" {
		idx := a.nextIndex
		a.nextIndex++
		a.openBlockIndex = idx
		return idx
	}
	return -1
}

// extractDeltaText pulls the incremental text payload from a delta event.
// The OpenAI Responses SSE spec (and agentrouter's new-api implementation)
// uses a top-level string field "delta" — not a nested object. We try the
// top-level field first; if absent we fall back to the nested shape (some
// older or non-conforming upstreams may still use {"delta":{"text":...}}).
func extractDeltaText(data []byte) string {
	// Top-level string "delta" — the spec-compliant shape.
	var topLevel struct {
		Delta string `json:"delta"`
	}
	if err := json.Unmarshal(data, &topLevel); err == nil && topLevel.Delta != "" {
		return topLevel.Delta
	}
	// Fall back: nested object {"delta":{"text":"..."}} — kept for compat with
	// any upstream that uses the older shape.
	var nested struct {
		Delta struct {
			Text string `json:"text"`
		} `json:"delta"`
	}
	if err := json.Unmarshal(data, &nested); err == nil {
		return nested.Delta.Text
	}
	return ""
}

// extractStopReason pulls the status from a response.completed payload and
// maps it to an Anthropic stop_reason. OpenAI Responses statuses:
//   - "completed" → "end_turn"
//   - "incomplete" → "max_tokens" (we treat incomplete as budget exhaustion)
//   - others → "" (renderer emits end_turn as default for unknown)
func extractStopReason(data []byte) string {
	var p struct {
		Response struct {
			Status string `json:"status"`
		} `json:"response"`
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return ""
	}
	switch p.Response.Status {
	case "completed":
		return "end_turn"
	case "incomplete":
		return "max_tokens"
	}
	return ""
}

// extractUsage pulls the usage object from a response.completed payload as
// raw JSON bytes for the renderer to forward.
func extractUsage(data []byte) []byte {
	var p struct {
		Response struct {
			Usage json.RawMessage `json:"usage"`
		} `json:"response"`
	}
	if err := json.Unmarshal(data, &p); err != nil {
		return nil
	}
	if len(p.Response.Usage) == 0 || string(p.Response.Usage) == "null" {
		return nil
	}
	return p.Response.Usage
}
