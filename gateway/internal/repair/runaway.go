// runaway.go implements the degenerate-output detector (M1 P3). Two
// independent signals watch the incremental thinking/text text; either one
// fires the detector:
//
//  1. Pattern repeat (the PRD algorithm): within the last Window bytes, one
//     short pattern (at most MaxPattern bytes) repeats consecutively at
//     least MinRepeats times at the tail — a verbatim loop.
//  2. Digit interleave density: within the last DigitWindow runes, the
//     fraction of ASCII digits reaches DigitRatio — the observed
//     deepseek-v4 failure mode, where the model inserts incrementing
//     numbers between every character ("中1世2纪3…") and burns the whole
//     budget. The verbatim-repeat signal alone cannot catch it because the
//     numbers increment.
//
// Both signals err on the side of missing a degeneration rather than cutting
// off legitimate output: a miss costs nothing (the stream falls back to M0
// behavior), a false positive kills healthy content.
package repair

// DetectorConfig tunes the runaway detector. Zero values select defaults:
// byte window 512 / max pattern 64 / min repeats 6 for the pattern signal,
// rune window 512 / digit ratio 0.45 for the digit-interleave signal.
type DetectorConfig struct {
	Window      int
	MaxPattern  int
	MinRepeats  int
	DigitWindow int
	DigitRatio  float64
}

func (c DetectorConfig) withDefaults() DetectorConfig {
	if c.Window <= 0 {
		c.Window = 512
	}
	if c.MaxPattern <= 0 {
		c.MaxPattern = 64
	}
	if c.MinRepeats <= 0 {
		c.MinRepeats = 6
	}
	if c.DigitWindow <= 0 {
		c.DigitWindow = 512
	}
	if c.DigitRatio <= 0 {
		c.DigitRatio = 0.45
	}
	return c
}

// Detector watches incremental text and reports degenerate repetition.
// It is not safe for concurrent use.
type Detector struct {
	cfg DetectorConfig
	buf []byte // sliding byte window, never longer than cfg.Window

	// digit ring: one entry per rune in the sliding rune window
	// (true = ASCII digit). Never longer than cfg.DigitWindow.
	digits   []bool
	numDigit int
}

// NewDetector creates a detector with the given config.
func NewDetector(cfg DetectorConfig) *Detector {
	return &Detector{cfg: cfg.withDefaults()}
}

// Feed appends incremental text and reports whether either degeneration
// signal has fired.
func (d *Detector) Feed(text string) bool {
	// Signal 1: verbatim pattern repeat over the byte window.
	d.buf = append(d.buf, text...)
	if len(d.buf) > d.cfg.Window {
		d.buf = d.buf[len(d.buf)-d.cfg.Window:]
	}
	if repeats(d.buf, d.cfg.MaxPattern) >= d.cfg.MinRepeats {
		return true
	}

	// Signal 2: digit-interleave density over the rune window. The density
	// is only judged on a full window so that short digit-heavy fragments
	// (a constant, a date, one line of figures) never fire.
	for _, r := range text {
		isDigit := r >= '0' && r <= '9'
		d.digits = append(d.digits, isDigit)
		if isDigit {
			d.numDigit++
		}
	}
	if len(d.digits) > d.cfg.DigitWindow {
		excess := len(d.digits) - d.cfg.DigitWindow
		for _, was := range d.digits[:excess] {
			if was {
				d.numDigit--
			}
		}
		d.digits = d.digits[excess:]
	}
	if len(d.digits) == d.cfg.DigitWindow &&
		float64(d.numDigit) >= d.cfg.DigitRatio*float64(d.cfg.DigitWindow) {
		return true
	}
	return false
}

// repeats returns the largest number of consecutive copies of a short
// pattern (length at most maxPattern) found at the tail of b. A repeat count
// of 1 means the tail occurs only once.
//
// Every candidate pattern length p from 1 to maxPattern is checked: if the
// last p bytes repeat, the run is extended leftwards for as long as full
// p-sized copies line up. The best (largest) count across all p wins, so a
// stream cycling a multi-byte fragment is caught at its true period while a
// stream of one repeated byte is caught at period 1.
func repeats(b []byte, maxPattern int) int {
	best := 1
	maxP := maxPattern
	if maxP > len(b)/2 {
		maxP = len(b) / 2
	}
	for p := 1; p <= maxP; p++ {
		count := 1
		for off := len(b) - 2*p; off >= 0 && equalAt(b, off, p); off -= p {
			count++
		}
		if count > best {
			best = count
		}
	}
	return best
}

// equalAt reports whether b[off:off+p] equals the p-byte tail of b.
func equalAt(b []byte, off, p int) bool {
	tail := b[len(b)-p:]
	for i := 0; i < p; i++ {
		if b[off+i] != tail[i] {
			return false
		}
	}
	return true
}
