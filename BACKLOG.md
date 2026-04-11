# Backlog — rosetta

> Ideas, considerations, and future work. Anything that isn't "how the project works" (→ `CLAUDE.md`) or "why it's built this way" (→ `DESIGN.md`) goes here.
>
> **Convention:** Agents should add items here under the appropriate heading rather than creating new files. Include enough context that a different agent (or human) can act on it later without the original conversation.
>
> **Last holistic review:** 2026-04-10. Principles and North Star below were set in that review — subsequent edits should respect them or explicitly reframe them.

## Guiding Principles

These shape everything below. If a backlog item conflicts with them, the item is wrong and should be reframed.

### Principle 1 — TUI and MCP are a pair, not a tool and its test harness

The `browse` TUI is a first-class path into the rosetta data, as legitimate as the MCP server for humans who prefer keywords and iterative drill-down. Both surfaces take short, NL-like input and lead the user through the same discovery chain: search → drill-down → related content. The TUI deliberately mimics the MCP tool shape (`s <query>` ≈ `routeros_search`, `page <id>` ≈ `routeros_get_page`, etc.) so improvements on one side reinforce the other.

**Implication for how we build:** logic lives in core functions in `query.ts`. `mcp.ts` and `browse.ts` are thin adapters that render the same results for different audiences. If a backlog item says "add X to the TUI" or "add X to an MCP tool," first check whether it belongs in core — usually it does.

The LLM-vs-human difference is inference, not mechanics: an LLM can infer more from ambient context before calling a tool; a human kick-starts a drill-down with keywords they already know. Both still want the same thing — the shortest path from question to answer without reading whole documents.

### Principle 2 — Dual-use is the feature, not a compromise

The TUI's dual role (user tool + test harness for MCP behavior) is deliberate. Gaps visible in `browse` almost always point to gaps in the MCP tool surface. Resolving the "MCP wants tool-selection shortcuts, humans want friendliness" tension means pushing smarts into core functions so both surfaces inherit them for free.

**Discipline check:** resist shoving more logic into `browse.ts` or `mcp.ts`. When a heuristic could help both audiences it belongs in `query.ts` (or a new input-classifier module). Flag PRs that grow TUI-only or MCP-only heuristics as a possible smell.

### Principle 3 — Too many tools. Make `routeros_search` smart enough that most questions need only it

Agents observed in real sessions typically reach for `routeros_search` and `routeros_get_page`; anything beyond that is rare. The right response is not more tool-description steering — it's making `routeros_search` answer more of the question before the agent has to ask again. See the "North Star" section below.

### Principle 4 — Command/schema work is downstream of restraml

Any deep reshaping of the `commands`, `command_versions`, or property schemas is blocked on restraml delivering populated `deep-inspect.json` (argument enums, type info, validation hints). Until then, limit scope to cleanup, idempotency, and light heuristics. Don't design a new schema in the dark.

**The shape of the eventual schema is known, even if the data isn't yet.** RouterOS commands have four parts that the current schema munges together:

1. **Path** — `/ip/` (root-level subsystem)
2. **Dir** — `/ip/address` (settable/listable object type)
3. **Command** — `set | print | remove | add | <special>`, which maps to REST verbs `PATCH | GET | DELETE | PUT | POST` (plus hybrids like `.../set_POST`, `.../get+POST`, `.../add+POST`, `.../remove+POST`)
4. **Parameters** — named (`name="myname"`) or unnamed positional (`/system/script/run myscript` accepts an unnamed first positional that maps to `name`)

