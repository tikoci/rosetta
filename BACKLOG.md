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

### 🔴 bunx auto-update story — code/DB version drift, non-atomic write, silent broken state

**Problem.** Today the bunx flow has several ways to silently leave a user with bad data, and no automatic recovery once configured in an MCP client. Concrete defects identified 2026-04-21 review:

1. **Schema-mismatch fall-through (`src/mcp.ts` `ensureDbReady`).** When `PRAGMA user_version` doesn't match `SCHEMA_VERSION`, code logs a warning and re-downloads — but does not re-check the new DB's version, and unconditionally proceeds to open it. If the bunx-cached package is older than the published DB (or vice versa), the server keeps booting with an incompatible schema instead of failing loudly.
2. **DB pinned to "latest" Release, not running package version.** `https://github.com/tikoci/rosetta/releases/latest/download/ros-help.db.gz` is hardcoded in `setup.ts`. `bunx`-cached package and DB schema are independent variables, so any release that bumps `SCHEMA_VERSION` breaks every cached older install until the user runs `bun pm cache rm`.
3. **Non-atomic write.** `writeFileSync(dbPath, decompressed)` overwrites in place. Ctrl+C / OOM / disk-full mid-write leaves a truncated file. Stale `.db-wal` / `.db-shm` from the previously open DB are not removed when the file is replaced (user's `~/.rosetta/` currently has both).
4. **No download validation.** No size check, no `SQLite format 3` magic-byte check, no `pages > 0` / `commands > 0` post-write probe. A redirect-to-login HTML page or partial transfer would be written verbatim and only caught when SQL queries start failing.
5. **No freshness check after first install.** Once `pages > 0` and schema matches, the DB is never re-downloaded for the lifetime of that bunx cache entry. A DB-only release (same package version, refreshed docs) cannot reach an existing user automatically.
6. **`--refresh` is noisy.** Re-runs `runSetup` which prints ~80 lines of MCP client config snippets every time. A "just refresh my data" path should be quiet.
7. **Incompatible-version error messaging.** `process.argv[0]` (used in retry hint) is the bun binary, not `bunx @tikoci/rosetta`. Users see a confusing path.

**Background — how bunx caching actually works (verified locally).** bun resolves the `latest` dist-tag from npm on each invocation and caches per exact version under `~/.bun/install/cache/@tikoci/rosetta@<ver>@@@1/`. New npm releases are picked up automatically (no manual `bun pm cache rm` needed in practice). Old version directories linger but are not used. So the npm-side update story works — the gap is everything **after** bunx hands off to our code.

**Comparable projects.** Most reference MCP servers ship no bundled data, so they sidestep this entirely. The closest analogues are bundled-data tools (`tldr-pages` clients, language-server grammars, `ripgrep-all` adapters) — all of them pin the data version to the running code version and atomic-swap on update. That's the pattern we should adopt.

**Plan — ship as one focused PR.**

- **A. Pin DB URL to running version.** Change `releases/latest/download/...` → `releases/download/v${VERSION}/ros-help.db.gz` in `setup.ts`. Fall back to `latest` when the version-pinned asset 404s (covers code-only releases that didn't rebuild the DB). Eliminates schema drift by construction.
- **B. Atomic download + validate.** Always download to `<dbPath>.tmp.<pid>`, fsync, validate (SQLite magic bytes, `PRAGMA user_version`, `pages > 100`, `commands > 1000`), then `rename(.tmp, .db)`. Delete sibling `.db-wal` / `.db-shm` in the same step. On any validation failure, keep the existing DB and surface a clear error.
- **C. Fix schema-mismatch fall-through.** After re-download, re-check `PRAGMA user_version`. If still mismatched, fail with an actionable message that names the package vs DB versions and tells the user to clear bunx cache (`bun pm cache rm`). Never proceed with a broken DB.
- **D. Embed release tag in the DB.** Add `db_meta` table written at extract time: `release_tag TEXT, built_at TEXT, schema_version INTEGER, source_commit TEXT`. Lets `--version` and startup banner print "DB v0.7.3 from 2026-04-19" and lets the freshness check (item E) compare without an external file.
- **E. Opt-out background freshness check.** On startup, after DB load, fire-and-forget HEAD to `https://api.github.com/repos/tikoci/rosetta/releases/latest`. If the latest tag is newer than `db_meta.release_tag`, log a one-line stderr hint ("a newer DB is available — restart with `--refresh` to update"). Cache the check timestamp in `db_meta.last_check_at`; check at most once per 24h. Disabled when `ROSETTA_OFFLINE=1` or `--no-update-check`.
- **F. Quiet `--refresh`.** Strip the config-printing path from `--refresh`; only download + validate + print 1-line stats. `--setup` keeps printing config (that's its job).
- **G. MCP tool `routeros_refresh_database`.** Optional follow-up — agent-triggered refresh without leaving the chat. Returns new stats. Defer to phase 2 if A–F are too big a single PR.
- **H. Docs.** README/MANUAL get a short "How updates work" section: bunx auto-resolves latest npm version, DB is pinned to that version, first launch after package update atomic-swaps the DB.

**Tests required (per project hard rule).**

- `src/setup.test.ts` (new): mock fetch + temp dir; assert `.tmp` → rename flow, validation rejects 0-byte / wrong-magic / wrong-schema downloads without touching the existing file, schema-mismatch loop fails hard instead of fall-through.
- `src/release.test.ts`: assert version-pinned URL pattern in `setup.ts`, assert `db_meta` row written by extractors, assert release.yml uploads `ros-help.db.gz` under tagged release (already true).
- `src/query.test.ts` schema-health section: assert `db_meta` table exists with expected columns.

**Migration / risk.** SCHEMA_VERSION must bump (4 → 5) because of the new `db_meta` table. That's exactly the kind of bump this fix is designed to handle gracefully. Old bunx caches will see schema mismatch, attempt re-download against a version-pinned URL that won't exist for their old package version, fall back to `latest`, get the new schema, and succeed. Verify this path explicitly in tests.

**Out of scope for this PR.** Telemetry, signed DB downloads, mirror CDN. Note the security posture: download URL stays under `github.com/tikoci/rosetta/`, `redirect: follow` only follows to `objects.githubusercontent.com`. Document in `SECURITY.md`.

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
