---
id: T-0028-make-verify-target
title: `make verify` — local CI parity target
status: ready
priority: medium
area: ci
depends_on: []
conflicts_with: []
validation:
  - V-typecheck
  - V-lint
  - V-unit
  - V-tool-registry
  - V-retrieval-floor
acceptance:
  - "Makefile gains `verify` target that runs typecheck + lint + bun test + mcp-contract.test.ts + retrieval eval"
  - "Exits 0 only if all pass; exits with the failing step's code otherwise"
  - "CONTRIBUTING.md mentions `make verify` as the pre-push check"
  - "CLAUDE.md verify-task workflow references this command"
trigger: ""
created: 2026-05-02
---

# Body

Today `bun test` covers the unit/integration cases but the contract test against a real DB and the retrieval eval are CI-only. A single `make verify` lets a developer answer "would CI pass?" without pushing — and gives the future `verify-task` skill a stable entrypoint.
