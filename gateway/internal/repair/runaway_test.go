package repair

import (
	"strconv"
	"strings"
	"testing"
)

func TestRepeatsUnit(t *testing.T) {
	cases := []struct {
		name       string
		input      string
		maxPattern int
		want       int
	}{
		{"single char six times", "xxxxxx", 64, 6},
		{"two-char pattern thrice", "zababab", 64, 3},
		{"no repeat", "abcdef", 64, 1},
		{"trailing single occurrence", "abcab", 64, 1},
		{"single-char pattern under a tighter cap", "aaaaaaaa", 4, 8},
		{"partial extra bytes ignored", "ababababx", 64, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := repeats([]byte(tc.input), tc.maxPattern); got != tc.want {
				t.Errorf("repeats(%q, %d) = %d, want %d", tc.input, tc.maxPattern, got, tc.want)
			}
		})
	}
}

func TestDetectorFiresOnDegenerateStream(t *testing.T) {
	d := NewDetector(DetectorConfig{})
	fired := false
	// Feed "ab" one chunk at a time; the default config (W=512, P=64, K=6)
	// must fire well before the window fills.
	for i := 0; i < 20 && !fired; i++ {
		fired = d.Feed("ab")
	}
	if !fired {
		t.Fatal("detector did not fire on degenerate stream")
	}
}

func TestDetectorSilentOnNormalText(t *testing.T) {
	d := NewDetector(DetectorConfig{})
	words := []string{"The", " quick", " brown", " fox", " jumps", " over", " the", " lazy", " dog.", " Pack", " my", " box", " with", " five", " dozen", " liquor", " jugs.", " How", " vexingly", " quick", " daft", " zebras", " jump!"}
	for _, w := range words {
		if d.Feed(w) {
			t.Fatalf("detector fired on normal text at %q", w)
		}
	}
}

func TestDetectorFiresExactlyAtMinRepeats(t *testing.T) {
	d := NewDetector(DetectorConfig{Window: 100, MaxPattern: 10, MinRepeats: 4})
	if d.Feed("xyxyxy") { // 3 repeats
		t.Fatal("fired at 3 repeats, want threshold 4")
	}
	if !d.Feed("xy") { // now 4 repeats
		t.Fatal("did not fire at 4 repeats")
	}
}

func TestDetectorRespectsSlidingWindow(t *testing.T) {
	// A degenerate burst that has fully slid out of the window must not fire.
	d := NewDetector(DetectorConfig{Window: 16, MaxPattern: 4, MinRepeats: 3})
	d.Feed("abababababab")        // 6 repeats, but about to be evicted
	varied := "cd ef gh ij kl mn" // 16 bytes of varied text, evicts the burst
	if d.Feed(varied) {
		t.Fatal("detector fired after degenerate burst slid out of the window")
	}
}

func TestDetectorMultibytePattern(t *testing.T) {
	// The B-plain-long failure mode: multi-byte CJK/number fragments cycling.
	d := NewDetector(DetectorConfig{Window: 128, MaxPattern: 16, MinRepeats: 6})
	fired := false
	for i := 0; i < 10 && !fired; i++ {
		fired = d.Feed("，25")
	}
	if !fired {
		t.Fatal("detector did not fire on multi-byte degenerate pattern")
	}
}

func TestDetectorZeroConfigUsesDefaults(t *testing.T) {
	d := NewDetector(DetectorConfig{})
	if d.cfg.Window != 512 || d.cfg.MaxPattern != 64 || d.cfg.MinRepeats != 6 {
		t.Fatalf("defaults = %+v, want {512 64 6}", d.cfg)
	}
}

func TestMachineTruncatedFlagOnRunawayThinking(t *testing.T) {
	m := NewMachineWithDetector(DetectorConfig{})
	m.Observe("message_start", []byte(`{"type":"message_start"}`))
	m.Observe("content_block_start", []byte(`{"type":"content_block_start","index":0}`))
	truncated := false
	for i := 0; i < 20 && !truncated; i++ {
		m.Observe("content_block_delta", []byte(`{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"ab"}}`))
		truncated = m.Truncated()
	}
	if !truncated {
		t.Fatal("machine never reported truncation on runaway thinking")
	}
}

func TestMachineIgnoresSignatureDeltas(t *testing.T) {
	m := NewMachineWithDetector(DetectorConfig{})
	m.Observe("content_block_start", []byte(`{"type":"content_block_start","index":0}`))
	// Signature deltas carry no incremental text and must never fire the
	// detector, no matter how repetitive.
	sig := `{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"` + strings.Repeat("a", 100) + `"}}`
	for i := 0; i < 5; i++ {
		m.Observe("content_block_delta", []byte(sig))
	}
	if m.Truncated() {
		t.Fatal("signature deltas must not feed the runaway detector")
	}
}

func TestDetectorDigitInterleave(t *testing.T) {
	// The observed deepseek-v4 failure mode: incrementing numbers inserted
	// between every character. There is no verbatim repeat, so only the
	// digit-density signal can catch it.
	d := NewDetector(DetectorConfig{})
	fired := false
	for i := 0; i < 1200 && !fired; i++ {
		fired = d.Feed(string(rune('一'+i%100)) + strconv.Itoa(i))
	}
	if !fired {
		t.Fatal("detector did not fire on digit-interleaved degeneration")
	}
}

func TestDetectorDigitDensityNormalNumbersSilent(t *testing.T) {
	// Ordinary prose containing normal numbers must stay silent.
	d := NewDetector(DetectorConfig{})
	text := "In 2024 the budget was 4096 tokens, up from 2048 in 2023. " +
		"The model scored 91.5 on the benchmark, with 512 samples and 3 runs. "
	for i := 0; i < 30; i++ {
		if d.Feed(text) {
			t.Fatalf("detector fired on normal numeric prose at repeat %d", i)
		}
	}
}
