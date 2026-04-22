# Backlog — rosetta

> Ideas, considerations, and future work. Anything that isn't "how the project works" (→ `CLAUDE.md`) or "why it's built this way" (→ `DESIGN.md`) goes here.
>
> **Convention:** Agents should add items here under the appropriate heading rather than creating new files. Include enough context that a different agent (or human) can act on it later without the original conversation.
>
> **Design principles and the North Star architecture are in `DESIGN.md`.** This file is the *action list* — what to build, what needs a decision, what's waiting on a trigger.
>
> **Last holistic review:** 2026-04-20. Known-topics, glossary, and drop-search-properties shipped. Three "Needs Input" items resolved.
>
> **Shipped since last review:** North Star steps 2–4 — `classifyQuery` (src/classify.ts, 42 table-driven tests), `searchAll()` wrapper (src/query.ts) wired into both MCP `routeros_search` and TUI, dropped folded standalone tools `routeros_search_callouts` and `routeros_search_videos` (tool count 15→13; content surfaces in `related` block instead), and budget-aware `getPage()` that includes `properties` + `related_videos` on TOC-mode responses.

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

### 🟢 Test isolation — DB-leak guards (DONE in this PR)

**Recorded for history; not a future task.** Release v0.7.6 shipped a 3-page DB
because `extract-dude.test.ts` statically imported `extract-dude.ts` (which loads
`db.ts`) before any `DB_PATH=:memory:` was set, then `query.test.ts:beforeAll`
ran `DELETE FROM …` against the cached singleton — wiping the CI-built DB and
replacing the contents with fixtures (3 pages, 11 devices, 2 properties). The
`Collect DB stats` step had no minimum-pages assertion, so the broken DB sailed
through to GitHub Releases, npm, and OCI.

Fixed three ways:

1. `extract-dude.test.ts` now sets `DB_PATH=:memory:` before dynamic-importing
   `extract-dude.ts`.
2. `query.test.ts` hard-fails (`throw new Error`) if the imported `DB_PATH` is
   anything other than `:memory:` — so a future test-ordering change that
   regresses the leak crashes loudly instead of silently wiping data.
3. `extract-html.ts` now `process.exit(1)` if 0 pages were extracted.
4. `release.yml` has a new "Validate DB has expected content" step gated on
   `pages ≥ 200`, `commands ≥ 1000`, `devices ≥ 100`, `properties ≥ 1000`,
   running BEFORE artifact build / OCI push / GitHub Release / npm publish.
   `release.test.ts` enforces this structurally.

**Follow-up to consider:** make `db.ts` lazy — only open `Database` on first
real use, not at module-evaluation time. That would remove the entire class of
"DB_PATH set too late" bugs. Out of scope for this fix.

### 🟢 bunx auto-update story — critical items resolved (v0.7.7–v0.7.8)

**Original problem (2026-04-21):** bunx flow had several ways to silently leave a user with a bad DB. Items 1–4 have been fixed; items 5–7 remain as nice-to-haves.

**RESOLVED items (v0.7.7–v0.7.8):**

1. ~~Schema-mismatch fall-through~~ — ✅ `ensureDbReady` in `mcp.ts` now re-validates schema after download and fails hard with an actionable message if still mismatched.
2. ~~DB pinned to "latest" Release~~ — ✅ `dbDownloadUrls()` in `setup.ts` tries pinned URL (`releases/download/vVER/ros-help.db.gz`) first, falls back to `latest`.
3. ~~Non-atomic write~~ — ✅ writes to `.tmp.<pid>`, deletes stale `.db-wal`/`.db-shm`, then `renameSync` to canonical path.
4. ~~No download validation~~ — ✅ magic-byte check + min-size check + `probeDb` (schema version, page count, command count) before rename. **Gotcha:** every SQLite open of the canonical DB path must be read-write — freshly written WAL-mode files cannot be opened readonly on macOS until a read-write connection first initialises the `.shm` file, and `downloadDb` explicitly deletes `.wal`/`.shm` before the atomic rename. First fix in v0.7.8 (`2f7f7ee`) covered `probeDb`; v0.8.0 shipped with the same trap still in `mcp.ts::ensureDbReady` (the post-download re-probe used `{ readonly: true }`) → users saw `Validated: schema v5 …` immediately followed by `Still incompatible after re-download (DB=unreadable)`. Fixed in v0.8.1: removed the last `{ readonly: true }` in `mcp.ts` + `setup.ts::dbHasData`, added an anchor test that builds a WAL-mode DB, deletes the siblings, and probes it, and a structural test forbidding `{ readonly: true }` on DB opens. `db_meta` table (schema v5) stores `release_tag`, `built_at`, `source_commit`. **CI smoke:** `release.yml` now runs a `bunx-smoke` job on macOS + Linux after npm publish, pinning the just-published version; version auto-bump only runs if that smoke passes, so a broken release keeps `package.json` pinned until a fix ships.

