// Package sse provides read-only Server-Sent Events framing helpers.
// It splits raw upstream bytes into complete SSE event frames and extracts
// the event type and data payload without re-serializing anything.
package sse

import (
	"bytes"
)

// Scanner buffers a stream of SSE bytes and emits complete events.
// It is not safe for concurrent use.
type Scanner struct {
	buf []byte
}

// NewScanner creates an empty SSE scanner.
func NewScanner() *Scanner {
	return &Scanner{}
}

// Feed appends p to the internal buffer and invokes onEvent for every
// complete event that becomes available. Trailing partial events are kept
// for the next Feed call.
func (s *Scanner) Feed(p []byte, onEvent func(eventType, data []byte) error) error {
	s.buf = append(s.buf, p...)
	for {
		boundary := findEventBoundary(s.buf)
		if boundary < 0 {
			return nil
		}
		frame := s.buf[:boundary]
		eventType, data := parseFrame(frame)
		if err := onEvent(eventType, data); err != nil {
			return err
		}
		s.buf = s.buf[boundary:]
	}
}

// findEventBoundary returns the byte index just past the first blank line
// in b, or -1 if no complete event has been received yet.
//
// SSE events are separated by blank lines. A blank line is an empty line
// terminated by \n, \r\n, or \r. Leading blank lines are skipped so they do
// not terminate an empty event.
func findEventBoundary(b []byte) int {
	start := 0

	// Skip leading blank lines.
	for start < len(b) {
		lineEnd, termLen := lineTerminator(b[start:])
		if lineEnd < 0 {
			return -1
		}
		if !isEmptyLine(b[start : start+lineEnd]) {
			break
		}
		start += lineEnd + termLen
	}

	// Search for the next blank line, which terminates the current event.
	for start < len(b) {
		lineEnd, termLen := lineTerminator(b[start:])
		if lineEnd < 0 {
			return -1
		}
		if isEmptyLine(b[start : start+lineEnd]) {
			return start + lineEnd + termLen
		}
		start += lineEnd + termLen
	}
	return -1
}

// lineTerminator returns the offset and length of the first line terminator
// in b. It returns (-1, 0) when no terminator is present.
func lineTerminator(b []byte) (int, int) {
	for i := 0; i < len(b); i++ {
		switch b[i] {
		case '\n':
			return i, 1
		case '\r':
			if i+1 < len(b) && b[i+1] == '\n' {
				return i, 2
			}
			return i, 1
		}
	}
	return -1, 0
}

// isEmptyLine reports whether a line (without its terminator) is empty.
func isEmptyLine(line []byte) bool {
	return len(line) == 0 || (len(line) == 1 && line[0] == '\r')
}

// parseFrame extracts the event type and data payload from a single SSE frame.
// Comments and unknown fields are ignored.
func parseFrame(frame []byte) (eventType, data []byte) {
	for len(frame) > 0 {
		lineEnd, termLen := lineTerminator(frame)
		if lineEnd < 0 {
			lineEnd = len(frame)
			termLen = 0
		}
		line := frame[:lineEnd]
		// Strip trailing \r if terminator was \r\n and we are using the line
		// without terminator.
		if termLen == 2 && len(line) > 0 && line[len(line)-1] == '\r' {
			line = line[:len(line)-1]
		}

		switch {
		case bytes.HasPrefix(line, []byte("event:")):
			eventType = bytes.TrimSpace(line[len("event:"):])
		case bytes.HasPrefix(line, []byte("data:")):
			data = bytes.TrimSpace(line[len("data:"):])
		}

		frame = frame[lineEnd+termLen:]
	}
	return eventType, data
}
