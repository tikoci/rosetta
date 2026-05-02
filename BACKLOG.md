# Backlog — rosetta

> Ideas, considerations, and future work. Architecture and durable rationale live in `DESIGN.md`; current implementation details live in `CLAUDE.md`; shipped user-visible behavior lives in `CHANGELOG.md`.
>
> **Convention:** keep this file actionable. Add items under the narrowest heading with a concrete next action, trigger, or decision needed. If an item becomes a long design note, move the rationale to `DESIGN.md` and leave only the task here.
>
> **Last holistic review:** 2026-04-30. Docs/instructions alignment pass:
> extraction/release docs updated for Dude cache, transcript cache, skills,
> `gc-versions`, post-extraction gates, and MCP resources. Long-form
> cross-tikoci `explain → validate → run` and MCP deployment/trust-boundary
> notes moved to `DESIGN.md`.

---

## Priority Guide

| Priority | Meaning |
|----------|---------|
| 🔴 High | Core value or release-risk work |
| 🟡 Medium | Meaningful improvement, no known blocker |
| 🟢 Low | Nice-to-have, deferred, or waiting on a trigger |

---

## Ready to Build

Clear scope, no blockers, ready to act.

### 🔴 Release, update, and packaging cleanup

- **Drop or gate local `make release`.** Preferred published release path is the GitHub Actions `Release` workflow. Decide between deleting the local `release` target or gating it behind `ALLOW_LOCAL_RELEASE=1`; update `DESIGN.md`, `CONTRIBUTING.md`, and `CLAUDE.md` if behavior changes. CI pickup: release semantics are exercised by `.github/workflows/release.yml`; Makefile structural expectations are covered by `src/release.test.ts`.
- **Keep GitHub Actions on Node 24-compatible majors.** Dependabot is already bumping `actions/setup-node`, `actions/upload-artifact`, and Docker actions; keep merging those PRs before GitHub's forced runtime transitions turn warnings into failures.
- **Make `html_url` intentionally supplied or auto-discovered.** The default Seafile direct link can rotate. Either remove the default so dispatchers must supply the export URL, or implement latest-export discovery from a durable index.
- **Promote CHANGELOG.md into release notes.** Release workflow should use `[Unreleased]` as the GitHub Release body, promote it to a dated version heading, and commit that in the same bump-version path. Skip in `republish_assets` mode.
- **Shrink Makefile toward ETL only.** Keep extraction/check orchestration where `make` adds value; drop pure `bun` delegations if the local release path is removed. Update docs in the same change.

### 🟡 Extractor import side effects

Several extractors still import `db.ts` at module evaluation time. Future pure-parser tests can accidentally open the real DB before `DB_PATH=:memory:` is set.

Action: convert remaining extractor entrypoints to the safe pattern used by `extract-html.ts`, `extract-dude.ts`, `extract-schema.ts`, `extract-test-results.ts`, and `extract-videos.ts`: export/import helpers safely, put DB imports inside `main()`, and guard execution with `if (import.meta.main) await main()`.

### 🟡 bunx auto-update polish

Critical schema/atomic-download issues are fixed; remaining polish:

- Add a lightweight freshness check after first install so DB-only releases can prompt users to run `--refresh` without silently staying stale. Cache check timestamp in `db_meta.last_check_at`; honor `ROSETTA_OFFLINE=1`.
- Make `--refresh` quiet: download + validate + one-line stats, without printing full MCP client config.
- Improve incompatible-version hints so they say `bunx @tikoci/rosetta --refresh` instead of using the bun binary path from `process.argv[0]`.
- Decide whether package mode should move from a single shared `~/.rosetta/ros-help.db` to a schema-versioned filename (for example `ros-help.v5.db`) so future DB-format changes cannot fight over the same canonical file. Trigger: if cross-version bunx upgrades still produce Windows lock/rename issues after the current sidecar-lock + probe-hardening fix. CI pickup today: normal startup/recovery is covered by `src/setup.test.ts`, `src/release.test.ts`, and `.github/workflows/test.yml`; a pathing change would need those tests plus README/MANUAL updates in the same PR.

