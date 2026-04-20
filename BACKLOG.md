# Backlog — rosetta

> Ideas, considerations, and future work. Anything that isn't "how the project works" (→ `CLAUDE.md`) or "why it's built this way" (→ `DESIGN.md`) goes here.
>
> **Convention:** Agents should add items here under the appropriate heading rather than creating new files. Include enough context that a different agent (or human) can act on it later without the original conversation.
>
> **Design principles and the North Star architecture are in `DESIGN.md`.** This file is the *action list* — what to build, what needs a decision, what's waiting on a trigger.
>
> **Last holistic review:** 2026-04-20. Known-topics, glossary, and drop-search-properties shipped. Three "Needs Input" items resolved.

---

## Priority Guide

| Priority | Meaning |
|----------|---------|
| 🔴 High | Core value — directly improves the main user experience or enables a cascade of other work |
| 🟡 Medium | Meaningful improvement, no dependencies blocking it |
| 🟢 Low | Nice-to-have, deferred, or waiting on a trigger |

---

## Ready to Build

Clear scope, no blockers, ready to act.

### 🔴 Input classifier for `routeros_search` (North Star step 2)

`classifyQuery(input: string): QueryClassification` in `src/query.ts` or `src/classify.ts`. Regex detectors for command path, version, device model, property name, and known-topic tokens. Ship with table-driven unit tests against a corpus of ~30 real RouterOS questions. Not yet wired into `searchPages`. See `DESIGN.md` "North Star Architecture" for detector table and response shape.

### 🔴 `searchAll()` — multi-table search wrapper (North Star step 3)

Wrap `searchPages` in a `searchAll(query)` that runs classifier side queries in parallel. Returns the enriched response shape (pages + related callouts/changelogs/videos/commands/devices + next_steps). Wire into both `routeros_search` (MCP) and TUI `s` command. Per Principle 1, neither adapter duplicates logic.

### 🔴 Smart `get_page()` — budget-aware prioritization

