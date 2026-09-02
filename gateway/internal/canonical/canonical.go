// Package canonical defines protocol-neutral stream events that sit between an
// upstream adapter (e.g. OpenAI Responses) and a downstream renderer (e.g.
// Anthropic SSE). Adapters convert protocol-specific wire formats into these
// events; renderers convert these events back into a wire format for the
// client. This is the contract layer of the M2 "正向转换" path.
//
// The events intentionally carry only the data needed for lifecycle and
// content delivery. They do not model every field of either the Anthropic or
// OpenAI specs — only what the renderer needs to produce a syntactically and
// semantically complete client-side stream.
package canonical

// Kind enumerates the high-level event kinds that can flow through the stream.
type Kind int

const (
	// Unknown is the zero value and should never be emitted by an adapter.
	Unknown Kind = iota
	// MessageStart opens a message stream. Exactly one per stream.
	MessageStart
	// ContentBlockStart opens a content block. Multiple per stream, each
	// with a unique index in ascending order. The Type field discriminates
	// text/thinking/tool_use/signature blocks.
	ContentBlockStart
	// ContentBlockDelta carries an incremental update for an open block.
	ContentBlockDelta
	// ContentBlockStop closes a content block. The index must match an
	// earlier ContentBlockStart.
	ContentBlockStop
	// MessageDelta updates message-level metadata, most importantly the
	// final stop_reason and usage. Zero or one per stream (emitted at the
	// end).
	MessageDelta
	// MessageStop terminates the message stream. Exactly one per stream,
	// after MessageDelta if one was emitted.
	MessageStop
	// Error signals a non-recoverable upstream or conversion error. When
	// emitted, no further events are produced.
	Error
)

// String returns a human-readable name for the kind, suitable for logging.
func (k Kind) String() string {
	switch k {
	case MessageStart:
		return "MessageStart"
	case ContentBlockStart:
		return "ContentBlockStart"
	case ContentBlockDelta:
		return "ContentBlockDelta"
	case ContentBlockStop:
		return "ContentBlockStop"
	case MessageDelta:
		return "MessageDelta"
	case MessageStop:
		return "MessageStop"
	case Error:
		return "Error"
	default:
		return "Unknown"
	}
}

// BlockType enumerates the kinds of content blocks the canonical layer can
// describe. It mirrors the subset of Anthropic block types that any current
// upstream adapter can produce.
type BlockType int

const (
	// BlockText is a regular text content block.
	BlockText BlockType = iota
	// BlockThinking is an extended-thinking block. Its deltas carry
	// incremental reasoning text. Signature deltas are a separate kind
	// (DeltaSignature) within the same block.
	BlockThinking
	// BlockToolUse is a tool call block. Its deltas carry JSON tool input.
	BlockToolUse
)

// String returns the Anthropic protocol string for a block type.
func (b BlockType) String() string {
	switch b {
	case BlockText:
		return "text"
	case BlockThinking:
		return "thinking"
	case BlockToolUse:
		return "tool_use"
	default:
		return "text"
	}
}

// DeltaKind enumerates the kinds of incremental content a ContentBlockDelta can
// carry.
type DeltaKind int

const (
	// DeltaText is a text_delta.
	DeltaText DeltaKind = iota
	// DeltaThinking is a thinking_delta.
	DeltaThinking
	// DeltaSignature is a signature_delta. It must not be forged — adapters
	// only emit this when the upstream actually sent verifiable signature
	// bytes; renderers pass them through bit-identical.
	DeltaSignature
	// DeltaToolInput is an input_json_delta for a tool_use block.
	DeltaToolInput
)

// Event is the union of all canonical stream events. Kind discriminates the
// active fields.
type Event struct {
	Kind Kind

	// MessageStart fields
	MessageID string
	Role      string

	// ContentBlockStart / ContentBlockDelta / ContentBlockStop fields
	Index     int
	BlockType BlockType
	DeltaKind DeltaKind
	// Text holds the incremental bytes for DeltaText / DeltaThinking /
	// DeltaSignature / DeltaToolInput. Adapters populate it verbatim from
	// the upstream; renderers write it bit-identical to the client.
	Text string

	// MessageDelta fields
	StopReason string
	// Usage is optional and opaque to the canonical layer; renderers pass
	// it through as JSON if non-empty.
	Usage []byte

	// Error fields
	ErrorType    string
	ErrorMessage string
}

// NewMessageStart constructs a MessageStart event.
func NewMessageStart(messageID, role string) Event {
	return Event{Kind: MessageStart, MessageID: messageID, Role: role}
}

// NewContentBlockStart constructs a ContentBlockStart event.
func NewContentBlockStart(index int, t BlockType) Event {
	return Event{Kind: ContentBlockStart, Index: index, BlockType: t}
}

// NewContentBlockDelta constructs a ContentBlockDelta event.
func NewContentBlockDelta(index int, k DeltaKind, text string) Event {
	return Event{Kind: ContentBlockDelta, Index: index, DeltaKind: k, Text: text}
}

// NewContentBlockStop constructs a ContentBlockStop event.
func NewContentBlockStop(index int) Event {
	return Event{Kind: ContentBlockStop, Index: index}
}

// NewMessageDelta constructs a MessageDelta event. stopReason may be empty when
// the upstream did not provide one. usage may be nil.
func NewMessageDelta(stopReason string, usage []byte) Event {
	return Event{Kind: MessageDelta, StopReason: stopReason, Usage: usage}
}

// NewMessageStop constructs a MessageStop event.
func NewMessageStop() Event {
	return Event{Kind: MessageStop}
}

// NewError constructs an Error event.
func NewError(errorType, message string) Event {
	return Event{Kind: Error, ErrorType: errorType, ErrorMessage: message}
}
