---
description: "In a checkout, the resolved ros-help.db is untrusted until verified; the latest CI release DB is the grounding source of truth."
applyTo: "src/paths.ts, src/setup.ts, src/mcp.ts, scripts/db-doctor.ts, Makefile, MANUAL.md, VALIDATION.md"
---
# Local DB grounding

Dev mode (`resolveDbPath` → project root) serves the repo-root `ros-help.db` — a
git-ignored file whose contents are arbitrary local state. **It is not trusted by
default.** Before grounding any claim about shipped data on it, verify it.

## The rule

- **The latest CI-built release DB is the source of truth for grounding claims.**
  It is what `bunx @tikoci/rosetta` consumers actually get. `make db-sync`
  (`scripts/db-sync.ts`) fetches it into the resolved path (atomic replace — safe
  while an MCP server holds the old file open).
  - It does **not** use `--refresh`: that pins the URL to `package.json`'s
    version, which in a checkout is a CI-rewritten placeholder (`v0.11.0-rc.0`)
    with no release, and falls back to `/releases/latest` — the newest *stable*,
    which lags the prerelease schema. `db-sync` instead uses `gh` to find the
    newest release (prereleases **included**) that actually ships
    `ros-help.db.gz`, then reuses the hardened `downloadDb()` (schema/content
    validation + stale-sidecar cleanup + atomic swap) via its `urlsOverride`
    param. Requires the `gh` CLI. Keep it this way.
- **`make extract` produces an *unstamped* local working DB** — for extraction
  and pipeline work, not for claims about shipped data. `db-doctor` reports it as
  `unstamped`; that is expected, not a failure to "fix" by re-extracting.
- **Verify before trusting.** `make db-doctor` (or `bun run db:doctor`) prints the
  resolved path + `db_meta` provenance + a grounding verdict and exits non-zero
  when not `ok`. In-session, one `routeros_stats` call returns the same
  `provenance.grounding` block — prefer it over shelling into sqlite.

## The verdict (`classifyDbGrounding`, `src/paths.ts`)

Pure function, shared by `routeros_stats` (`getDbStats`), MCP startup, and
`db-doctor`. Status precedence:

| status | meaning | typical fix |
|---|---|---|
| `schema_mismatch` | `PRAGMA user_version` ≠ code `SCHEMA_VERSION` | `make db-sync` |
| `internal_inconsistent` | `db_meta.schema_version` ≠ pragma — a corpus bumped in place by `initDb()`; provenance no longer describes the bytes (the #94 "Frankenstein") | `make db-sync` |
| `unstamped` | neither `release_tag` nor `source_commit` — a local `make extract` build | fine for extraction; `make db-sync` to ground |
| `provenance_incomplete` | claims release identity but is missing one of the four CI stamps (`release_tag`/`source_commit`/`built_at`/`schema_version`), or a stamped version that won't parse — fail closed | `make db-sync` |
| `tag_behind` | `release_tag` base version behind the checkout | `make db-sync` |
| `ok` | all four stamps present, schema coherent, tag current | — |

`ok` means the DB is **schema/release-compatible** with this build (coherent schema, complete provenance, release not behind) — not proof it was built from the exact checked-out commit. A release DB is legitimately built from an ancestor commit; `db-doctor` reports that source commit for inspection.

The rc/beta counter is intentionally ignored — a dev checkout's `package.json`
routinely reads `-rc.0` while the correct published DB is a much higher rc. Only
the `MAJOR.MINOR.PATCH` base is a staleness axis.

## Startup behavior

In dev mode, MCP startup emits a **loud but non-fatal** banner when the verdict
is not `ok` (never fetches — a contributor's local build must not be clobbered).
`checkDbFreshness` still hard-fails a genuine schema mismatch and auto-redownloads
in package/compiled mode; this warning is purely additive surfacing.

Keep the classifier, its three consumers, and this file in sync when the verdict
shape or `db_meta` key set changes. Cross-reference: `db-meta-stamping.instructions.md`.