### 🟡 Command tree enrichment / validation metadata

These serve the `DESIGN.md` "Command validation pipeline — explain / validate / run" direction.

- **Completion data promotion.** `_attrs.completion` shape is known (`{ [value]: { style, preference, desc? } }`). After confirming stability across more versions, promote into structured columns for SQL filtering and enum suggestions.
- **Package metadata.** Populate `schema_nodes._package` once restraml emits package provenance. This is higher leverage than arch filtering for explaining why a valid command is unavailable on a device.
- **Arch as advisory, not exclusion.** Command-tree tools should treat `arch` as a hint: prefer matching arch data when available, but avoid empty results for unsupported arches and include explicit notes about coverage.

### 🟡 HTML and property extraction improvements

- **List-format properties.** Parse `<ul><li><strong>name</strong>` property lists on pages such as Queues, Hotspot, and RADIUS. Estimated gain: ~496 properties across 73 pages.
- **Script example demarcation.** Preserve RouterOS code blocks in context as fenced blocks instead of only flattening to the separate `code` field. Keep a plain-text path for consumers that do not want Markdown.

### 🟡 Search result quality and presentation

- **Video metadata quality signals.** Store and surface `transcript_source` (`auto|author|none`), `upload_date`, and `view_count`. Treat videos as locators, not authoritative sources; include transcript excerpts only when source quality supports it.
- **Structured highlights.** FTS snippets currently encode highlights with literal `**` markers. Consider returning sibling `highlights: [{ start, end }]` arrays for clients that render highlights directly.
- **`routeros_current_versions` enrichment.** Optional `additional_data=true` could include MikroTik download URLs and tikoci/restraml refs, clearly marked as community-sourced when not official MikroTik data.

### 🟢 TUI polish

- Add pass-through flag parsing (`--limit`, `--version`, `--breaking`, etc.) for normal TUI commands; dot-commands already accept `key=value`.
- Add vi-style `/pattern` search within the current result set, with `n`/`N` navigation.
- Longer wishlist: tab completion, persistent history (`~/.rosetta/browse_history`), export (JSON/CSV/Markdown), audit views, bookmarks.

---

## Needs Decision

Items where the design direction matters before implementation.

### 🟡 `routeros_lookup_property` broad FTS mode

Should `routeros_lookup_property` grow optional `query=` mode, or should broad property discovery stay TUI/internal only?

Current idea: if `name` is set, keep exact lookup behavior; if `query` is set, run `searchProperties(query, command_path?, limit)` and return ranked rows. This keeps tool count stable and mirrors existing TUI `props` behavior.

### 🟡 Standalone binaries positioning

Compiled binaries are useful as OCI internals and a no-runtime fallback, but `bunx @tikoci/rosetta` is the primary local install path. Decide whether README/MANUAL should further de-emphasize binaries to reduce Gatekeeper/SmartScreen support burden.

### 🟢 Direct SQL tool remains out of scope

Current decision: no `run_sql` MCP tool. Schema resources plus targeted tools are sufficient. Revisit only if `routeros_search` and drill-down tools prove insufficient in real sessions.

---

## Investigate

Research-needed items with a concrete next experiment.

### 🟡 inspect.json / deep-inspect coverage gaps

Wi-Fi, LoRa, ZeroTier, and non-CHR package coverage remain imperfect.

Next actions:

- Add tool-description or response notes where package coverage is known to be incomplete.
- Target high-value linking for missing Wi-Fi/LoRa/scripting docs.
- Extract package lists from RouterOS package documentation.
- Coordinate with restraml on real-device inspect coverage for ARM 32-bit, MIPSBE/MMIPS, and wireless-driver packages.

### 🟢 Dude follow-ups

- Check whether missing cached pages (`The_Dude`, `v3_Device_map`, `v3_Device_list`) can be recovered from Wayback.
- Link `/dude` commands to `dude_pages`.
- Document `dude.db` schema when a safe sample DB is available.
- Revisit image return formats when MCP multimodal support is practical.

### 🟢 Device AKA / alias handling

