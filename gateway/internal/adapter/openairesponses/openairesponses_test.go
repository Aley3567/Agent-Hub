package openairesponses

import (
	"reflect"
	"testing"

	"gateway/internal/canonical"
)

// helper: feed a sequence of (eventType, data) pairs through the adapter and
// return the flat list of canonical events produced.
func feedAll(t *testing.T, a *Adapter, events []struct {
	et string
	d  string
}) []canonical.Event {
	t.Helper()
	var out []canonical.Event
	for _, e := range events {
		got, err := a.Feed(e.et, []byte(e.d))
		if err != nil {
			t.Fatalf("Feed(%q) returned error: %v", e.et, err)
		}
		out = append(out, got...)
	}
	return out
}

func TestFeedCreatesMessageStart(t *testing.T) {
	a := New()
	got, err := a.Feed("response.created", []byte(`{"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Kind != canonical.MessageStart {
		t.Fatalf("expected 1 MessageStart event, got %+v", got)
	}
	if got[0].MessageID != "resp_1" || got[0].Role != "assistant" {
		t.Fatalf("unexpected MessageStart payload: %+v", got[0])
	}
}

func TestFeedSuppressesDuplicateMessageStart(t *testing.T) {
	a := New()
	payload := `{"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}`
	_, _ = a.Feed("response.created", []byte(payload))
	got, _ := a.Feed("response.created", []byte(payload))
	if len(got) != 0 {
		t.Fatalf("duplicate response.created should produce no event, got %+v", got)
	}
}

func TestFeedReasoningThenTextThenComplete(t *testing.T) {
	// A canonical healthy reasoning + text stream that ends cleanly.
	events := []struct {
		et string
		d  string
	}{
		{"response.created", `{"type":"response.created","response":{"id":"r1","status":"in_progress"}}`},
		{"response.output_item.added", `{"type":"response.output_item.added","item":{"type":"reasoning","id":"rs_1"}}`},
		{"response.reasoning_summary_text.delta", `{"type":"response.reasoning_summary_text.delta","delta":{"type":"text","text":"Hmm"}}`},
		{"response.reasoning_summary_text.delta", `{"type":"response.reasoning_summary_text.delta","delta":{"type":"text","text":" let me think"}}`},
		{"response.output_item.done", `{"type":"response.output_item.done","item":{"type":"reasoning","id":"rs_1","status":"done"}}`},
		{"response.output_item.added", `{"type":"response.output_item.added","item":{"type":"message","id":"msg_1","role":"assistant"}}`},
		{"response.output_text.delta", `{"type":"response.output_text.delta","delta":{"type":"text","text":"Hello"}}`},
		{"response.output_text.delta", `{"type":"response.output_text.delta","delta":{"type":"text","text":" world"}}`},
		{"response.output_item.done", `{"type":"response.output_item.done","item":{"type":"message","id":"msg_1","status":"done"}}`},
		{"response.completed", `{"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}`},
	}
	a := New()
	out := feedAll(t, a, events)

	// Expected sequence:
	//   MessageStart(r1)
	//   ContentBlockStart(0, thinking)
	//   ContentBlockDelta(0, thinking, "Hmm")
	//   ContentBlockDelta(0, thinking, " let me think")
	//   ContentBlockStop(0)
	//   ContentBlockStart(1, text)
	//   ContentBlockDelta(1, text, "Hello")
	//   ContentBlockDelta(1, text, " world")
	//   ContentBlockStop(1)
	//   MessageDelta(stop_reason=end_turn, usage)
	//   MessageStop
	wantKinds := []canonical.Kind{
		canonical.MessageStart,
		canonical.ContentBlockStart,
		canonical.ContentBlockDelta,
		canonical.ContentBlockDelta,
		canonical.ContentBlockStop,
		canonical.ContentBlockStart,
		canonical.ContentBlockDelta,
		canonical.ContentBlockDelta,
		canonical.ContentBlockStop,
		canonical.MessageDelta,
		canonical.MessageStop,
	}
	if len(out) != len(wantKinds) {
		t.Fatalf("got %d events, want %d (%+v)", len(out), len(wantKinds), out)
	}
	for i, want := range wantKinds {
		if out[i].Kind != want {
			t.Fatalf("event %d kind = %s, want %s", i, out[i].Kind, want)
		}
	}

	// Verify the message start carries the right id
	if out[0].MessageID != "r1" {
		t.Errorf("MessageStart.MessageID = %q, want r1", out[0].MessageID)
	}

	// Verify block indices
	if out[1].Index != 0 || out[1].BlockType != canonical.BlockThinking {
		t.Errorf("event 1 = %+v, want block 0 thinking", out[1])
	}
	if out[5].Index != 1 || out[5].BlockType != canonical.BlockText {
		t.Errorf("event 5 = %+v, want block 1 text", out[5])
	}

	// Verify stop reason and usage
	if out[9].StopReason != "end_turn" {
		t.Errorf("MessageDelta.StopReason = %q, want end_turn", out[9].StopReason)
	}
	if string(out[9].Usage) != `{"input_tokens":10,"output_tokens":5}` {
		t.Errorf("MessageDelta.Usage = %q, want usage json", string(out[9].Usage))
	}
}

func TestFeedHandlesEarlyStreamEndByNotSynthesizingTermination(t *testing.T) {
	// The adapter contract: if the stream ends without response.completed, it
	// does NOT emit any synthetic MessageStop. The proxy/state machine handles
	// EOF repair (M0 semantics).
	events := []struct {
		et string
		d  string
	}{
		{"response.created", `{"type":"response.created","response":{"id":"r2","status":"in_progress"}}`},
		{"response.output_item.added", `{"type":"response.output_item.added","item":{"type":"message","id":"m","role":"assistant"}}`},
		{"response.output_text.delta", `{"type":"response.output_text.delta","delta":{"type":"text","text":"partial"}}`},
		// no further events — stream just ends.
	}
	a := New()
	out := feedAll(t, a, events)

	// Should NOT include MessageStop or MessageDelta.
	for _, e := range out {
		if e.Kind == canonical.MessageStop || e.Kind == canonical.MessageDelta {
			t.Errorf("adapter synthesized termination on incomplete stream: %+v", e)
		}
	}
}

func TestFeedResponseFailedEmitsError(t *testing.T) {
	a := New()
	_, _ = a.Feed("response.created", []byte(`{"type":"response.created","response":{"id":"r3","status":"failed"}}`))
	got, err := a.Feed("response.failed", []byte(`{"type":"response.failed","response":{"id":"r3","status":"failed","error":{"code":"rate_limit_exceeded","message":"slow down"}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].Kind != canonical.Error {
		t.Fatalf("expected 1 Error event, got %+v", got)
	}
	if got[0].ErrorType != "rate_limit_exceeded" || got[0].ErrorMessage != "slow down" {
		t.Errorf("Error payload = %+v", got[0])
	}
}

func TestFeedDefensiveBlockStartWhenOutputItemAddedMissing(t *testing.T) {
	// Some upstreams (or our own relay) may drop response.output_item.added.
	// The adapter should synthesize a block start so deltas still have a
	// home.
	a := New()
	_, _ = a.Feed("response.created", []byte(`{"type":"response.created","response":{"id":"r4","status":"in_progress"}}`))
	out, err := a.Feed("response.output_text.delta", []byte(`{"type":"response.output_text.delta","delta":{"type":"text","text":"x"}}`))
	if err != nil {
		t.Fatal(err)
	}
	wantKinds := []canonical.Kind{canonical.ContentBlockStart, canonical.ContentBlockDelta}
	if len(out) != len(wantKinds) {
		t.Fatalf("got %d events %+v, want %d", len(out), out, len(wantKinds))
	}
	for i, w := range wantKinds {
		if out[i].Kind != w {
			t.Errorf("event %d kind = %s, want %s", i, out[i].Kind, w)
		}
	}
}

func TestFeedIncompleteStatusMapsToMaxTokens(t *testing.T) {
	a := New()
	_, _ = a.Feed("response.created", []byte(`{"type":"response.created","response":{"id":"r5","status":"in_progress"}}`))
	got, err := a.Feed("response.completed", []byte(`{"type":"response.completed","response":{"id":"r5","status":"incomplete"}}`))
	if err != nil {
		t.Fatal(err)
	}
	// Expect: ContentBlockStop (defensive, but no open block so none) +
	// MessageDelta(stop_reason=max_tokens) + MessageStop. Since no block was
	// opened, only MessageDelta + MessageStop should be present.
	var delta, stop *canonical.Event
	for i := range got {
		switch got[i].Kind {
		case canonical.MessageDelta:
			delta = &got[i]
		case canonical.MessageStop:
			stop = &got[i]
		}
	}
	if delta == nil || stop == nil {
		t.Fatalf("expected MessageDelta + MessageStop, got %+v", got)
	}
	if delta.StopReason != "max_tokens" {
		t.Errorf("StopReason = %q, want max_tokens", delta.StopReason)
	}
	if !reflect.DeepEqual(stop, &canonical.Event{Kind: canonical.MessageStop}) {
		// MessageStop carries no other payload fields; just sanity-check kind.
		t.Logf("MessageStop payload: %+v (ok)", stop)
	}
}

func TestFeedIgnoresUnknownEventType(t *testing.T) {
	a := New()
	got, err := a.Feed("response.something_we_dont_know", []byte(`{"type":"response.something_we_dont_know"}`))
	if err != nil {
		t.Fatal(err)
	}
	if got != nil {
		t.Fatalf("unknown event should return nil, nil; got %+v", got)
	}
}

func TestFeedMalformedJSONReturnsError(t *testing.T) {
	a := New()
	_, err := a.Feed("response.created", []byte(`{not json`))
	if err == nil {
		t.Fatal("expected error on malformed JSON")
	}
}