`routeros_search_properties` is worthless as an MCP tool in isolation because it only addresses part 4 — no dir/command context, and most property descriptions can be inferred from the name anyway. The property data still matters for *other* reasons: it's a likely input to restraml's `deep-inspect.json` enrichment (MikroTik's `/console/inspect` has no "help" text, so properties extracted from docs fill that gap). Keep the schema, retire the tool. See "Drop `routeros_search_properties` as an MCP tool" under Ready to Build.

---

## North Star — unified `routeros_search`

Most items in "Ready to Build" and "Improvements" feed into this. Keeping it called out so subsequent sessions don't lose the thread.

### Vision

A single `routeros_search(query)` call that does enough preprocessing, cross-table lookup, and response synthesis that a typical RouterOS question gets a useful, multi-source answer in one roundtrip. The MCP tool and the TUI's default search both route through the same core function.

### The input classifier

Before any FTS query, pre-parse the input with cheap regex-based detectors. Each detector fires independently:

| Detector | Pattern | Side effect |
|---|---|---|
| **RouterOS command path** | `^/[\w-]+(/[\w-]+)*` e.g. `/ip/firewall/filter` | Look up in `commands`; return node + children + linked page. If partial/invalid, "no exact match — closest is X" using the nearest `commands.path`. |
| **Command fragment / `name=value` pair** | `foo=bar`, `add chain=forward action=drop` | Light tokenize; match tokens against `commands.name` and `properties.name`. Return best-effort interpretation with a "syntax might be historical — verify" note (see design decision below). |
| **RouterOS version** | `\b7\.\d+(?:\.\d+)?(?:beta\d+\|rc\d+)?\b` | Check `ros_versions`. Narrow results where possible via `command_versions`; add a `version_context` note. |
| **Changelog topic prefix** | Term matches a known category like `bgp`, `wifi`, `bridge`, `container` | Side query against `changelogs` filtered by category (ideally scoped by any detected version). |
| **Device model** | `RB\d+`, `CCR\d+`, `hEX`, `hAP`, `CRS\d+`, `CHR` | Side query `devices_fts`; include top match + link. |
| **Property name** | Single short lowercase token that exists in `properties.name` | Side query; return the property directly instead of making the agent call `lookup_property`. Only fire when the token doesn't match a page title or command path. |
| **Known topics superset** | Union of changelog categories + high-traffic doc path segments | Soft signal for topic routing. See "Known topics extraction" below. |

Detectors are non-exclusive. A query like `bgp 7.22 route reflection` should fire **topic** (`bgp`), **version** (`7.22`), and general FTS — and the response should include (a) page hits, (b) the most relevant BGP changelog entries in 7.22, and (c) any BGP-related callouts.

### Enriched response shape

```text
{
  query: "bgp 7.22 route reflection",
  classified: {
    version: "7.22",
    topics: ["bgp"],
    command_path: null,
    device: null,
    property: null
  },
  pages: [ ... top page results ... ],
  related: {
    callouts:   [ ... top 2 ... ],
    properties: [ ... top 2 ... ],
    changelogs: [ ... top 3 for bgp in 7.22 ... ],
    videos:     [ ... top 2 with transcript_quality flags ... ],
    commands:   [ ... if a path matched ... ],
    devices:    [ ... if a device matched ... ]
  },
  next_steps: [ ... concrete follow-up calls with actual arguments ... ]
}
```

All `related` sections cap at 2–3 entries so the response stays small. Empty sections are omitted entirely.

### Zero-result handling

Never return bare empty results. If FTS returns nothing:

1. Run the **OR** fallback (already done for pages).
2. If still empty, re-run the classifier's side queries (the user may be asking for something that only exists in callouts, changelogs, or devices).
3. If still empty, return a **"nothing matched — you might try"** block with concrete next queries, informed by the classifier (e.g., `tried FTS for ['chateaulte18']; did you mean device 'Chateau LTE18 ax'? Try device chateau lte18`).

The LLM-or-human distinction doesn't matter here — both benefit from "here's what to type next" more than from `{results: []}`.

### Sequencing

1. **Known topics extraction** — build the topic vocabulary (independent, shippable now).
2. **Input classifier module** — `classifyQuery()` with unit tests on a real-query corpus, not yet wired into search.
3. **`searchAll()` wrapper** — wraps existing `searchPages` and runs classifier side queries in parallel. New response shape.
4. **`routeros_search` MCP tool + TUI `s` command** — both wired to `searchAll`. TUI renders `related` sections as numbered, navigable items.
5. **Tool consolidation follow-through** — once `routeros_search` answers most multi-source questions, revisit whether `routeros_search_videos`, `routeros_search_callouts`, `routeros_search_changelogs` survive (see "Needs Input" below).

### What this replaces in the old backlog

- "Unified search entry point"
- "`routeros_search` cross-table awareness"
- "Tool count and MCP client tool-list limits" (the consolidation step)

### Decided consolidation target (2026-04-10 review)

A baker's dozen is the ceiling, not the goal. If customers are only eating half a dozen, we bake bigger, better cookies and offer fewer, more diverse ones. Target: 14 → ~8–10 tools after the North Star ships.

**Definitely fold into `routeros_search` side queries (drop as standalone MCP tools):**

- `routeros_search_properties` — useless without command-tree context (see Principle 4). Data stays in the schema because it's the likely feeder for restraml's `deep-inspect.json` enrichment.
- `routeros_search_callouts` — fold into the `related.callouts` side query. Keep the `type`-only browse capability as a TUI command, but not as an MCP tool.
- `routeros_search_videos` — fold into `related.videos`, and treat videos as a **locator, not a source** (see "Video metadata quality signals" below).

**Keep as standalone drill-downs** (their filter surface doesn't fit a uniform search response):

- `routeros_search_changelogs` — version range + category + breaking-only filters are too specific. Surface top-3 pre-filtered entries in `routeros_search.related.changelogs`, but keep the dedicated tool for actual range queries.
- `routeros_search_tests` — packet-size + config-filter combinatorics don't belong in a search response. Benchmarks are a distinct workflow.
- `routeros_device_lookup`, `routeros_get_page`, `routeros_command_tree`, `routeros_command_version_check`, `routeros_command_diff`, `routeros_lookup_property`, `routeros_stats`, `routeros_current_versions` — each is a well-defined drill-down.

**Name:** keep `routeros_search`. Semantic drift is cheaper than a rename that breaks existing client configs.

**The hidden consolidation win:** `routeros_get_page` becomes smarter (see "Smart `get_page()`" under Ready to Build). Making it prioritize the semantically valuable parts of a page (properties, callouts, script examples, headings, related videos) means the agent needs fewer follow-up tool calls.

---

## Ready to Build

Clear scope, no blockers, ready to act.

### Known topics extraction

Build a small seed list of topic tokens from three sources:

1. **Changelog categories** — `SELECT DISTINCT category FROM changelogs` gives the subsystem vocabulary MikroTik themselves use.
2. **Command tree top-level names** — `SELECT name FROM commands WHERE parent_path IN ('/', '/ip', '/routing', …)` captures `firewall`, `bgp`, `bridge`, `wifi`, `container`, etc.
3. Optionally, second-level doc path tokens.

Emit as a TS constant or a tiny seed table. Used by the classifier (Principle 3). Shippable immediately — the same list can also drive tool-description examples ("Try querying topics like `bgp`, `wifi`, `firewall`, `container`, `bridge`…") and TUI welcome-message hints.

### Input classifier for `routeros_search` (North Star step 2)

`classifyQuery(input: string): QueryClassification` in `src/query.ts` or a new `src/classify.ts`, with regex detectors for command path, version, device model, property name, and known-topic tokens. Ship with table-driven unit tests. Not yet wired into `searchPages` — just proving the classifier is correct against a corpus of ~30 real RouterOS questions.

**Acceptance signal:** classifier output on the real-query corpus matches manual expectations. When it doesn't, the corpus grows and the detectors are tuned.

### `searchAll()` — multi-table search wrapper (North Star step 3)

Wrap `searchPages` in a `searchAll(query)` that runs classifier side queries in parallel and returns the enriched response shape above. Parallel fan-out is trivial in `bun:sqlite` because the statements are all synchronous. Keep `searchPages` intact for narrow callers.

Wire into both `routeros_search` (MCP) and the TUI's default `s` / bare-text handler. Per Principle 1, neither adapter should duplicate logic.

### Smart `get_page()` — budget-aware section/callout/property prioritization

Today `get_page(max_length=N)` mostly truncates with a simple text/code budget split. When `max_length` is small it should instead **rank-include** the semantically valuable parts of the page before the raw prose:

1. **Properties** — if this page has rows in `properties`, include the property table first. A reader asking about `/ip/firewall/filter` wants the argument list more than the opening paragraph.
2. **Callouts** — inline the Note/Warning/Info content instead of a separate `callouts` array. A warning is higher-signal than the prose around it.
3. **Script examples** — code blocks (we already track `brush: ros`) are among the highest-signal content on a page. Preserve them ahead of ordinary text when budget is tight.
4. **Headings** — include the full heading outline even when body text is truncated, so the agent knows what the page covers and can re-call with `section=...`.
5. **Ordinary prose** — last in line for the budget. Currently first by default; that's backwards.

Secondary behaviors:

- **Synthetic "related videos" section** — if the page title or breadcrumb path matches video titles/chapters via FTS5, attach a `related_videos: [{url, title, timestamp, transcript_source}]` section. Pointer-only — no transcript text. If the transcript is author-provided, hint at the transcript being worth fetching separately; if auto-generated, don't bother hinting.
- **Lower limit defaults for agent-driven use** — the current 16 000 default is generous. When callers pass `max_length=4000` or smaller, the above prioritization kicks in. At default, current behavior (TOC on large pages) stays.

This is the "hidden consolidation" lever: a smarter `get_page` reduces the number of follow-up tool calls an agent needs — properties, callouts, and videos are surfaced in the one call the agent is already making. Core change in `query.ts::getPage()`; TUI and MCP both inherit it for free.

### Drop `routeros_search_properties` as an MCP tool

Per the consolidation decision and Principle 4: the tool is worthless without command-tree context, and property descriptions are largely inferable from names. **Data stays** — it's a likely input to restraml's `deep-inspect.json` enrichment pipeline and the four-part schema split we'll do later.

**Ship steps:**

1. Remove the tool registration in `src/mcp.ts`.
2. Keep `searchProperties()` in `query.ts` so the TUI `props` command keeps working — it's still a human-useful browse.
3. Keep `routeros_lookup_property` — exact-name lookup with a `command_path` filter is different; it's still useful when you know the property name.
4. Document in tool description that property info is available via `routeros_get_page` (once smart `get_page` lands — property tables surface in the page response).

### Video metadata quality signals

Autogenerated YouTube transcripts are weak on technical terms. Today the MCP tool returns transcript snippets without indicating quality. Three fixes:

1. **Store `transcript_source`** — add a column on `videos` (or `video_segments`): `'auto' | 'author' | 'none'`. `yt-dlp` exposes this during extraction. Backfill during next `extract-videos` run.
2. **Surface quality flags in results** — each video result carries `{ transcript_source, upload_date, view_count }` so agents can reason ("this is an auto-caption, treat as a pointer to the video, not a quote") and humans can visually weight them. The age/view count are explicit "trust this less for obscure topics, and the LLM may already have seen it in training on high-view videos" hints.
3. **Treat videos as a locator, not a source.** Rewrite the `routeros_search_videos` tool description (and TUI `videos` help). When `routeros_search` returns videos in `related.videos`, include URL + title + timestamp by default; only include a transcript excerpt if `transcript_source === 'author'`. Surface the video URL to the user in all cases — that's the actionable output.

### `routeros_search_tests` device filter (finish the job)

`DeviceTestFilters` gets a `device` / `product_name` field (LIKE match against `devices.product_name`). Both the TUI `tests` command **and** the MCP tool accept it. Per Principle 1, this is a core change in `query.ts` with two thin adapter updates.

The TUI half shipped in Phase 3 (`tests rb5009 ethernet 1518`). Verify whether the MCP tool + `searchDeviceTests()` signature were updated too; if not, finish the job.

### Browse REPL — paging for `[X more results]`

`[XX more results...]` isn't actionable. Bump default TUI limits (e.g., to 20) and let the existing pager handle display. A `more` / `next` command can come later if it's still needed.

### Browse REPL — pass-through search parameters

`cl 7.21..7.22 iot` already works for changelogs. Add a general flag parser for TUI commands (`--limit`, `--version`, `--breaking`, `--category`) so the TUI can exercise the same surface as MCP clients. Keeps Principle 2 honest (the TUI *is* the MCP surface for humans).

### HTML extraction: preserve more signal tokens

Page text from `getPage()` is currently near-raw text — blank line between headings landed in a prior fix, but almost nothing else survives extraction. Signals worth preserving in `extract-html.ts`:

- **Headings** — prefix with `#`/`##`/`###` (matching level), *and* wrap in `**bold**`. Gives both markdown parsers and plain-text readers a clear cue. Current state is borderline unreadable in the TUI.
- **Lists** — keep `-` for `<ul>` items, numbered `1.` for `<ol>`.
- **Emphasis** — `<strong>` → `**bold**`, `<code>` → backticks. Low cost, high signal; today they're silently stripped.
- **Script example demarcation** — code blocks already track `brush: ros` but the current extraction flattens them into a separate `code` field. Consider inlining them back into the text field as fenced blocks (```` ```routeros ... ``` ````) so they appear in-line with surrounding prose, matching how the docs are actually structured.

Affects TUI readability and MCP tool output equally — classic Principle 1 core change. Pairs with the "Smart `get_page()`" item: once script examples are properly fenced in the text stream, the budget-aware prioritizer can identify and preserve them.

**Caveat:** keep an alternate plain-plain-text path (simple regex strip) for any consumer that wants unformatted text. Most won't.

### TUI — search-in-results (vi-style `/`)

Add `/pattern` to the browse TUI, following vi / less / `man` convention: when viewing any rendered result set (search results, page body, property list, command tree, device cards, changelog entries), `/foo` filters or highlights matches inline. `n` / `N` for next/previous. Core lives in `browse.ts` since it's a display concern, but the matcher should reuse the same tokenization as `extractTerms()` so "search within results" behaves consistently with the main search. Useful daily for humans; doubles as a test of result-set completeness.

### Standalone binaries: clarify internal-only use case

Cross-compiled binaries (`rosetta-macos-arm64.zip`, etc.) exist in releases but there's no real user-facing use case — if you can run the binary you can install Bun and run `bunx @tikoci/rosetta` instead, which is what we already recommend. The binaries' actual role is **internal**, inside OCI images (`Dockerfile.release` bakes the compiled binary for fast container startup).

**Action:** update `README.md` and `MANUAL.md` to reflect that compiled binaries are primarily an internal build artifact. The existing "Option C" install path stays as a documented fallback for people who can't install Bun for whatever reason, but it's deprioritized in the tester workflow guidance. Don't remove the build — it's load-bearing for the OCI image — just stop leading with it in user-facing docs.

---

## Needs Input / Design Decision

Items where the design isn't obvious enough to just build. Flagging for user review.

### Direct SQL access — schema-as-resource or a constrained `run_sql` tool

**The pull:** agents (and humans) using rosetta from inside a project directory will often just shell out to `sqlite3 ros-help.db 'SELECT ...'` rather than call the MCP server. Claude Code does this reliably once it notices the file. Any query of the form "give me all X" (all changelog entries for 7.22, all devices with PoE out, all pages linking to `/routing/bgp`) is one SQL round-trip instead of many tool calls + context burn.

**The argument against over-engineering:** there's nothing sensitive in this DB. The usual "exposing SQL is dangerous" concerns don't apply to a read-only corpus of public documentation.

**Options, least to most invasive:**

1. ~~**Schema-as-resource** — expose the schema DDL as an MCP resource (`rosetta://schema.sql`) plus a short `rosetta://schema-guide.md` explaining table relationships, FTS5 tokenizer differences, and good-query patterns. Agents that want to construct SQL can read this once and know what they're looking at. Zero runtime exposure, pure documentation.~~ **Done** — `rosetta://schema.sql` (live DDL from sqlite_master) and `rosetta://schema-guide.md` (guide covering table relationships, FTS5 tokenizer differences, BM25 weights, join patterns, and gotchas).
2. **Read-only `rosetta_query_sql(sql)` tool** — opens a second connection with `mode=ro`, executes the query, returns rows. Enforced via connection URI (`file:ros-help.db?mode=ro`), not a query parser. Still a meaningful attack surface if we ever add write tables, but at the current data shape it's effectively safe.
3. **Write-password gate** — wrap the main (read-write) connection behind a password required only for schema-modifying statements. The "password" is a constant derived from the codebase (e.g., a hash of `server.json` version), so it's not a real secret, just a tripwire against agents that try `DROP TABLE` or `UPDATE pages SET ...`. Corruption prevention, not security. Makes option 2 more tenable.

**Trade-off to weigh:** ~~option 1 is free and already consistent with how CSV resources work.~~ Option 2 eats some of the "shell out to sqlite3" motivation but at the cost of another tool in the catalog — exactly what we're trying to shrink. Option 3 is cheap but opinionated.

**Straw-man recommendation:** ~~ship option 1 now;~~ revisit option 2 only if (a) usage data shows `sqlite3` shell-out is happening a lot and (b) the classifier/`searchAll` path proves insufficient for those queries. A CSV export from the TUI (`export csv` over the current view) handles the "make a CSV of all release notes" case without touching MCP at all.

### How to express "looks like a command, but syntax might be wrong"

Per the classifier: when we detect a command-shaped query (`/ip/firewall/filter add chain=forward`) but it doesn't validate cleanly against `commands`, we want to return something like:

> "This looks like a `/ip/firewall/filter` command. The path exists; the `chain` argument couldn't be confirmed for this command in 7.22 — it may still be correct in older versions or as a historical shorthand. Verify with `routeros_command_version_check`."

We should **never** tell the agent "this is wrong." We should say "this is not obviously correct; here's what I can confirm and here's what I can't." Needs careful tool-description wording before building.

### TUI session log as a classifier corpus

If `browse` is first class and mimics the MCP tool-call chain, a session transcript (queries + responses) becomes a corpus for evaluating the classifier and tuning tool descriptions. Opt-in, local-only. Related to but distinct from the "Usage analytics" improvement below.

**Open question:** build this before or after the North Star lands? Building it now gives us an evaluation corpus for the classifier work; building it later avoids churn.

### Property name-matching strategy in `routeros_search`

Current `lookup_property` is exact-match. Observed gap: agents (and humans) often have a half-remembered property name. Should `routeros_search` auto-run a fuzzy property match when the input looks like a single lowercase token? Risk: false positives drown real page results. Mitigation: fire only when the token doesn't match any page title or command path. Needs a call on the false-positive tolerance.

---

## To Investigate

Items that need research or experimentation before they're actionable.

### Device AKA matching — Phase 2 (renames requiring an alias table)

After Phase 1 + 1.5, the remaining failure is genuine renames like `hex 2024` → `hEX refresh`. Needs a small `device_aliases (alias TEXT, device_id INTEGER)` table, seeded with known renames. Keep it small — only aliases that can't be derived from names/codes/slugs.

**Trigger:** address when a user reports false-empty on a renamed product or when a new product ships with a renaming pattern. Not worth building speculatively — device lookup matching is explicitly heuristic, not a solved-identity problem.

### List-format properties (496 across 73 pages)

8.8% more properties available from `<ul><li><strong>name</strong> (type; Default: value)</li></ul>` lists on pages like Queues, Hotspot, RADIUS. Integrate as a second pass in `extract-properties.ts` using the same `properties` table schema. The pattern is regular enough for reliable parsing. Queues, Hotspot, and RADIUS alone justify the effort.

### Special hardware pages

Several pages contain device-specific tables that are the only structured source for "does this router actually support X":

- **Switch Chip Features** (`ROS/pages/15302988`)
- **Marvell Prestera** (`ROS/pages/30474317`)
- **Bridging and Switching** (`ROS/pages/328068`) — RouterBoard/Switch Chip Model table
- **Peripherals** (`ROS/pages/13500447`)

Worth extracting into dedicated tables or enriching device data. If MikroTik renames/moves these, that's a signal "something important changed."

Note: absence from Peripherals doesn't mean unsupported — most MBIM modems work without being listed.

### inspect.json extra-package coverage gaps

Known gaps (CHR-based inspect.json): WiFi driver packages (`wifi-qcom`, etc.) absent; LoRa + IoT GPIO have linking gaps; ZeroTier and scripting builtins missing/under-linked.

**Actionable now, independent of restraml:**

1. Tool description hints on `routeros_command_tree` noting the gaps and suggesting `routeros_search` as fallback.
2. Targeted linking pass for WiFi, LoRa, scripting — the 92% dir coverage stat masks much lower coverage for these high-value subsystems.
3. Extract the definitive package list from the `Packages` doc page into a `packages` table so agents can get a clear "these packages are not in the command tree" signal.

### MikroTik /app auto-update behavior

`/app` YAML supports `auto-update: true`, set in our rosetta template. Initial testing on CHR 7.23beta5 confirms install/run. Unverified: does RouterOS pull `:latest` fresh on each boot, or cache by digest? Does it require `docker-tag-based-pulling` or `checking-for-updates`? Needs multi-reboot test with images pushed between reboots.

### MCP resources beyond current CSVs

Shipped: `device-test-results.csv`, `devices.csv`. Candidates to add:

- Raw product matrix CSV (as published by MikroTik, not the normalized version)
- Versioned inspect.json dumps
- RouterOS RAML/YAML schema (once restraml ships it)

Resources are for explicit attachment, not tool-call substitution — don't overinvest.

### Cross-reference with forum data

The MikroTik forum archive (`~/Lab/mcp-discourse`, also SQL-as-RAG with FTS5) could cross-search with official docs. Open design: same DB vs. separate MCP tools vs. query-time federation. No action until the forum archive is stable **and** the North Star classifier is in place — the classifier may be the natural plug-in point for a secondary retrieval source.

### Debounce inspect.json fetches in `extract-all-versions`

~48 sequential GitHub Pages fetches. Not urgent (GitHub Pages has no rate limit) but a concurrency-limited prefetch would cut extraction time. Low priority.

### ETL pipeline streamlining

The extraction pipeline works but it's messier than it should be. Each data source has slightly different semantics — mix of local files (HTML archive in `box/`, product matrix in `matrix/`), GitHub-fetched (inspect.json from restraml), HTTP-scraped (product pages, changelogs), and yt-dlp (videos). Some extractors are in the `make extract` / `make extract-full` chain; `extract-videos` is excluded because it needs `yt-dlp`; CI uses `extract-videos-from-cache` instead. Clean-slate rebuild isn't quite a 1-2-3 process.

**Observed friction:**

- Different idempotency semantics across extractors (DROP+CREATE vs DELETE vs UNIQUE constraint)
- Local vs CI path divergence for videos specifically
- No single "is the DB healthy?" check beyond `routeros_stats`

**Not urgent** — the TUI gives humans enough visibility to catch issues ("data should be there; isn't"), and CI runs the full pipeline regularly. But a future cleanup pass should unify the idempotency pattern, add a `make doctor` or `rosetta --check` command that validates row counts and FK integrity, and document the expected state after each extractor in one place.

### Product matrix CSV automation

No stable direct-download URL. A GitHub agent could potentially navigate, export, and PR the updated CSV. Low priority — manual export happens quarterly and works.

### macOS code signing and notarization

Documented workaround is sufficient; full signing needs a $99/year Apple Developer Program membership. Bun-based install avoids the issue. Revisit only if compiled binaries see wider distribution.

### SafeSkill residual scan items

Prior review closed the real findings (shell injection in `build-release.ts`, added `SECURITY.md`). Remaining low scores are metric artifacts ("Code quality 1/5", "Transparency 3/7"). Not worth chasing. Revisit only if a new real finding surfaces.

---

## Deferred (waiting on a trigger)

Items explicitly postponed until a trigger condition is met.

### Dependency on restraml — `deep-inspect.json` completion data (Principle 4)

**Blocking:** `deep-inspect.json` with populated `_completion` fields (enum choices, type hints, validation). As of 2026-04-04 the file exists from 7.22.1 / 7.23beta4 forward, but `argsWithCompletion: 0` — structure present, content empty. restraml iteration speed is the bottleneck, and their unblock depends on quickchr maturing.

**What to do now (safe, cheap cleanup):**

1. Capture `_meta.version` and `_meta.generatedAt` from `deep-inspect.json` in `ros_versions` for provenance.
2. Prefer `deep-inspect.json` over `inspect.json` in the extraction order wherever a version has both.

**What's blocked until `argsWithCompletion > 0`:**

1. Extending the `commands` schema with argument enum values (schema design happens *then*, when we know the data shape).
2. Wiring completion values into the classifier — property-name matches offer valid enum values. This is where the cross-project payoff lands.

**What not to do now:** no speculative schema changes or abstractions anticipating deep-inspect's final shape. Light cleanup only.

### MCP Registry publish automation

`server.json` and CI validation are in place. Release-time publication to `registry.modelcontextprotocol.io` deferred until CI namespace auth is configured (`mcp-publisher login github-oidc` or DNS/HTTP method with secrets).

**Trigger:** CI auth method finalized and secrets configured. Then: add publish step to `release.yml` after `npm publish`; sync `server.json` version from the release tag (`vX.Y.Z` → `X.Y.Z`); fail the release if publish fails; verify via registry search API for `io.github.tikoci/rosetta`.

### OCI image armv7 support

Current CI builds linux/amd64 + linux/arm64 via `docker buildx`. armv7 deferred for **two independent reasons** — documenting both because PR requests for armv7 are likely and "Bun doesn't support it" alone sounds like a temporary excuse:

1. **Bun doesn't target armv7.** Bun's single-file compile (`bun build --compile`) has no armv7 target. Until that changes, there's no way to produce the binary the OCI image needs.
2. **MikroTik `/app` doesn't support armv7 either.** The `/app` container framework (the layer above `/container`) is x86_64 and ARM64 only. MikroTik `/container` supports armv7, but our primary router-admin deployment path is `/app`. So even if Bun shipped armv7 tomorrow, rosetta-on-armv7-RouterOS wouldn't have a home through the router UI.

**Trigger:** *either* reason being resolved isn't enough — both need to flip. Realistically this means Bun + MikroTik both catching up. When that happens, add `linux/arm/v7` to the buildx `--platform` flag and a case to the `TARGETARCH` switch in `Dockerfile.release`.

### Documentation version tracking

**Trigger:** second HTML export is available. Then add a `doc_exports` metadata table (date, page count, text hashes). Simple diff — don't overengineer. Watch the special hardware pages above for renames/moves; those are the "something important changed" signal.

### Copilot context provider via `lsp-routeros-ts`

VS Code extension client-side can provide doc context via MCP or direct DB queries. Depends on `lsp-routeros-ts` integration maturing.

### Cross-DB federation with forum archive

Depends on the forum archive being stable and the North Star classifier being in place as a plug-in point. See "Cross-reference with forum data" under Investigate.

---

## Improvements (smaller items, not urgent)

### Changelog tool: compact summary mode and version-range output size

Observed in a real Copilot CLI session: querying 7.21.3 → 7.22.1 produced 802 lines / 23.2 KB of JSON — Copilot CLI saved it to a temp file as "too large to read at once." Issues:

- **Output too verbose** — each entry returns full `description` + `excerpt` + `released`. For range queries this wall-of-JSON repeats. Compact summary mode: group by version then category, with counts and descriptions only (no excerpt duplication).
- **`limit` max of 100 is too low for range queries** — raise to 200–500, or make grouped-summary the default when `from_version != to_version`.
- **No `exclude_from` parameter** — range queries re-include `from_version` entries the user already has. Add an `exclude_from` flag or make `from_version` exclusive.

### Usage analytics — which tools do agents actually call?

Local-only `usage_log` table, opt-in via `ROSETTA_LOG_USAGE=1`. Tracks tool invocations, empty-result rates, query terms, and tool-chaining patterns. Data-driven consolidation decisions. **Becomes more important after the North Star ships** — we'll want to see whether the consolidated `routeros_search` actually replaced the specialized tools in practice.

Privacy constraints: no outbound network; disabled by default; single `INSERT` per call into a local `usage_log` (separate `usage.db` to avoid bloating the main DB). `routeros_stats` can optionally include a usage summary.

### Agent-assisted linking for remaining ~8% of command dirs

Targeted manual review of WiFi, LoRa, scripting could close the highest-value gaps without a full linking overhaul. Pair with the "inspect.json extra-package coverage gaps" item above.

### LSP integration

`lsp-routeros-ts` hover handler should consume property data from this DB. Needs a `routeros.helpDatabasePath` settings field on the consumer side. The data is ready; the consumer needs work.

### Browse REPL — lower-priority wishlist

- **Tab completion** — command names + path prefixes from the `commands` table via readline's completer callback.
- **History persistence** — `~/.rosetta/browse_history` so queries survive across sessions.
- **Raw SQL mode** — `sql SELECT …` behind `--allow-sql`.
- **Export** — `export <format>` dumps the current view as JSON / CSV / Markdown.
- **Audit views** — data-quality commands: unlinked commands, pages with no properties, devices with no test results. These double as a test surface for the MCP side.
- **Bookmarks** — save frequent queries/pages to `~/.rosetta/bookmarks.json`.

### Video extraction — periodic retry for consistent-fail set

143 videos fail consistently across passes (likely rate-limited rather than permanently gone; gradual 154 → 149 → 143 improvement across 3 passes suggests slow anti-bot relaxation). Re-run `make extract-videos` after 48–72h gaps; add to `transcripts/known-bad.json` with reason if a video fails 4+ times over several days.

The 84 no-transcript videos are stored successfully as metadata-only; they're a different case from "failed." Many are old MUM conference talks with no auto-captions.

---

## Recently Done

One-liners for continuity; delete entries after a release cycle passes. Details live in git history and `CLAUDE.md`.

- Section-level page chunks (TOC + `section` param on `get_page`)
- Device/product data Phase 1 + Phase 2 (devices, test results, block diagrams)
- Device AKA matching Phase 1 + 1.5 (separator/slug/superscript normalization + disambiguation notes)
- Product page slug coverage via sitemap + override table (144/144)
- Command diff tool (`routeros_command_diff`)
- HTTP transport (Streamable HTTP via `--http`, optional TLS)
- npm package (`bunx @tikoci/rosetta`) with three-mode path resolution
- DB schema version check for auto-updates
- MikroTik YouTube transcript extraction + CI import from committed NDJSON cache
- Video title + device superscript normalization (both `videos_fts` and `devices_fts`)
- Browse TUI Phase 3 — context-aware prompts, number navigation, device filter on `tests`, MCP tool names in `help`, RouterOS-style pager footer, code-block indentation
- Fixed CI workflow (in-memory SQLite tests, re-enabled push/PR triggers)
- `make extract-videos-from-cache` step in `release.yml`
- SafeSkill security scan review — shell-injection fix in `build-release.ts`, added `SECURITY.md`
- `extract-devices` FK failure on non-clean DB — delete `device_test_results` rows first in `extract-devices.ts` before deleting `devices`; keeps extractors idempotent on an existing DB
- `routeros_current_versions` + TUI `ver` — WinBox 4 version added (fetch `LATEST.4` in parallel with channels; `winbox` field in response; rendered in TUI)
- `getDbStats()` enhancements — `db_size_bytes` + `schema_version` added; TUI `stats` renders size in MB and schema version
- `actions/checkout` v4 → v5 in `test.yml` and `release.yml` — Node 24 support, ahead of June 2026 Node 20 deprecation
