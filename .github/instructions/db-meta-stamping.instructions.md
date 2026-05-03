---
description: "Released databases carry db_meta provenance stamped in CI and surfaced by runtime entrypoints."
applyTo: "scripts/stamp-db-meta.ts, src/mcp.ts, src/setup.ts, .github/workflows/release.yml, MANUAL.md, DESIGN.md, VALIDATION.md"
---
# `db_meta` stamping

Released DBs must carry provenance keys such as `release_tag`, `built_at`, `source_commit`, and `schema_version`.

- Stamping happens in CI via `scripts/stamp-db-meta.ts`.
- Runtime entrypoints and docs should describe `db_meta` as release provenance, not optional trivia.
- If the key set or consumer behavior changes, update the workflow, the runtime readers, and the docs together.
