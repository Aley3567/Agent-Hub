# Changelog

[English](CHANGELOG.md) · [简体中文](CHANGELOG.zh-CN.md) · [Back to README](README.md)

Selected changes, grouped by user-visible behavior. Git remains the complete commit history. A local build below does not imply a published release.

## Unreleased

- Rework the project overview under the Agent-Hub name, with separate English and Chinese READMEs and changelogs.
- Document independent provider storage, the working source installation and the current separation between provider management and session launching.
- Simplify channel selection and launch actions in the macOS and Windows interfaces (`082bbfa`, `f1010e5`).
- Preserve actionable transport failure diagnostics (`70241aa`).

## 0.2.1 — Local macOS build · 2026-09-10

- Store providers in Hub's own database. Add providers through the TUI or CLI and explicitly import from CC Switch or JSON (`1932051`).
- Add attributed usage charts, cache coverage and paginated usage details on macOS (`ae3e677`).
- Refresh the Agent-Hub identity and prepare locally signed macOS installation kits (`ff166e6`).
- Sync Windows branding and shared table presentation improvements (`7e2175d`).

Delivery and validation were recorded in `13dabc2` and [work queue S22](docs/work-queue.md#s22--provider-独立管理与用量图表). The macOS artifacts use ad-hoc signing; no Developer ID notarization or remote release was recorded. A Windows installer was not included.
- Publish the first public preview as v0.2.1: English interface, an aligned compact theme switch, credential redaction at desktop boundaries and a double-click installer with version-manager PATH support (`c64cbbb`, `a095486`, `a755529`, `415becf`).

## 0.2.2 — macOS preview update · 2026-09-16

- Calm the visual density across the diagnostics, doctor and slots views: drop decorative accent fills, give diagnostic rows predictable grid columns and move long explanations behind disclosures (`4fb7d5b`).
- Resolve a supported Python interpreter for GUI diagnostics and repair commands so a Finder-launched app no longer mistakes Homebrew 3.11+ for the old system 3.9 (`ff3b482`).
