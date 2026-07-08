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
- Benchmark feedback loop: periodically compare retrieval/explain changes against `~/GitHub/bench-routeros-tools`; promote `route-blackhole`, version-new Wi-Fi `ssid=`, and skill-vs-raw-doc packaging into rosetta fixtures when the benchmark corpus stabilizes.
- Future `routeros_validate_command`: carry explicit static-vs-runtime provenance and include a bare-flag `blackhole` regression fixture because `/console/inspect` can accept forms that RouterOS runtime rejects.
- TUI longer wishlist: tab completion, persistent history (`~/.rosetta/browse_history`), export (JSON/CSV/Markdown), audit views, bookmarks. None individually picked up — promote one to a task if a real need surfaces.
- Rung-1 steering skill: a skill encoding the `llms.txt → .md → cli-reference` workflow (per B-0013), possibly wrapping T-0032's one-shot CLI. Cross-repo (`routeros-skills` or repo-local per the centrs#150 pattern) — promote once centrs#150's onboarding pilot lands.
- Switch-chip → device resolution is a common need that resolves poorly today. `devices.cpu` conflates the Marvell switch ASIC with the management CPU, so a chip-ID query only matches the ARM32 CRS3xx boxes where the ASIC *is* the CPU (e.g. `98DX8208`→CRS309, `98DX8216`→CRS317); chips on QCA9531/AL73400/AL52400-managed boxes (`98DX8212`, `98DX8332`, `98DX3255`, `98DX3257`, `98DX4310`, `98DX8525`, `98CX8410`) miss entirely. A real session (resolving an l3hw HW-offloaded-VRF release note listing 9 chips) needed ~6 tool calls because the only authoritative chip→model source is the L3 Hardware Offloading doc table (page 62390319), not a queryable field. Candidate fix is two-sided: an extraction-side `switch_chip` column on devices (distinct from `cpu`; could be seeded from that doc table), plus an MCP-side path so `routeros_device_lookup`/`routeros_search` resolve switch-ASIC IDs to product models directly. Relates to B-0006 (device AKA/alias) and B-0007 (special hardware page extraction); promote to a task if the switch_chip column lands or another chip→device question recurs.

## Triggers

Items waiting on a specific external event. Not tracked as tasks because the wait is indeterminate. When the trigger fires, promote to a `T-*.md`.

| Trigger | Item |
|---------|------|
| Schema-versioned filename for package mode | If cross-version `bunx` upgrades still produce Windows lock/rename issues after the current sidecar-lock + probe-hardening fix. |
| `schema_nodes._package` population | When restraml emits package provenance in deep-inspect output. |
| MCP Registry publish automation | When CI OIDC auth is configured. Add publish step to `release.yml` and sync `server.json` version from tag. |
| OCI armv7 support | When Bun armv7 target and MikroTik `/app` armv7 support both exist. |
| Legacy documentation version tracking | Only if another archival Confluence export appears. Otherwise, use the Docusaurus manual extraction trigger and B-0012 instead of waiting for a second HTML export. |
| Copilot context provider via `lsp-routeros-ts` | When LSP integration matures enough to provide doc context via MCP or direct DB queries. |
| Cross-DB federation with forum archive | When forum archive is stable and a classifier/plugin point is ready. |
| Local usage analytics | When we need real query-shape data. Keep opt-in (`ROSETTA_LOG_USAGE=1`) and local-only. |
| Video extraction retry | At each scheduled transcript refresh — re-run consistent-fail videos after 48–72h gaps; add to `known-bad.json` after repeated failures. |
| LSP consumer artifacts | When `lsp-routeros-ts` is ready for static manifests. Publish path→URL/title and verbs manifests as CI artifacts. |
| Docusaurus manual extraction | When starting the post-Confluence docs refresh. Gated twice: T-0033 (B-0012 homework H1–H8) must be resolved, **and** the final-Confluence NPM release below must have shipped. Read B-0012 first; this likely affects extractor schema, command linking, MCP result shapes, and TUI parity together. |
| Final help.mikrotik.com NPM release | Before any Docusaurus-migration code lands: cut one last release so the final Confluence-corpus DB stays durably installable. Research (T-0033) may run before this; extractor tasks may not. |
| Manual doc-changes watcher | After Docusaurus extraction lands: CI polls `manual.mikrotik.com/changelog/rss.xml` (verified live 2026-07-07) and opens an issue/PR when the manual changed, making re-extraction event-driven instead of scheduled. |
| bench-routeros-tools merge | When `agents/grounded-data-collection-agents` and the pending Claude matrix work land, review benchmark reports for stable external-eval fixtures and decide whether to promote a rosetta task. |

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
- `T-0032-one-shot-cli-query` — One-shot CLI query mode (`--json`) so a SKILL.md can drive rosetta without MCP config

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

- `T-0033-docusaurus-premigration-grounding` — Resolve B-0012 homework H1–H8 before cutting migration extractor tasks

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
| B-0012 | Docusaurus manual migration after Confluence retirement | open |
| B-0013 | Steering / skills / rosetta / centrs positioning ladder | open |
| B-0014 | CI is release-workflow-locked, not PR/main-gated — QA cleanup plan | open |

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
- T-0031 Split `CLAUDE.md` into narrow instruction files and relocated canonical docs to `MANUAL.md` / `DESIGN.md`
- T-0034 rosetta-id scheme spike — confirmed H7 Option 2 against a live 20-page `/docs` prototype
- T-0035 Docusaurus `/docs` prose extractor — replaced `extract-html.ts` as the default prose source; 360/360 pages live-verified against `llms.txt`
