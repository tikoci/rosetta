---
description: "Use when a change has a user-visible effect. Records exactly one CHANGELOG.md bullet under [Unreleased]."
applyTo: "src/**, bin/**, scripts/**, .github/workflows/**, README.md, MANUAL.md, DESIGN.md, CLAUDE.md, CHANGELOG.md, tasks/**, briefings/**, BACKLOG.md, VALIDATION.md"
---
# Changelog discipline

If a change alters behavior users or operators can notice — CLI flags, MCP tool shape, DB schema, install/update flow, release/CI behavior, documented invariants — add one bullet under `CHANGELOG.md` → `[Unreleased]` in the same PR.

- Use the smallest accurate section: `Added`, `Changed`, `Fixed`, `Removed`, `Deprecated`, or `Security`.
- One bullet per behavior change. Do not log pure refactors, test churn, or CI-only auto-bumps with no external effect.
- `CHANGELOG.md` captures **what shipped**. Put rationale in `DESIGN.md` and future work in `BACKLOG.md`.
