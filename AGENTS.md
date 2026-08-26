# Repository Working Agreements

## Start Here

- Read `CLAUDE.md` before changing code. It owns the protocol invariants, hard
  constraints, documentation routing, and canonical full-test command.
- Take queued work only from `docs/work-queue.md` or `docs/p0-tasks.md`. Treat
  diagnosis and evidence documents as evidence, not as a second task queue.
- Preserve unrelated worktree changes. Keep the requested change narrowly
  scoped, but interpret "minimal" as the smallest complete behavior rather
  than the fewest edited lines.

## Change Management

- Use `$change-to-commit` when the worktree mixes multiple issues or product
  lines, when a file contains unrelated hunks, or when preparing recovery
  commits. Do not equate a clean status with a correct history.
- Classify changes by observable behavior and owner module before staging.
  Stage exact paths or hunks, inspect the cached diff, and bind each commit to
  its tests and remaining runtime uncertainty.
- While work remains unclassified, do not use `git add .`, a whole-worktree
  stash, `git clean`, or reset/checkout operations that can overwrite it.
- Create one worktree per future issue or product line only after the current
  state has durable, reviewable checkpoints.

## Module Routing

- Root `claude*.py`, `codex-provider-once.py`, and their tests are the current
  Python runtime. The canonical protocol bridge remains `claude-hub.py` plus
  `claude1_protocol.py` unless the architecture decision changes explicitly.
- `crates/agent-hub/` is the Rust management plane. It may call or configure
  the Python runtime; it does not duplicate protocol semantics.
- `UI/macos/` and `UI/windows/` are independent builds with a shared contract.
  Verify and commit them independently when their implementation or proof
  differs.
- Treat `gateway/` as a separate Go experiment until its product ownership and
  support contract are decided. Do not silently make it a second canonical
  protocol implementation.
- `tools/freebuff-src/` and `tools/go-sdk/` are local external references, not
  repository modules. Repository code must not import from them.

## Issue And Bug Work

- Use the repository skill `$issue-to-proof` for non-obvious, recurring,
  cross-path, intermittent, or runtime-only failures. A deterministic failure
  with a cause already proved by an existing test may use a shorter loop.
- Translate the report into observable behavior before inferring a cause.
  Keep observed facts, supported inferences, and unresolved uncertainty
  separate throughout the work.
- Before a causal code change, reproduce the symptom or preserve the strongest
  available failing artifact, trace the narrow execution path, and run the
  cheapest probe that distinguishes the leading explanations.
- For a recurrence, identify the nearest earlier fix and explain how the new
  failure escaped it. Do not add another incident-shaped branch when one rule
  is duplicated across paths or lacks a clear owner.
- Separate the root fix from defensive fences. Every fence needs its own
  stated risk; it must not be presented as the root fix.

## Proof And Completion

- Add a regression test at the nearest truthful interface and confirm that it
  fails for the expected reason before the fix when practical. Test observable
  behavior, adjacent cases, and prohibited boundary crossings rather than
  private implementation details.
- Re-run the original symptom, focused tests, and the relevant full checks.
  Environment-dependent failures also require verification in the matching
  runtime environment; otherwise report `code complete, runtime unverified`.
- Finish with: observed facts, root cause and identifying evidence, changed
  rule and its owner, checks performed, and remaining uncertainty. Never use
  "fixed" or "verified" more broadly than the evidence supports.
- Promote guidance into this file only after a repeated or measurable failure.
  Put stable behavior in code and tests, detailed procedures in skills, and
  changing status in the work queues.
