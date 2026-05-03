# Backlog — rosetta

> Lightweight inbox + watch list. Real work lives in [`tasks/`](tasks/), grounded design notes in [`briefings/`](briefings/). See `tasks/README.md` and `briefings/README.md` for the full convention.
>
> **Decision rule:**
>
> - Loose thought, no shape yet → **Inbox** below (one line).
> - Waiting on a specific external event → **Triggers** below (one line + condition).
> - Need to think out loud, ground claims, or record a decision → `briefings/B-NNNN-<slug>.md`.
> - Codebase work you'd commit to → `tasks/T-NNNN-<slug>.md` with `status: ready`.

---

## Inbox

Drop one-line thoughts here. Promote later — to a task if it gains shape, to a briefing if it needs thinking-first, or delete if it doesn't survive a re-read.

- Keep merging `actions/setup-node`, `actions/upload-artifact`, and Docker action Dependabot bumps before GitHub's forced runtime transitions turn warnings into failures.
- `src/setup.test.ts` — `probeDb > closes statements so a probed temp DB can be renamed immediately` consistently times out on macOS (~7-8s vs 5000ms timeout); introduced in v0.8.12 Windows-rename fix; passes on CI (Linux). Investigate whether the timeout needs raising or the test needs a macOS skip/guard.
- TUI longer wishlist: tab completion, persistent history (`~/.rosetta/browse_history`), export (JSON/CSV/Markdown), audit views, bookmarks. None individually picked up — promote one to a task if a real need surfaces.

## Triggers

Items waiting on a specific external event. Not tracked as tasks because the wait is indeterminate. When the trigger fires, promote to a `T-*.md`.

| Trigger | Item |
|---------|------|
| Schema-versioned filename for package mode | If cross-version `bunx` upgrades still produce Windows lock/rename issues after the current sidecar-lock + probe-hardening fix. |
| `schema_nodes._package` population | When restraml emits package provenance in deep-inspect output. |
| MCP Registry publish automation | When CI OIDC auth is configured. Add publish step to `release.yml` and sync `server.json` version from tag. |
| OCI armv7 support | When Bun armv7 target and MikroTik `/app` armv7 support both exist. |
| Documentation version tracking | When a second HTML export is available. Add `doc_exports` metadata with date/page counts/text hashes; evaluate Confluence page ID stability. |
| Copilot context provider via `lsp-routeros-ts` | When LSP integration matures enough to provide doc context via MCP or direct DB queries. |
| Cross-DB federation with forum archive | When forum archive is stable and a classifier/plugin point is ready. |
| Local usage analytics | When we need real query-shape data. Keep opt-in (`ROSETTA_LOG_USAGE=1`) and local-only. |
| Video extraction retry | At each scheduled transcript refresh — re-run consistent-fail videos after 48–72h gaps; add to `known-bad.json` after repeated failures. |
| LSP consumer artifacts | When `lsp-routeros-ts` is ready for static manifests. Publish path→URL/title and verbs manifests as CI artifacts. |

---

## Active task index

Auto-listable: `ls tasks/T-*.md`. Hand-maintained pointer for now; a regen script is itself a low-priority follow-up (don't write it until this index gets annoying to maintain).

### `area: qa`

- `T-0011-tui-mcp-parity-test` — Enforce TUI ↔ MCP tool parity
- `T-0012-cli-flag-uniformity-test` — CLI flag documentation parity test

### `area: release`

- `T-0014-html-url-supplied-or-discovered` — Make `html_url` intentionally supplied or auto-discovered
- `T-0015-promote-changelog-into-release-notes` — Promote CHANGELOG.md into release notes
- `T-0016-shrink-makefile-to-etl` — Shrink Makefile toward ETL only (narrowed: T-0013 removed release targets)

### `area: install`

- `T-0018-bunx-freshness-check` — bunx freshness check + `ROSETTA_OFFLINE`

### `area: extraction`

- `T-0017-extractor-import-side-effects` — Convert remaining extractor entrypoints to safe import pattern
- `T-0019-completion-data-promotion` — Promote `schema_nodes._attrs.completion` to structured columns
- `T-0021-list-format-properties` — List-format properties extraction
- `T-0022-script-example-demarcation` — Preserve RouterOS code blocks in page text as fenced blocks
- `T-0023-video-quality-signals` — Video metadata quality signals

### `area: mcp`

- `T-0020-arch-as-advisory` — Treat arch as advisory, not exclusion
- `T-0024-structured-highlights` — Return structured highlights instead of literal `**` markers
- `T-0025-current-versions-enrichment` — `routeros_current_versions` enrichment with download URLs

### `area: tui`

- `T-0026-tui-flag-passthrough` — TUI pass-through flag parsing
- `T-0027-tui-pattern-search` — TUI vi-style `/pattern` search

### `area: docs`

- `T-0031-claude-md-split-into-narrow-instructions` — Split CLAUDE.md into many narrow `.github/instructions/*.md` files (centrs/winrun style); relocate schema/source-details to MANUAL.md/DESIGN.md

## Briefings index

Grounded research and decision notes. Open items are ongoing thinking; resolved items are decisions on the record.

| ID | Topic | Status |
|----|-------|--------|
| B-0001 | Should `routeros_lookup_property` grow broad FTS query mode? | open |
| B-0002 | How aggressively to de-emphasize standalone binaries | open |
| B-0003 | Why no `run_sql` MCP tool | resolved |
| B-0004 | inspect.json / deep-inspect coverage gaps | open |
| B-0005 | Dude wiki extraction follow-ups | open |
| B-0006 | Device AKA / alias handling | open |
| B-0007 | Special hardware page extraction | open |
| B-0008 | `/app` auto-update pull-vs-cache behaviour | open |
| B-0009 | Future ETL pipeline streamlining | open |
| B-0010 | MCP behavioral testing phases 3+ | open |
| B-0011 | Audit the 14-tool MCP surface for consolidation | open |

## Done index

Greppable history of merged work. See `tasks/done/T-*.md` for full back-fill of historical wins.

- T-0001 North Star unified `routeros_search`
- T-0002 `routeros_explain_command` shipped as tier-1 read-only bridge
- T-0003 Canonicalizer hardenings H4/H6/H7/H8
- T-0004 DB-wipe guard + extractor test isolation
- T-0005 Version GC for `schema_node_presence`
- T-0006 `routeros_search_tests` + workflow arrows + glossary fixes
- T-0007 "Looks like a command, but args not found" warning
- T-0008 Deleted stale `.npm-publish-checklist.md`
- T-0009 Windows `bunx-smoke` release coverage
- T-0010 Real-client MCP stdio integration test
- T-0013 Dropped `make release` / `make build-release` / `make bump-version`
- T-0028 `make verify` local CI parity target
- T-0029 Promoted contract test + Phase 0 retrieval eval to blocking in release CI
- T-0030 Self-supervised retrieval eval wired into release CI
