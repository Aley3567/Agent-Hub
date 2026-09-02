package sse

import (
	"bytes"
	"testing"
)

func TestScannerSimpleEvent(t *testing.T) {
	s := NewScanner()
	input := []byte("event: ping\ndata: {}\n\n")
	var got [][]byte
	err := s.Feed(input, func(eventType, data []byte) error {
		if !bytes.Equal(eventType, []byte("ping")) {
			t.Errorf("event type = %q, want ping", eventType)
		}
		got = append(got, data)
		return nil
	})
	if err != nil {
		t.Fatalf("Feed error: %v", err)
	}
	if len(got) != 1 || !bytes.Equal(got[0], []byte("{}")) {
		t.Fatalf("got %v, want [{}]", got)
	}
}

func TestScannerMultipleEvents(t *testing.T) {
	s := NewScanner()
	input := []byte("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n")
	var types []string
	err := s.Feed(input, func(eventType, data []byte) error {
		types = append(types, string(eventType)+"="+string(data))
		return nil
	})
	if err != nil {
		t.Fatalf("Feed error: %v", err)
	}
	want := []string{"a=1", "b=2"}
	if len(types) != len(want) {
		t.Fatalf("got %v, want %v", types, want)
	}
	for i := range want {
		if types[i] != want[i] {
			t.Errorf("event %d = %q, want %q", i, types[i], want[i])
		}
	}
}

func TestScannerChunkedFeed(t *testing.T) {
	s := NewScanner()
	chunks := [][]byte{
		[]byte("event: msg\n"),
		[]byte("data: {\"a\":1}\n"),
		[]byte("\n"),
		[]byte("event: done\n"),
		[]byte("data: {}"),
		[]byte("\n\n"),
	}
	var types []string
	for _, c := range chunks {
		if err := s.Feed(c, func(eventType, data []byte) error {
			types = append(types, string(eventType))
			return nil
		}); err != nil {
			t.Fatalf("Feed error: %v", err)
		}
	}
	want := []string{"msg", "done"}
	if len(types) != len(want) {
		t.Fatalf("got %v, want %v", types, want)
	}
}

func TestScannerIgnoresComments(t *testing.T) {
	s := NewScanner()
	input := []byte(": keepalive\nevent: ping\ndata: {}\n\n")
	var got []string
	err := s.Feed(input, func(eventType, data []byte) error {
		got = append(got, string(eventType)+":"+string(data))
		return nil
	})
	if err != nil {
		t.Fatalf("Feed error: %v", err)
	}
	if len(got) != 1 || got[0] != "ping:{}" {
		t.Fatalf("got %v, want [ping:{}]", got)
	}
}

func TestScannerCRLF(t *testing.T) {
	s := NewScanner()
	input := []byte("event: ping\r\ndata: {}\r\n\r\n")
	var got []string
	err := s.Feed(input, func(eventType, data []byte) error {
		got = append(got, string(eventType)+":"+string(data))
		return nil
	})
	if err != nil {
		t.Fatalf("Feed error: %v", err)
	}
	if len(got) != 1 || got[0] != "ping:{}" {
		t.Fatalf("got %v, want [ping:{}]", got)
	}
}

func TestScannerNoSpaceDataFormat(t *testing.T) {
	// These upstream streams use "data:{...}" without a space after the colon;
	// both formats must scan identically.
	s := NewScanner()
	input := []byte("event:message_start\ndata:{\"type\":\"message_start\"}\n\nevent: content_block_delta\ndata: {\"delta\":{}}\n\n")
	var got []string
	err := s.Feed(input, func(eventType, data []byte) error {
		got = append(got, string(eventType)+"|"+string(data))
		return nil
	})
	if err != nil {
		t.Fatalf("Feed error: %v", err)
	}
	want := []string{`message_start|{"type":"message_start"}`, `content_block_delta|{"delta":{}}`}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("event %d = %q, want %q", i, got[i], want[i])
		}
	}
}
