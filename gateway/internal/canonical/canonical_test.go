package canonical

import "testing"

func TestKindString(t *testing.T) {
	cases := []struct {
		k    Kind
		want string
	}{
		{Unknown, "Unknown"},
		{MessageStart, "MessageStart"},
		{ContentBlockStart, "ContentBlockStart"},
		{ContentBlockDelta, "ContentBlockDelta"},
		{ContentBlockStop, "ContentBlockStop"},
		{MessageDelta, "MessageDelta"},
		{MessageStop, "MessageStop"},
		{Error, "Error"},
	}
	for _, c := range cases {
		if got := c.k.String(); got != c.want {
			t.Errorf("Kind(%d).String() = %q, want %q", c.k, got, c.want)
		}
	}
}

func TestBlockTypeString(t *testing.T) {
	cases := []struct {
		b    BlockType
		want string
	}{
		{BlockText, "text"},
		{BlockThinking, "thinking"},
		{BlockToolUse, "tool_use"},
	}
	for _, c := range cases {
		if got := c.b.String(); got != c.want {
			t.Errorf("BlockType(%d).String() = %q, want %q", c.b, got, c.want)
		}
	}
}

func TestConstructors(t *testing.T) {
	ms := NewMessageStart("msg_1", "assistant")
	if ms.Kind != MessageStart || ms.MessageID != "msg_1" || ms.Role != "assistant" {
		t.Fatalf("NewMessageStart = %+v", ms)
	}

	cbs := NewContentBlockStart(0, BlockText)
	if cbs.Kind != ContentBlockStart || cbs.Index != 0 || cbs.BlockType != BlockText {
		t.Fatalf("NewContentBlockStart = %+v", cbs)
	}

	cbd := NewContentBlockDelta(0, DeltaText, "hi")
	if cbd.Kind != ContentBlockDelta || cbd.Index != 0 || cbd.DeltaKind != DeltaText || cbd.Text != "hi" {
		t.Fatalf("NewContentBlockDelta = %+v", cbd)
	}

	cstop := NewContentBlockStop(0)
	if cstop.Kind != ContentBlockStop || cstop.Index != 0 {
		t.Fatalf("NewContentBlockStop = %+v", cstop)
	}

	md := NewMessageDelta("end_turn", []byte(`{"input_tokens":10}`))
	if md.Kind != MessageDelta || md.StopReason != "end_turn" || string(md.Usage) != `{"input_tokens":10}` {
		t.Fatalf("NewMessageDelta = %+v", md)
	}

	mstop := NewMessageStop()
	if mstop.Kind != MessageStop {
		t.Fatalf("NewMessageStop = %+v", mstop)
	}

	er := NewError("api_error", "boom")
	if er.Kind != Error || er.ErrorType != "api_error" || er.ErrorMessage != "boom" {
		t.Fatalf("NewError = %+v", er)
	}
}