When `max_length` is small, rank-include semantically valuable content first: (1) properties, (2) callouts, (3) script examples, (4) headings, (5) ordinary prose (currently first — that's backwards). Secondary: synthetic `related_videos` section via FTS5 match. This is the "hidden consolidation" lever — fewer follow-up tool calls needed. Core change in `query.ts::getPage()`.

### 🔴 Smart `get_page()` — budget-aware prioritization

When `max_length` is small, rank-include semantically valuable content first: (1) properties, (2) callouts, (3) script examples, (4) headings, (5) ordinary prose (currently first — that's backwards). Secondary: synthetic `related_videos` section via FTS5 match. This is the "hidden consolidation" lever — fewer follow-up tool calls needed. Core change in `query.ts::getPage()`.

Keep ~4 active channel heads (long-term, stable, testing, development). Drop `schema_node_presence` rows for versions older than previous long-term on each extraction run. Keeps junction at ~160K rows instead of growing unboundedly. GC is a release-pipeline step (`make gc-versions`). Changelogs exempt (full v7 record, tiny data).

### 🟡 Completion data column promotion

Shape is known: `{ [value]: { style, preference, desc? } }` with 17 style types. Once confirmed stable across 2+ versions, promote from `_attrs.completion` to structured columns. Enables SQL filtering on completion values. Then wire into classifier for enum value suggestions.

### 🟡 Video metadata quality signals

Store `transcript_source` column (`'auto'|'author'|'none'`). Surface `{transcript_source, upload_date, view_count}` in results. Treat videos as **locators, not sources** — include transcript excerpts only when `transcript_source === 'author'`.

### 🟡 HTML extraction: script example demarcation (remaining)

Code blocks track `brush: ros` but extraction flattens to separate `code` field. Consider inlining as fenced blocks so they appear in context. Structural change — pairs with Smart `get_page()`. Keep an alternate plain-text path for consumers that want unformatted text. (Markdown signal tokens already landed 2026-04-16.)

### 🟡 Changelog tool: compact summary mode

Real session produced 802 lines / 23.2 KB for a version-range query. Fix: (1) grouped-summary mode by version×category, (2) raise `limit` max to 200-500, (3) make `from_version` exclusive (currently re-includes entries the user already has).

### 🟡 Multi-arch schema remaining items

- **`browseCommands(arch)` filtering behavior** — currently enrichment-only, not exclusion. MCP doc says "shows arm64-specific interfaces" but results include all. Decide: hide x86-only nodes when `arch=arm64`, or tag them? If hiding: move arch to WHERE filter.
- **`schema_node_presence` has no arch column** — can't answer "did this arm64-only node exist in 7.20?" separately from x86. Defer until arch filter behavior and GC are settled.
- **Accumulate mode drops presence for removed nodes** — non-primary version commands removed by primary can't be FK-referenced. Fix: union all versions' nodes (large) or legacy presence table (no FK). Defer until GC designed.
- **`commands` UNIQUE(path) vs `schema_nodes` UNIQUE(path, type)** — `INSERT OR IGNORE` could silently drop a row if RouterOS ever has same-path different-type entries. Not possible today; note for future.

### 🟢 `routeros_search_tests` device filter

TUI half shipped. Verify MCP tool + `searchDeviceTests()` also accepts `device` param; if not, add it.

### 🟢 Browse REPL — paging + pass-through params

`[XX more results...]` isn't actionable — bump default limits, let pager handle it. Add general flag parser (`--limit`, `--version`, `--breaking`) so TUI exercises same surface as MCP.

### 🟢 TUI — search-in-results (vi-style `/`)

`/pattern` filters/highlights within current result set. `n`/`N` for next/prev. Display concern in `browse.ts` but matcher reuses `extractTerms()` tokenization.

### 🟢 Standalone binaries: clarify internal-only docs

Compiled binaries are primarily internal (OCI images). Update README/MANUAL to deprioritize "Option C" — keep as fallback, stop leading with it.

### 🟢 Table-driven compound terms — DEFERRED

~44 static pairs work fine. Revisit only if list grows past ~100 or runtime updates are needed.

---

## Needs Input / Design Decision

Items where the design isn't obvious. Flagging for user review.

### 🟡 "Looks like a command, but args not found"

**Decided:** When classifier detects a command path that exists but has unrecognized arguments, respond with: "path is right but args were not found" — never say "this is wrong." Wording: "The path `/ip/firewall/filter` exists, but the argument `chain` could not be confirmed in the current data. It may be valid." Ship with the classifier.

### 🟢 Direct SQL access — DECIDED: no

Schema-as-resource is sufficient. No `run_sql` tool planned. Revisit only if `searchAll` proves insufficient and `sqlite3` shell-out is common.

### 🟢 TUI session log — DECIDED: defer

Build after North Star classifier ships. Opt-in, local-only.

### 🟢 Property name fuzzy matching

Should `routeros_search` auto-run fuzzy property match for single lowercase tokens? Risk: false positives. Mitigation: only fire when no page/command match. Subsumable by the classifier.

---

## To Investigate

Items needing research before they're actionable.

### 🟡 List-format properties (496 across 73 pages)

8.8% more properties available from `<ul><li><strong>name</strong>` lists on pages like Queues, Hotspot, RADIUS. Second pass in `extract-properties.ts`. Regular pattern, reliable parsing.

### 🟡 inspect.json extra-package coverage gaps

WiFi, LoRa, ZeroTier missing from CHR-based inspect.json. Actionable now: (1) tool description hints, (2) targeted linking pass for high-value subsystems, (3) extract package list from Packages doc page.

### 🟢 Dude items (4)

- **Cache completeness** — 3 pages missing from `dude/pages/` (The_Dude, v3_Device_map, v3_Device_list). Check Wayback or update page list.
- **Command tree cross-ref** — link `/dude` commands to `dude_pages`. Low priority (Dude declining).
- **SQLite schema extraction** — document `dude.db` schema. Needs sample DB.
- **Image rendering** — return image URLs/base64 in MCP responses. Depends on MCP SDK multimodal support.

### 🟢 Device AKA Phase 2 (alias table)

For genuine renames (`hex 2024` → `hEX refresh`). Build only when user reports false-empty on a renamed product.

### 🟢 Special hardware pages

Switch Chip Features, Marvell Prestera, Bridging and Switching, Peripherals — device-specific tables worth extracting. Watch for renames as "something important changed" signal.

### 🟢 /app auto-update behavior

Does RouterOS pull `:latest` fresh on each boot or cache by digest? Needs multi-reboot test.

### 🟢 ETL pipeline streamlining

Different idempotency semantics, local/CI path divergence for videos, no `--check` command. Not urgent — works today. Future: unify patterns, add `rosetta --check`.

### 🟢 Other low-priority items

- Product matrix CSV automation (quarterly manual is fine)
- macOS code signing ($99/yr, Bun install avoids the issue)
- Debounce inspect.json fetches (GitHub Pages has no rate limit)
- MCP resources beyond CSVs (don't overinvest)
- Cross-reference with forum data (post-classifier)

---

## Deferred (waiting on a trigger)

### 🟢 MCP Registry publish automation

**Trigger:** CI OIDC auth configured. Then: add publish step to `release.yml`, sync `server.json` version from tag.

### 🟢 OCI armv7 support

**Trigger:** Both Bun armv7 target AND MikroTik `/app` armv7 support need to ship. Neither exists today.

### 🟢 Documentation version tracking

**Trigger:** Second HTML export available. Then: `doc_exports` metadata table with date/page count/text hashes. Evaluate Confluence page ID stability across exports.

### 🟢 Copilot context provider via `lsp-routeros-ts`

**Trigger:** LSP integration matures. VS Code extension provides doc context via MCP or direct DB queries.

### 🟢 Cross-DB federation with forum archive

**Trigger:** Forum archive stable + North Star classifier in place as plug-in point.

---

## Improvements (smaller, not urgent)

### 🟢 Stop words — post-classifier

Context-dependent stop words are exactly what `classifyQuery()` will handle. NL questions should stop-list "set"; command input should keep it. No action until classifier ships.

### 🟢 Usage analytics

Local-only `usage_log` table, opt-in via `ROSETTA_LOG_USAGE=1`. More important after North Star ships — measures whether consolidated search replaced specialized tools.

### �� Agent-assisted linking (remaining ~8% of command dirs)

Targeted manual review of WiFi, LoRa, scripting to close highest-value gaps.

### 🟢 LSP integration

`lsp-routeros-ts` hover handler should consume property data. Consumer-side work — data is ready.

### 🟢 Browse REPL wishlist

Tab completion, history persistence (`~/.rosetta/browse_history`), raw SQL mode, export (JSON/CSV/Markdown), audit views (unlinked commands, pages without properties), bookmarks.

### 🟢 Video extraction — periodic retry

143 consistent-fail videos (likely rate-limited). Re-run after 48-72h gaps; add to `known-bad.json` after 4+ failures.