Build an alias table only when real false-empty lookups appear (for example renamed models such as `hex 2024` → `hEX refresh`). Record each mismatch with the user query, expected product, and source evidence.

### 🟢 Special hardware page extraction

Switch Chip Features, Marvell Prestera, Bridging and Switching, and Peripherals contain device-specific tables worth extracting. Watch for user-visible misses as the trigger to prioritize.

### 🟢 `/app` auto-update behavior

Test whether RouterOS pulls `:latest` fresh on each boot or caches by digest. Needs a multi-reboot `/app` install test.

### 🟢 ETL pipeline streamlining

Future cleanup: unify idempotency semantics, reduce local/CI divergence for cached sources, and add a `rosetta --check` health command.

### 🟢 MCP behavioral testing phases 3+

Phases 0-2 are implemented (`src/eval/retrieval.ts`, `src/eval/self-supervised.ts`, `src/mcp-contract.test.ts`). Remaining research:

- **Phase 3:** local-LLM judge via Ollama for relevance checks; opt-in, never CI-default.
- **Phase 4:** cheap remote judge, batched/cached/manual, with cost guardrails.
- **Phase 5:** differential testing across DB builds; run golden queries against previous release vs HEAD and report top-3 diffs.
- Consider mutation testing for query variants and opt-in TUI/usage logs as future eval corpus sources.

---

## Deferred / Triggered

Waiting on an external event or an explicit trigger.

- **MCP Registry publish automation.** Trigger: CI OIDC auth configured. Add publish step to `release.yml` and sync `server.json` version from tag.
- **OCI armv7 support.** Trigger: Bun armv7 target and MikroTik `/app` armv7 support both exist.
- **Documentation version tracking.** Trigger: second HTML export available. Add `doc_exports` metadata with date/page counts/text hashes; evaluate Confluence page ID stability.
- **Copilot context provider via `lsp-routeros-ts`.** Trigger: LSP integration matures enough to provide doc context via MCP or direct DB queries.
- **Cross-DB federation with forum archive.** Trigger: forum archive stable and classifier/plugin point ready.
- **Local usage analytics.** Trigger: need real query-shape data. Keep opt-in (`ROSETTA_LOG_USAGE=1`) and local-only.
- **Video extraction retry.** Trigger: scheduled transcript refresh. Re-run consistent-fail videos after 48-72h gaps; add to `known-bad.json` after repeated failures.
- **LSP consumer artifacts.** Trigger: `lsp-routeros-ts` ready for static manifests. Publish path→URL/title and verbs manifests as CI artifacts; keep universal verb fallback active.

---

## Archive / Done pointers

Completed work is intentionally summarized here instead of kept as active backlog:

- North Star unified `routeros_search` shipped: classifier, `related` buckets, folded callouts/videos/properties behavior, and smart `get_page()` TOC mode. See `DESIGN.md` "North Star Architecture".
- `routeros_explain_command` shipped as the read-only tier-1 bridge for write-shaped CLI questions. See `DESIGN.md` "Command validation pipeline".
- Canonicalizer hardenings H4/H6/H7/H8 shipped; H1/H2/H3/H5 remain tracked through the command validation/enrichment items above.
- DB-wipe guard and extractor test isolation fixes shipped after the v0.7.6 bad DB release: `query.test.ts` guards `DB_PATH=:memory:`, release CI validates minimum DB content before publishing, and safe extractor import patterns are documented in `.github/instructions/extraction.instructions.md`.
- Version GC shipped: release builds prune `schema_node_presence` to active channel heads while preserving full `command_versions` and changelog history.
- `routeros_search_tests` device filter, `routeros_stats`/`routeros_current_versions` workflow arrows, changelog compact summary mode, and `related.glossary` doc drift fixes are complete.
- "Looks like a command, but args not found" wording shipped via `routeros_explain_command`'s `unknown-arg` warning (`src/query.ts`), so the path-exists-but-arg-unknown response is now a typed warning instead of a wrong-command claim.
- Deleted stale `.npm-publish-checklist.md`; current release/publish guidance lives in `CONTRIBUTING.md`, `CLAUDE.md`, and `.github/workflows/release.yml`.
