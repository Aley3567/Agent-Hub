// Package policy loads the per-model policy table (M1) and rewrites request
// bodies that match a policy entry.
//
// The package is pure logic: it reads a JSON file, matches models by name,
// and applies thinking-budget rewrites. When no policy file is configured
// every lookup returns nil and the gateway behaves exactly like M0.
package policy

import (
	"encoding/json"
	"fmt"
	"os"
)

// Table is the root of the policy file.
type Table struct {
	Models map[string]*Model `json:"models"`
}

// Model is the policy for a single model name.
type Model struct {
	Thinking *Thinking `json:"thinking"`
	Runaway  *Runaway  `json:"runaway_detection"`
}

// Thinking controls thinking-budget clamping. Budget injection was removed:
// see Rewrite for why an absent thinking field is now left alone.
type Thinking struct {
	MaxBudgetTokens int `json:"max_budget_tokens"`
}

// Runaway controls degenerate-thinking detection on streaming responses.
type Runaway struct {
	Enabled bool `json:"enabled"`
	// Window is the byte sliding window for the pattern-repeat signal
	// (default 512).
	Window int `json:"window"`
	// MaxPattern is the maximum repeated-pattern length in bytes (default 64).
	MaxPattern int `json:"max_pattern"`
	// MinRepeats is the number of consecutive repeats that triggers
	// truncation (default 6).
	MinRepeats int `json:"min_repeats"`
	// DigitWindow is the rune sliding window for the digit-interleave
	// signal (default 512).
	DigitWindow int `json:"digit_window"`
	// DigitRatio is the digit fraction inside DigitWindow that triggers
	// truncation (default 0.45).
	DigitRatio float64 `json:"digit_ratio"`
}

// Load reads the policy file at path. An empty path means no policy: Load
// returns (nil, nil) and the gateway stays a pure transparent repair proxy.
func Load(path string) (*Table, error) {
	if path == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read policy file: %w", err)
	}
	var t Table
	if err := json.Unmarshal(raw, &t); err != nil {
		return nil, fmt.Errorf("parse policy file: %w", err)
	}
	return &t, nil
}

// Match returns the policy for the given model name, or nil when there is no
// table or no entry for the model.
func (t *Table) Match(model string) *Model {
	if t == nil {
		return nil
	}
	return t.Models[model]
}

// WithDefaults fills in zero-valued runaway parameters with the defaults.
func (r *Runaway) WithDefaults() Runaway {
	out := *r
	if out.Window <= 0 {
		out.Window = 512
	}
	if out.MaxPattern <= 0 {
		out.MaxPattern = 64
	}
	if out.MinRepeats <= 0 {
		out.MinRepeats = 6
	}
	if out.DigitWindow <= 0 {
		out.DigitWindow = 512
	}
	if out.DigitRatio <= 0 {
		out.DigitRatio = 0.45
	}
	return out
}

// Rewrite returns the request body with the thinking policy applied, the
// matched model policy, and whether the body was rewritten. Body bytes are
// passed through unchanged (rewritten=false) whenever the model has no
// policy entry, the policy has no thinking section, the body does not parse
// as a JSON object, or the thinking field needs no change — in those cases
// callers should forward the original body verbatim.
func Rewrite(body []byte, t *Table) (out []byte, mp *Model, rewritten bool) {
	var req map[string]json.RawMessage
	if err := json.Unmarshal(body, &req); err != nil {
		return body, nil, false
	}
	var model string
	if raw, ok := req["model"]; ok {
		if err := json.Unmarshal(raw, &model); err != nil {
			return body, nil, false
		}
	}
	m := t.Match(model)
	if m == nil || m.Thinking == nil {
		return body, m, false
	}

	th := m.Thinking
	rawThinking, hasThinking := req["thinking"]
	if !hasThinking || string(rawThinking) == "null" {
		// No thinking field: forward the body untouched. Injecting
		// thinking.budget_tokens was removed — upstream discards the value,
		// injecting it breaks request byte fidelity, and Opus 4.7/4.8,
		// Opus 5, Sonnet 5 and Fable 5 reject budget_tokens with 400.
		// reasoning.effort is the only control with an effect and it is
		// applied on the transform path (proxy.applyResponsesPolicy).
		return body, m, false
	}

	var existing struct {
		Type         string `json:"type"`
		BudgetTokens int    `json:"budget_tokens"`
	}
	if err := json.Unmarshal(rawThinking, &existing); err != nil {
		return body, m, false
	}
	if existing.Type == "disabled" {
		return body, m, false
	}
	if th.MaxBudgetTokens > 0 && existing.BudgetTokens > th.MaxBudgetTokens {
		// Patch only budget_tokens so unknown fields survive the round trip.
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(rawThinking, &obj); err != nil {
			return body, m, false
		}
		clamped, _ := json.Marshal(th.MaxBudgetTokens)
		obj["budget_tokens"] = clamped
		patch, err := json.Marshal(obj)
		if err != nil {
			return body, m, false
		}
		req["thinking"] = patch
		out, err := json.Marshal(req)
		if err != nil {
			return body, m, false
		}
		return out, m, true
	}
	return body, m, false
}