**Still open (nice-to-have, not blocking):**

5. **No freshness check after first install.** Once schema matches, the DB is never re-downloaded automatically. A DB-only release can't reach existing users without `--refresh`. Plan: fire-and-forget HEAD to GitHub releases API on startup; log a one-line hint if newer release exists; cache check timestamp in `db_meta.last_check_at`; honour `ROSETTA_OFFLINE=1`.
6. **`--refresh` is noisy.** Re-runs `runSetup` which prints ~80 lines of MCP client config. A "just refresh my data" path should be quiet (only download + validate + 1-line stats). `--setup` keeps printing config.
7. **Incompatible-version error messaging.** `process.argv[0]` used in retry hint is the bun binary path, not `bunx @tikoci/rosetta`. Confusing for users.

**Background — how bunx caching works.** bun resolves `latest` dist-tag from npm on each invocation, caches per exact version under `~/.bun/install/cache/@tikoci/rosetta@<ver>@@@1/`. New npm releases are picked up automatically. The npm-side update story works; the gap is everything after bunx hands off to our code.

**Out of scope.** Telemetry, signed DB downloads, mirror CDN. Security posture: download URL stays under `github.com/tikoci/rosetta/`, `redirect: follow` only follows to `objects.githubusercontent.com`.

### 🔴 Version GC — bound `schema_node_presence` growth

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

### ✅ TUI<>MCP parity gaps (post North Star) — resolved

The North Star folded callouts, videos, and properties into `routeros_search`'s `related` block. The TUI used to have standalone commands with richer output than what `related` provided. Resolved as follows (see `src/query.ts`, `src/browse.ts`, `src/mcp.ts`):

- **Callouts / Videos** — `searchAll()` now scales `RELATED_CAP`/`RELATED_VIDEO_CAP` proportionally to the `limit` argument via `relatedCaps(limit)`. Higher `limit` = more callouts/videos surfaced. The `limit` parameter doubles as a "hunger knob" — agents express how much context they want, and the related block expands accordingly. Aligned with David Parra's MCP talk (https://youtu.be/v3Fr2JR47KA): one knob > many narrow tools.
- **Glossary** — added to `searchAll().related.glossary`. Triggered when input ≤2 words matches a glossary term/alias, or when a classified topic matches. Closes the most clear-cut gap without adding an MCP tool.
- **Properties** — deferred. Better solution is to extend `routeros_lookup_property` with a `query=` mode (FTS over name+description). Tracked separately under the next backlog item.
- **MCP probe in TUI (dot-commands)** — `.<tool_name> [positional...] [key=value ...]` in the TUI invokes the same code path as the MCP server tool and dumps raw JSON. 13 dot-commands cover every MCP tool 1:1. `.help` lists them. This is the contract for "human can always see what the agent sees."

### 🟢 routeros_lookup_property — add `query=` FTS mode

**Trigger:** Confirmed agent need for broad property FTS (currently only TUI `props` does this).
Extend the existing tool with an optional `query` parameter that runs `searchProperties(query, command_path?, limit)` — returns ranked rows when `query` is set, exact match when `name` is set. Keeps tool count at 13.

### 🟢 Programmatic tool calling / "code mode" exploration

**Trigger:** Anthropic Apps SDK or comparable spec stabilizes; or a user explicitly requests it.

David Parra's Anthropic Code Conf talk (https://youtu.be/v3Fr2JR47KA) argues that letting the model write small programs that orchestrate MCP tool calls (rather than one tool call per turn through inference) is materially better for cost, latency, and composability. Worth investigating whether rosetta should expose:

- A "tool of tools" that takes a small JS/TS snippet calling our query functions and returns the result
- An MCP `applications` or `skills` surface for guided multi-step tasks (e.g., "diagnose why X broke after upgrading from A to B")
- More compact tool responses to fit better in code-mode inner loops

Not urgent — the current 13-tool surface is clean and small enough — but capture as a research item.

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
