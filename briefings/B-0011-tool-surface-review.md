---
id: B-0011-tool-surface-review
topic: Audit the 14-tool MCP surface for consolidation candidates
status: open
related_tasks: ["#131", "#132", "B-0001", "B-0024", "#54", "#222", "#223", "#224"]
created: 2026-05-02
last_revisited: 2026-10-28
---

# Question

Are any of the current 14 MCP tools redundant, under-used, or candidates for consolidation into the unified `routeros_search` or `routeros_explain_command` surface?

# What's grounding this

- 14 tools today: `routeros_search`, `_get_page`, `_lookup_property`, `_explain_command`, `_command_tree`, `_search_changelogs`, `_command_version_check`, `_command_diff`, `_device_lookup`, `_search_tests`, `_dude_search`, `_dude_get_page`, `_stats`, `_current_versions`.
- North Star principle: prefer one tool with a `related` block over many narrow tools.
- Already consolidated: `routeros_search_callouts` and `routeros_search_videos` were folded into `routeros_search.related` (see T-0001).
- Frozen by `EXPECTED_TOOLS` in `src/mcp-contract.test.ts` — adds/removes are intentional.

# Candidates worth examining (initial list, not conclusions)

- **`routeros_command_version_check` vs `routeros_command_diff`** — both are version-aware; could one be an option on the other?
- **`routeros_dude_search` + `_dude_get_page`** — separate surface for a separate (small) data source. Right call, or worth folding? Per `B-0005`'s 2026-07-14 lean, the direction is fold-after-audit: merge Dude results into `routeros_search` behind an opt-in arg once a Dude-extraction accuracy audit confirms it's safe, then retire these two tools.
- **`routeros_stats` vs `routeros_current_versions`** — both are health/metadata; could become one `routeros_about` tool?
- **`routeros_lookup_property`** — per `B-0001`'s 2026-07-14 decision, the lean is **retirement** from
  the MCP/TUI surface, not a broad-mode addition: fold exact lookup into `routeros_get_page` (surface
  page-extracted properties) and `routeros_command_tree` (point at related paths). The extraction ETL
  behind it stays — manual.mikrotik.com prose is still the only source of narrative property
  descriptions. This audit should turn that lean into a concrete fold/deprecation plan.

  **Precondition added 2026-07-31 — do not schedule this fold yet.** The #131/#132 triage measured
  `lookupProperty` and found its `high | medium | low` signal miscalibrated in both directions (`high`
  on column-shifted Apps/VETH rows, `low` on correct bridge rows). Both fold targets sit on the *wrong
  side* of the broken `commands.page_id` join — `get_page` is page-scoped and assumes the page is right;
  `command_tree` reads that same fuzzy link — and neither can express the uncertainty the tool currently
  reports. Folding now would launder it. Order of operations: **fix the join, recalibrate confidence,
  then decide the surface.** See `briefings/B-0024-command-prose-join.md` and B-0001's revisit trigger.
  This does not change the lean; it blocks acting on it until B-0024 step 3 has data.

  **2026-10-04: the premise above moved.** "manual.mikrotik.com prose is still the only source of
  narrative property descriptions" is no longer true: MikroTik moved many property tables into the CLI
  Reference, and #170 / #171 answer from it (B-0025). For the menus the CLI Reference covers, an exact
  (menu, field) row *is* the join, so the B-0024 precondition may no longer be what gates this fold.
  Whether to retire, keep, or reshape `routeros_lookup_property` is now B-0025's "B as end state or D"
  question, to be decided with cross-repo planning (centrs owns exact validation, lsp-routeros-ts
  consumes descriptions), not in isolation. 0.12 scope.

# Method for the audit

1. For each of the 14 tools, write 2–3 lines: what it does uniquely, what overlaps with `routeros_search.related`, frequency of expected use.
2. For each pair flagged above, sketch what consolidation would look like (param shape, deprecation path).
3. Conclude: tools to keep, tools to fold, no-change tools. Each fold spawns a `T-*.md`.

# Why this is a briefing, not a task

This is a "double-check on current think" — the answer might be "all 14 are right." Promoting it to T-*.md upfront would commit to changes before we know which (if any) are warranted. The audit briefing is the work product if no consolidation is recommended.

# Open questions

- What signal do we have about real-session tool usage frequency? Today: none. Worth opt-in logging (see B-0010 → "opt-in TUI/usage logs") to inform this kind of audit?

