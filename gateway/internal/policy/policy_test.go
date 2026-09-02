package policy

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func testTableFile(t *testing.T) string {
	t.Helper()
	content := `{
		"models": {
			"deepseek-v4f": {
				"thinking": {"inject_budget_tokens": 4096, "max_budget_tokens": 8192},
				"runaway_detection": {"enabled": true}
			},
			"no-thinking-model": {
				"runaway_detection": {"enabled": true, "window": 256, "max_pattern": 32, "min_repeats": 4}
			}
		}
	}`
	path := filepath.Join(t.TempDir(), "policy.json")
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("write policy file: %v", err)
	}
	return path
}

func TestLoadEmptyPathMeansNoPolicy(t *testing.T) {
	tbl, err := Load("")
	if err != nil {
		t.Fatalf("Load(\"\") error: %v", err)
	}
	if tbl != nil {
		t.Fatalf("Load(\"\") = %v, want nil", tbl)
	}
}

func TestLoadMissingFileFails(t *testing.T) {
	if _, err := Load(filepath.Join(t.TempDir(), "does-not-exist.json")); err == nil {
		t.Fatal("Load on missing file must fail")
	}
}

func TestLoadInvalidJSONFails(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("Load on invalid JSON must fail")
	}
}

func TestMatch(t *testing.T) {
	tbl, err := Load(testTableFile(t))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	m := tbl.Match("deepseek-v4f")
	if m == nil || m.Thinking == nil {
		t.Fatalf("Match(deepseek-v4f) = %+v, want thinking policy", m)
	}
	if m.Thinking.MaxBudgetTokens != 8192 {
		t.Errorf("thinking = %+v, want inject 4096 max 8192", m.Thinking)
	}
	if m.Runaway == nil || !m.Runaway.Enabled {
		t.Errorf("runaway = %+v, want enabled", m.Runaway)
	}
	if got := tbl.Match("unknown-model"); got != nil {
		t.Errorf("Match(unknown-model) = %+v, want nil", got)
	}
	var nilTable *Table
	if got := nilTable.Match("deepseek-v4f"); got != nil {
		t.Errorf("nil table Match = %+v, want nil", got)
	}
}

func TestRunawayWithDefaults(t *testing.T) {
	r := (&Runaway{Enabled: true}).WithDefaults()
	if r.Window != 512 || r.MaxPattern != 64 || r.MinRepeats != 6 || r.DigitWindow != 512 || r.DigitRatio != 0.45 {
		t.Errorf("defaults = %+v, want {512 64 6 512 0.45}", r)
	}
	custom := (&Runaway{Enabled: true, Window: 256, MaxPattern: 32, MinRepeats: 4, DigitWindow: 128, DigitRatio: 0.5}).WithDefaults()
	if custom.Window != 256 || custom.MaxPattern != 32 || custom.MinRepeats != 4 || custom.DigitWindow != 128 || custom.DigitRatio != 0.5 {
		t.Errorf("custom = %+v, want values preserved", custom)
	}
}

func loadTestTable(t *testing.T) *Table {
	t.Helper()
	tbl, err := Load(testTableFile(t))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	return tbl
}

func TestRewriteLeavesAbsentThinkingAlone(t *testing.T) {
	// Budget injection was removed: a request with no thinking field must be
	// forwarded byte-for-byte, even when the model has a thinking policy.
	tbl := loadTestTable(t)
	body := []byte(`{"model":"deepseek-v4f","max_tokens":1024,"messages":[]}`)
	out, m, rewritten := Rewrite(body, tbl)
	if rewritten {
		t.Error("Rewrite modified a request that carried no thinking field")
	}
	if m == nil {
		t.Fatal("Rewrite returned nil model policy")
	}
	if string(out) != string(body) {
		t.Errorf("body not forwarded verbatim:\n got %s\nwant %s", out, body)
	}
}

func TestRewriteClampsBudget(t *testing.T) {
	tbl := loadTestTable(t)
	body := []byte(`{"model":"deepseek-v4f","thinking":{"type":"enabled","budget_tokens":20000}}`)
	out, _, rewritten := Rewrite(body, tbl)
	if !rewritten {
		t.Fatal("Rewrite did not clamp oversized budget")
	}
	var req struct {
		Thinking struct {
			Type         string `json:"type"`
			BudgetTokens int    `json:"budget_tokens"`
		} `json:"thinking"`
	}
	if err := json.Unmarshal(out, &req); err != nil {
		t.Fatalf("rewritten body invalid: %v", err)
	}
	if req.Thinking.BudgetTokens != 8192 {
		t.Errorf("budget_tokens = %d, want clamped to 8192", req.Thinking.BudgetTokens)
	}
}

func TestRewriteDisabledUntouched(t *testing.T) {
	tbl := loadTestTable(t)
	body := []byte(`{"model":"deepseek-v4f","thinking":{"type":"disabled"}}`)
	out, _, rewritten := Rewrite(body, tbl)
	if rewritten {
		t.Fatal("Rewrite touched a disabled thinking field")
	}
	if !bytes.Equal(out, body) {
		t.Errorf("body changed: %q", out)
	}
}

func TestRewriteSmallBudgetUntouched(t *testing.T) {
	tbl := loadTestTable(t)
	body := []byte(`{"model":"deepseek-v4f","thinking":{"type":"enabled","budget_tokens":512}}`)
	out, _, rewritten := Rewrite(body, tbl)
	if rewritten {
		t.Fatal("Rewrite touched a budget within limits")
	}
	if !bytes.Equal(out, body) {
		t.Errorf("body changed: %q", out)
	}
}

func TestRewriteUnmatchedModelPassthrough(t *testing.T) {
	tbl := loadTestTable(t)
	body := []byte(`{"model":"some-other-model","max_tokens":1}`)
	out, m, rewritten := Rewrite(body, tbl)
	if rewritten || m != nil {
		t.Fatalf("Rewrite on unmatched model: rewritten=%v policy=%+v", rewritten, m)
	}
	if !bytes.Equal(out, body) {
		t.Errorf("body changed: %q", out)
	}
}

func TestRewriteModelMatchedButNoThinkingSection(t *testing.T) {
	tbl := loadTestTable(t)
	body := []byte(`{"model":"no-thinking-model"}`)
	out, m, rewritten := Rewrite(body, tbl)
	if rewritten {
		t.Fatal("Rewrite rewrote a model with no thinking policy")
	}
	if m == nil {
		t.Fatal("Rewrite must still return the matched policy (runaway applies)")
	}
	if !bytes.Equal(out, body) {
		t.Errorf("body changed: %q", out)
	}
}

func TestRewriteMalformedBodyPassthrough(t *testing.T) {
	tbl := loadTestTable(t)
	body := []byte(`this is not json`)
	out, m, rewritten := Rewrite(body, tbl)
	if rewritten || m != nil {
		t.Fatalf("Rewrite on malformed body: rewritten=%v policy=%+v", rewritten, m)
	}
	if !bytes.Equal(out, body) {
		t.Errorf("body changed: %q", out)
	}
}

func TestRewriteNilTablePassthrough(t *testing.T) {
	body := []byte(`{"model":"deepseek-v4f"}`)
	out, m, rewritten := Rewrite(body, nil)
	if rewritten || m != nil {
		t.Fatalf("Rewrite with nil table: rewritten=%v policy=%+v", rewritten, m)
	}
	if !bytes.Equal(out, body) {
		t.Errorf("body changed: %q", out)
	}
}
