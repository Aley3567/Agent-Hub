// Command gateway is the M0 Anthropic→Anthropic transparent repair proxy,
// extended in M1 with a per-model policy layer (thinking guardrails and
// honest truncation), and in M2 with an optional forward-conversion path
// (Anthropic↔OpenAI Responses) that bypasses broken upstream reverse
// conversion by owning the translation locally.
//
// It listens on LISTEN_ADDR (default 127.0.0.1:3458) and forwards all /v1/*
// requests to UPSTREAM_BASE_URL (default http://127.0.0.1:9999). Streaming
// /v1/messages responses are monitored and gracefully closed if the upstream
// connection drops before emitting message_stop. When POLICY_FILE points at a
// policy JSON file, matching models additionally get thinking-budget rewrites
// on requests and runaway-thinking truncation on responses. When
// TRANSFORM_MODE=openai-responses is set, POST /v1/messages is instead
// forward-converted to OpenAI Responses and posted to
// UPSTREAM_RESPONSES_PATH (default /v1/responses).
package main

import (
	"log"
	"net/http"
	"os"

	"gateway/internal/policy"
	"gateway/internal/proxy"
)

func main() {
	listenAddr := os.Getenv("LISTEN_ADDR")
	if listenAddr == "" {
		listenAddr = "127.0.0.1:3458"
	}
	upstreamBase := os.Getenv("UPSTREAM_BASE_URL")
	if upstreamBase == "" {
		upstreamBase = "http://127.0.0.1:9999"
	}

	p := proxy.New(upstreamBase)

	policies, err := policy.Load(os.Getenv("POLICY_FILE"))
	if err != nil {
		log.Fatalf("invalid POLICY_FILE: %v", err)
	}
	if policies != nil {
		p.SetPolicies(policies)
		log.Printf("policy file loaded: %d model entries", len(policies.Models))
	}

	transformMode := os.Getenv("TRANSFORM_MODE")
	if transformMode != "" {
		p.SetTransformMode(transformMode, os.Getenv("UPSTREAM_RESPONSES_PATH"))
		log.Printf("transform mode: %s -> %s%s", transformMode, upstreamBase, defaultIfEmpty(os.Getenv("UPSTREAM_RESPONSES_PATH"), "/v1/responses"))
	}

	log.Printf("gateway listening on %s -> %s (transform=%s)", listenAddr, upstreamBase, defaultIfEmpty(transformMode, "off"))
	if err := http.ListenAndServe(listenAddr, p); err != nil {
		log.Fatalf("server exited: %v", err)
	}
}

func defaultIfEmpty(s, d string) string {
	if s == "" {
		return d
	}
	return s
}