# TUI ↔ MCP parity inventory (2026-10-28, #54)

Read-only inventory of the current surfaces; no behavior conclusions beyond the
gap markings. Grounded in `main` @ `7eb706d` (post-#217): `server.registerTool`
call sites in `src/mcp.ts`, `dispatch`/`dotTools` in `src/browse.ts`, and
`EXPECTED_TOOLS` in `src/mcp-contract.test.ts`. The tool count is still 14 —
the historical number in this briefing holds — and the `dotTools` key set was
statically diffed against `EXPECTED_TOOLS` (14 == 14, no drift).

Headline: the raw parity contract holds. All 14 tools are reachable via
`browse --once .<tool>` with `key=value` args (pure JSON on stdout per
`V-cli-once-json`); 12/14 dot-tools carry a `tui:` hint to a named command and
2/14 (`routeros_explain_command`, `routeros_dude_get_page`) are dot-only. Named
TUI paths are uniformly narrower than dot paths — same query core, fewer
expressible args.

## One row per MCP tool

"Gaps" marks each gap **intentional** or **candidate-work** (#224 tracks the
candidate set; #222/#223 track the two broken items).

| # | MCP tool (`src/mcp.ts`) | Args (types/defaults) | Named TUI path (`src/browse.ts`) | Dot-command | Gaps |
|---|-------------------------|-----------------------|----------------------------------|-------------|------|
| 1 | `routeros_search` (:706) | `query` string req; `limit` int 1–50, default 8 | `search`/`s`/bare text — query only, limit fixed at 8 (:1596, :1925) | `.routeros_search <q> limit=` — full | candidate-work: named `limit` (#224) |
| 2 | `routeros_get_page` (:768) | `page` string req; `max_length` int ≥1000, default 16000; `section` string opt | `page <id\|title>` — page only (:1602); section via interactive number-select (:1767) | full, plus `id=` alias | candidate-work: named `section`/`max_length` (#224) |
| 3 | `routeros_lookup_property` (:832) | `name` string req; `command_path` string opt | `prop`/`p <name>` — name only; `command_path` auto-scoped from page ctx, and only when ctx is a non-section page (:1973) | full (`name=`, `command_path=`) | candidate-work: explicit `command_path`, sections-ctx scoping (#224) |
| 4 | `routeros_explain_command` (:907) | `command` string req; `ros_version` opt; `model` opt | NONE — `explain …` falls through to search (:1752) | full | candidate-work: named command, or document dot-only (#224) |
| 5 | `routeros_command_tree` (:962) | `path` default `""`; `version` opt; `arch` opt | `cmd`/`tree [path]` + `@version` suffix (:2033); relative nav, leaf version card; no `arch` | full (`path=`, `version=`, `arch=`) | candidate-work: named `arch` (#224); relative-nav/leaf extras intentional |
| 6 | `routeros_stats` (:1020) | none | `stats` (:1592) — counts, provenance, grounding; no skills | `.routeros_stats` — **omits the `skills` block the MCP tool adds** (:1050) | broken parity, filed as #223 |
| 7 | `routeros_search_changelogs` (:1092) | `query` default `""`; `version`; `from_version` (EXCLUSIVE); `to_version`; `category`; `breaking_only`; `limit` default 50, max 500 | `changelog`/`cl` — terms, single version, `A..B` range, `breaking` keyword; no `category` (dead var, :2180), limit fixed 50 (:2172) | full | candidate-work: named `category`/`limit` (#224); named `A..B` is inclusive on both ends while MCP `from_version` is exclusive — document-or-align decision needed (#224) |
| 8 | `routeros_dude_search` (:1185) | `query` string req; `limit` int 1–20, default 8 | `dude <query>` — limit fixed at 10 (:2234) | full | candidate-work: confirm 10-vs-8 default difference intentional or align (#224) |
| 9 | `routeros_dude_get_page` (:1232) | `id` int-or-string req; `max_length` default 16000 | NONE as a command; interactive number-select on `dude` results opens the full page (:1798) | full | candidate-work: named view, or document dot-only (#224) |
| 10 | `routeros_command_version_check` (:1278) | `command_path` string req | `vcheck`/`vc` — full (:1739) | full | none |
| 11 | `routeros_command_diff` (:1315) | `from_version`, `to_version` req; `path_prefix` opt; `arch` opt | `diff <from> <to> [path]` — no `arch` (:1729) | full | candidate-work: named `arch` (#224) |
| 12 | `routeros_device_lookup` (:1382) | `query` default `""`; `architecture`, `min_ram_mb`, `license_level`, `min_storage_mb`, `has_poe`, `has_wireless`, `has_lte`; `limit` default 10 | `device`/`dev <query>` — query only, default limit (:1668) | full, incl. filter-only calls | candidate-work: named filters (#224) |
| 13 | `routeros_search_tests` (:1517) | `device`, `test_type`, `mode`, `configuration`, `packet_size` all opt; `sort_by` default `mbps`; `limit` default 50 | `tests [device] <type> [mode] [packet_size]` positional (:2110); bare `tests` mirrors MCP discovery; no `configuration`/`sort_by`/`limit` | full | candidate-work: named `configuration`/`sort_by`/`limit` (#224) |
| 14 | `routeros_current_versions` (:1638) | none | `versions`/`ver` — full (:1746) | full | none |

## One row per TUI-only capability

`tui-mcp-parity` allows the TUI to be richer, so most rows below are
intentional asymmetry — the question column is whether an MCP counterpart is
warranted.

| TUI capability (`src/browse.ts`) | MCP counterpart? | Gap marking |
|----------------------------------|------------------|-------------|
| `props`/`sp` FTS property search (:1648) | partial — exact-lookup tool + `related.properties` in search | intentional; no dedicated MCP FTS tool warranted, `related` covers discovery |
| `glossary`/`g` (:1655) | partial — `related.glossary` | intentional; same rationale |
| `callouts`/`cal` (:1680), incl. no-arg page-scoped form | partial — `related.callouts` + `get_page` callouts | intentional |
| `videos`/`vid` (:1705) | partial — `related.videos` | intentional |
| `skills`/`skill` (:1718) | YES — `rosetta://skills…` MCP resources | full parity via resources, not tools; but the `skill <name> refs` hint (:2290) is broken — filed as #222 |
| `view`/`v`, `back`/`b`, `help`/`?`, `quit`, number-select, no-arg `page`/`prop` re-render | none — navigation/session chrome | intentional; no MCP counterpart warranted |
| meta dot-commands `.help`/`.tools`/`.?`, `.instructions`, `.resources`/`.refs` (:1421) | n/a — they describe the MCP surface itself | intentional |
| `browse <cmd>` shell passthrough + `--once` (dot → pure JSON per `V-cli-once-json`; named → plain text when piped per #216) | n/a — invocation mode, not a capability | intentional |

## MCP-only surface (no TUI path)

The dataset/schema MCP resources have no TUI command:
`rosetta://datasets/device-test-results.csv`, `rosetta://datasets/devices.csv`,
`rosetta://schema.sql`, `rosetta://schema-guide.md` (`src/mcp-meta.ts`). The
parity rule covers tools, not resources; bulk-export and schema introspection
are machine-oriented and human equivalents exist (`tests`, `device`, `stats`).
Marking: **intentional**, recorded here for completeness.

## Cross-check against `browse-parity.test.ts`

The test enforces listing only: `.help` JSON tool names equal
`EXPECTED_TOOLS` (and it is DB-gated — it skips without `ros-help.db`, so the
raw contract is unenforced on DB-less runs). The table above finds enforcement
gaps the test does not cover — candidate test additions, listed but NOT
implemented here, tracked in #224:

- each listed dot-command actually executes (not just listed);
- dot-command paths accept/round-trip every MCP arg for that tool;
- `tui:` hints in `dotTools` resolve to a real `dispatch` case (12/14 today;
  explain + dude-get-page intentionally hint-less);
- dot-vs-MCP response-shape equivalence (would have caught the #223 class);
- `--once` pure-JSON purity for all 14 tools (`browse-once.test.ts` covers
  stats/search only);
- the human `.help` text hard-codes "all 14 tool dot-commands" (:1194) —
  drift risk if the registry changes without touching help.

## Follow-ups filed

- #222 — `skill <name> refs` advertised but unimplemented (broken TUI hint).
- #223 — `.routeros_stats`/named `stats` omit the MCP `skills` block.
- #224 — candidate-work tracker: named-path arg gaps + candidate test
  additions above. #27 stays closed per the #54 acceptance criteria.
