# Changelog

All notable user-visible changes to `@tikoci/rosetta` are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); project
uses [Semantic Versioning](https://semver.org/).

> **Agentic rule.** Any change with a user-visible effect (CLI, MCP tool shape,
> DB schema, CI behaviour, install flow) adds an entry under **[Unreleased]**
> in the same PR / commit. The release workflow promotes `[Unreleased]` to a
> dated version header. CI-only auto-bumps and pure refactors with no external
> effect are intentionally omitted — git history is authoritative for those.
>
> **Not a git log.** Don't list every commit. One bullet per behaviour change,
> grouped under `Added` / `Changed` / `Fixed` / `Removed` / `Deprecated` /
> `Security`. Details and rationale belong in `DESIGN.md`; the "what's next"
> backlog belongs in `BACKLOG.md`.

## [Unreleased]

### Changed

- **MCP search/property confidence metadata:** `routeros_search.classified`
  now includes `command_path_confidence`, and `routeros_lookup_property`
  rows include `confidence` (`high`/`medium`/`low`) to distinguish scoped
  command-page matches from global fallbacks.
- **CI release hygiene:** the `Release` workflow input formerly named
  `force` is now `republish_assets`, making clear that it reuploads GitHub
  Release assets / OCI tags while skipping immutable npm publication. Release
  CI also runs `bun test` in the early fast-fail gate before downloading the
  HTML export while preserving the post-extraction DB-wipe guard.
- **DB retention:** release builds now run `make gc-versions` after command
  linking to prune `schema_node_presence` to active RouterOS channel heads
  (stable, long-term, testing, development). Full command-version history and
  changelogs remain untouched.
- **Tool descriptions: `routeros_stats` and `routeros_current_versions`
  now follow the workflow-arrow (→) convention.** `stats` suggests
  `→ routeros_search`; `current_versions` suggests
  `→ routeros_search_changelogs` with a `from_version`/`to_version`
  hint. The Phase 2 contract test's `KNOWN_EXCEPTIONS` allow-list is
  removed — every registered tool now carries a follow-up arrow.

### Added

- **`routeros_explain_command` MCP tool:** read-only CLI command explanation
  with canonical path/verb, argument property matches, warnings, docs,
  changelogs, version check, and TUI dot-command parity.
- **`canonicalize.ts`: pluggable verb resolver, `extractMentions()`,
  per-command confidence flag (issue #5 — H4, H6, H8).**
  - `CanonicalizeOptions { isVerb?: (token, parentPath) => boolean }` lets
    callers plug in a path-aware verb classifier. rosetta wires a DB-backed
    resolver against the `commands` table so `/interface/wifi-qcom/info`,
    `/system/script/run`, and other menu-specific verbs classify correctly
    instead of falling back to bare navigation. The resolver supplements the
    curated universal verb heuristic (it does not replace helpers like
    `find`, which are not enumerated everywhere in the command tree).
  - `extractMentions(input, cwd?, options?)` — surfaces every distinct path
    the input *references*, including bare navigation with no verb (e.g.
    `/ip/firewall/filter` standing alone in prose). Superset of
    `extractPaths()`. `ParseResult` also carries a new `mentions: string[]`
    field for callers that already use `canonicalize()` directly.
  - `CanonicalCommand.confidence: 'high' | 'medium' | 'low'` — `high` for
    well-formed CLI (absolute path with directly-identified verb),
    `medium` for relative-with-cwd or pure navigation, `low` when the verb
    was inferred from a trailing path segment (looser/prose-shaped input).
    Lets consumers filter prose-extracted results when they need higher
    precision.
- **`src/canonicalize-resolver.ts`** — DB-backed `isVerb` adapter for
  rosetta's `commands` table, with per-resolver in-memory caching. Wired
  into `searchAll()` via a `ClassifyOptions { isVerb? }` pass-through on
  `classifyQuery`, so MCP `routeros_search` and TUI `s` benefit
  automatically when input contains a path with a menu-specific verb.

### Fixed

- **Changelog version lookup and bridge VLAN retrieval.** `routeros_search` /
  `routeros_search_changelogs` now keep exact patch-version lookups exact, but
  fall back from an absent major.minor changelog (for example `7.22`) to its
  patch rows (`7.22.*`). Generic "what changed in X.Y" questions now populate
  `related.changelogs`, and bridge VLAN filtering searches treat "switch" as
  context so the dedicated Bridge VLAN Table page ranks in the top results.
- **`canonicalize.ts` robustness — markdown / prose / common-verb gaps.**
  Tokenizer now strips a leading U+FEFF BOM and treats backticks (`` ` ``) and
  zero-width space (U+200B) as whitespace in both the outer and word loops, so
  inputs from markdown fences, doc snippets, and BOM-prefixed files extract
  cleanly instead of embedding the noise into the first path segment.
  `GENERAL_COMMANDS` gains four verbs that are universal in the rosetta
  `commands` table but were missing: `clear`, `unset`, `reset-counters`,
  `reset-counters-all`. Cross-checked against the DB to confirm zero path
  collisions — `info`/`warning`/`error`/`debug` are intentionally NOT added
  (`/error` is itself a top-level cmd; `info` is a dir at
  `/interface/wireless`). Menu-specific verbs need a path-aware resolver
  (tracked as H4 in the audit). New `src/canonicalize.fuzz.test.ts`
  documents both the shipped behaviour and the still-on-the-books H1–H8
  hardenings.

## [0.8.9] — 2026-04-23

## [0.8.8] — 2026-04-22

### Changed

- **CI: `bump-version` now auto-promotes `[Unreleased]` → `[VERSION] — DATE`**
  and prepends a fresh `## [Unreleased]` skeleton after every release. No
  manual CHANGELOG fixup is needed — agents and developers only write to
  `[Unreleased]`; the version heading is filled in automatically.
- **CI: Phase 0 retrieval eval runs on release builds (non-blocking).**
  `release.yml` now executes `bun run src/eval/retrieval.ts` against the
  freshly built full DB after extraction and writes the report to the job
  summary. Non-blocking while the baseline adapts to the real-DB corpus —
  flip to blocking after one green real-DB run refreshes the baseline.
- **CI: Phase 2 contract checks run in a dedicated real-DB step on release
  (non-blocking).** `release.yml` executes `bun test src/mcp-contract.test.ts`
  after the full `bun test` suite so the token-budget and shape-invariant
  blocks run against the freshly built full DB in a fresh process (the
  shared `bun test` run pins the DB singleton to `:memory:` before this
  file loads, so Blocks B/C would otherwise skip). Non-blocking:
  `continue-on-error: true` while we observe the step green across a few
  rebuilds; test output is written to the job summary. `test.yml`
  intentionally does not get a dedicated step: a clean CI checkout has no
  `ros-help.db`, so B/C would skip regardless and the step would be
  redundant with Block A in the main run.

### Added

- **MCP behavioural eval framework (Phases 0–2)** — three new surfaces for
  validating that the MCP tool layer keeps doing what we expect, with no LLM
  cost in the default flow:
  - **Phase 0** (`make eval`) — 20 hand-curated golden queries in
    `fixtures/eval/queries.json`, scored on recall@k / MRR / classifier
    accuracy with baseline regression gating (2pp tolerance).
  - **Phase 1** (`make eval-self`) — ~170 auto-generated queries from
    section headings, property names, and page titles using deterministic
    seeded sampling. Per-strategy thresholds + 5pp baseline tolerance.
  - **Phase 2** (`bun test src/mcp-contract.test.ts`) — frozen tool
    registry test, workflow-arrow (→) convention check, token-budget
    guardrails on 10 canonical queries, and response-shape invariants for
    5 representative queries (portable across DBs of varying richness).
    Runs inside `bun test`.
  - See `BACKLOG.md` "MCP Behavioral Testing — research + roadmap" for the
    full 5-phase plan.
- **Tool-surface change ritual** documented in `CLAUDE.md`: adding,
  removing, or renaming an MCP tool requires updating both `src/mcp.ts`
  and the `EXPECTED_TOOLS` array in `src/mcp-contract.test.ts`, plus a
  `CHANGELOG.md` entry under `[Unreleased]`.

### Fixed

- **Phase 1 self-supervised sampling is now deterministic on full DBs.**
  The cmd-path strategy no longer uses SQL randomness; it samples from a
  stable ordered set using the same seeded shuffle as the other strategies,
  so `self-supervised-baseline.json` stays reproducible across runs.

- `CHANGELOG.md` (Keep a Changelog format, back-filled from v0.1.0) with an
  agentic "update `[Unreleased]` on every user-visible change" rule in
  `CLAUDE.md` + `CONTRIBUTING.md`.
- **TUI: `view` / `v` command.** Re-renders the current context (page,
  results, sections, etc.) without popping the navigation stack the way
  `b` does. Useful after exiting the pager to re-read what you were
  looking at.
- **TUI: bare `page` re-renders current page.** When already in a page or
  sections context, `page` with no args re-renders the current page
  instead of erroring.

- **CI: fast-fail quality gate.** `release.yml` now runs `typecheck` + `lint`
  immediately after `bun install`, before the ~2-minute extraction pipeline.
  Tests continue to run post-extraction as the DB-wipe guard.
- **CI: `bump-version` rebase-retry.** Back-to-back release runs no longer
  fail with `! [rejected] HEAD -> main (fetch first)`. The job fetches +
  rebases onto `origin/main` and retries the push up to 3× (safe because
  the commit only touches `package.json`).
- **`routeros_search_tests`: 512-byte rows surface first when no
  `packet_size` filter is set.** 512B is the conventional mid-size
  benchmark RouterOS admins compare on, so within the LIMIT they now
  precede 1518B "best case" rows that previously crowded them out.
  Pin `packet_size` to override.
- **TUI dot-commands print usage on missing required args.** Calling
  e.g. `.routeros_get_page` with no args now prints the args, brief
  description, and TUI equivalent instead of silently returning `null`.

### Fixed

- **TUI device detail benchmark truncation now always keeps all 512B rows.**
  When compacting long per-device test lists, the renderer now preserves every
  512-byte result (the common comparison size) and only truncates non-512 rows.
- Tests/CI: importing `extract-test-results.ts` no longer opens the DB or runs
  extraction side effects at module-load time. The extractor now runs only
  under `import.meta.main`, and `extract-test-results.test.ts` sets
  `DB_PATH=:memory:` before dynamic import to prevent cross-file DB singleton
  contamination that could make `query.test.ts` fail depending on test order.
- **`extract-test-results`: throughput values with thousands separators now
  parse correctly.** Values like `7,112.3` Mbps were truncated to `7` because
  `parseFloat` stops at a comma. The extractor now strips commas before parsing,
  so the DB will contain correct figures after the next re-extraction.
- **TUI pager: navigation keystrokes no longer bleed into the REPL prompt.**
  Pager ran in raw mode while readline's data handler was still active, so
  each keystroke (`1`, `4`, `q`, etc.) accumulated in readline's internal
  line buffer and reappeared echoed after the next prompt (e.g. `> 1432q`).
  Fixed by clearing `rl.line`/`rl.cursor` before re-prompting after dispatch.
- **TUI: `[p]` and `[cal]` page hints now work on pages with sections.**
  Pages with headings push `ctx.type = "sections"` (not `"page"`), so the
  `p`/`prop` and `cal`/`callouts` context-scoped handlers were silently
  falling back to "no page, show usage" even while a page was showing.
  Both handlers now check for `sections` context too, so all five footer
  hints (`[N]`, `[p]`, `[cmd]`, `[cal]`, `[b]`) work correctly regardless
  of whether the page has headings.
- **TUI help text mentions `[N]` section navigation.** The post-pager hint
  line now reads `[N] = go to section N` alongside `[p]` / `[cal]` / `[b]`.
- **TUI pager: digits open the listed result.** In a results pager
  (search, devices, callouts, videos, properties, changelogs, sections,
  command tree, dude), pressing `1`..`N` (where N is the number of
  visible results) now opens that result and exits the pager. Previously
  digits were always interpreted as page jumps, so users had to quit the
  pager (`q`) and then type the number — wasted keystrokes on the most
  common path. Page-jump still works for digits beyond the visible
  result count.
- `routeros_search_changelogs` `X..Y` version range is now inclusive on both
  ends, normalises reversed ranges (`7.21..7.20` → `7.20..7.21`), and returns
  entries chronologically (oldest first).
- Build: missing `compareVersions` import in `src/browse.ts` — was failing
  typecheck on both `test.yml` and `release.yml`.

## [0.8.2 – 0.8.3] — 2026-04-22

### Changed

- **TUI polish round-2.** Dot-command aliases (`.s` → `.routeros_search`), back
  navigation re-renders, page calendar rendering, Markdown → ANSI sweep across
  skills/pages.
- **CI:** `bump-version` decoupled from `bunx-smoke` — a smoke regression no
  longer blocks the next version from being available for the fix release.
  Force-mode runs also skip the npm publish step (npm versions are immutable).
- **Lint rule sharpened.** `bun run lint` must be zero errors repo-wide, not
  just on touched files.

### Fixed

- `browse` CLI args now route through the normal TUI dispatcher, so every TUI
  command (not just `s`) works when passed at launch.
- Resolved `noNonNullAssertion` lint errors in `canonicalize.test.ts` that
  were blocking CI.

## [0.8.0 – 0.8.1] — 2026-04-21

### Fixed

- **`bunx` install path is now rock-solid on macOS.** The last `{ readonly: true }`
  DB open (in `mcp.ts::ensureDbReady` and `setup.ts::dbHasData`) was removed.
  Freshly-written WAL-mode SQLite DBs with no `.shm` sibling cannot be opened
  readonly on macOS, which caused `Validated … | Still incompatible after
  re-download (DB=unreadable)` for v0.8.0 users. Added a structural anchor test
  that forbids `{ readonly: true }` on DB opens.

### Added

- **Cross-platform bunx smoke job in CI.** `release.yml` now runs a
  `bunx-smoke` matrix on macOS + Linux after npm publish, pinning the just-
  published version and exercising `--refresh`, `--version`, and the full MCP
  server boot path. Linux-only CI had green-lit v0.8.0 before this was added.

## [0.7.5 – 0.7.8] — 2026-04-21

### Added

- **`db_meta` table (schema v5).** Database provenance — `release_tag`,
  `built_at`, `source_commit`, `schema_version`. Stamped at release time,
  shown in the startup banner.
- **Auto-update story for bunx.** DB download URL pins to the running package
  version (`releases/download/v<VER>/ros-help.db.gz`) with `latest` as
  fallback. Atomic `.tmp.<pid>` write, magic-byte + size + schema probe, then
  `renameSync`. Stale `.db-wal` / `.db-shm` siblings are cleaned up in the
  same step. Schema mismatch is a hard error with an actionable message.
- **TUI usability: MCP probe via dot-commands.** `.routeros_search`, `.page`,
  `.device` etc. invoke the same code path as the MCP server tool and dump
  raw JSON. `.help` lists all 13 dot-commands. Contract: "a human can always
  see exactly what the agent would receive."
- **Hunger-knob `related` caps.** `routeros_search.limit` scales callout /
  video caps proportionally via `relatedCaps(limit)`.
- **Glossary in `related`.** Short queries that match a glossary term/alias
  surface the definition in `related.glossary`.

### Fixed

- **CI DB-wipe regression (v0.7.6).** `extract-dude.test.ts` had imported
  `extract-dude.ts` (which loads `db.ts`) before any `DB_PATH=:memory:` was
  set; `query.test.ts:beforeAll` then `DELETE FROM …`'d the CI-built DB,
  shipping a 3-page release. Fixed with `DB_PATH=:memory:` hoisting, a
  `query.test.ts` hard-fail if the singleton isn't `:memory:`, and a
  `release.yml` DB content gate (`pages ≥ 200`, `commands ≥ 1000`,
  `devices ≥ 100`, `properties ≥ 1000`) that runs before publish.
- `extract-html.ts` exits non-zero if 0 pages are extracted.
- `probeDb` and `ensureDbReady` open the DB read-write so WAL-mode init
  doesn't fail on macOS.

## [0.7.0 – 0.7.4] — 2026-04-20

### Added

- **North Star — unified `routeros_search`.** New pre-search regex classifier
  in `src/classify.ts` (pure module, 42 table-driven tests) detects command
  path, version, topic, device model, command fragment, and property-name
  candidate. `searchAll()` in `src/query.ts` wraps `searchPages` and runs
  classifier-driven side queries in parallel, returning
  `{ query, classified, pages, related: {command_node, properties, devices,
  callouts, videos, changelogs, skills, glossary}, next_steps }`.
- **Glossary table.** Seeded at DB init. Resolves RouterOS domain jargon
  (product codes, abbreviations, subsystem names).
- **Known-topics table.** Union of changelog categories and command path
  segments for soft topic routing in the classifier.
- **Changelog range expansion.** `buildChangelogVersionSet` includes channel
  head versions and latest long-term patches.

### Removed

- **`routeros_search_callouts`** and **`routeros_search_videos`** — folded
  into `routeros_search.related`. Tool count: 15 → 13. The underlying
  `searchCallouts()` / `searchVideos()` functions remain in `query.ts` as
  internal helpers used by `searchAll()` and `getPage()` TOC mode.
- **`routeros_search_properties`** — previously removed (useless without
  command-tree context); internal function retained for TUI.

### Changed

- `routeros_get_page` is budget-aware: TOC mode surfaces top properties,
  related videos, and callout summary inline, so small-budget callers rarely
  need a second tool call.

## [0.6.4 – 0.6.9] — 2026-04-13 → 2026-04-20

### Added

- **`schema_nodes` table + multi-arch import.** `deep-inspect.json` from
  `tikoci/restraml` is now the preferred source. Dual-arch (x86/arm64) trees,
  `_completion` data (11K+ args with valid values + 17 style types),
  `schema_node_presence` flat junction, `_attrs` JSON catch-all. The
  `commands` + `command_versions` tables are regenerated from `schema_nodes`
  for backward compatibility.
- **`desc_raw` decomposition.** Parsed into `data_type`, `enum_values`,
  `range_min`/`range_max`, `max_length` at import time.
- **Completion data in `browseCommands()` / `browseCommandsAtVersion()`.**
- **RouterOS agent skills as MCP resources.** `rosetta://skills` (listing)
  and `rosetta://skills/{name}` (per-skill content) with provenance header
  noting community/AI-generated/human-reviewed status.
- **CLI flag support for DB path.** Explicit `--db <path>` overrides all
  discovery modes.
- **Section-level excerpts in search** + server-wide instructions surfaced
  via `SERVER_INSTRUCTIONS`.
- **RouterOS CLI path canonicaliser.** `src/canonicalize.ts` maps any input
  form to `{ path, verb, args }` tuples (61 tests covering subshells, blocks,
  navigation).
- **Release workflow version resolution.** `release.yml` reads `package.json`
  for version when workflow input is blank.

### Fixed

- `dude_pages`: stripped Wayback / wiki chrome from extracted text; removed
  stub entries; `routeros_dude_get_page` accepts `max_length`.
- `browseCommands` arch filtering corrected and tests added.
- Removed `{ readonly: true }` from early DB validation in setup (repeat
  regression trail — finally closed in 0.8.1).
- Stop words + compound terms counts corrected in tool descriptions.

## [0.5.x – 0.6.3] — 2026-04-09 → 2026-04-13

### Added

- **MCP Registry metadata.** `server.json` manifest + CI validation job.
- **MCP dataset resources.** `rosetta://datasets/device-test-results.csv`,
  `rosetta://datasets/devices.csv`, `rosetta://schema.sql`,
  `rosetta://schema-guide.md`.
- **`routeros_command_diff`.** Structural diff of command trees between two
  RouterOS versions.
- **`PRAGMA user_version`** written at DB init; MCP server validates on boot.
- **Sitemap-based device slug resolution** for 100% product-page coverage;
  AKA / alias matching via dash-split + slug-normalised LIKE.
- **Changelog extraction: legacy version support** with CI verification;
  version-set building tests.
- **`ensureDbReady` function in `mcp.ts`** — hard validation before the
  server starts serving.

### Fixed

- Per-session HTTP transport routing (each MCP client session gets its own
  `McpServer` + transport).
- `.dockerignore` added to slim the build context.
- OCI smoke test via `docker pull` (not `docker load`); container entrypoint
  restored in Docker build context.

## [0.4.x] — 2026-04-04 → 2026-04-09

### Added

- **`routeros_search_tests`.** Cross-device ethernet + IPSec benchmark search
  with mode, configuration, and packet-size filters.
- **Device test results + block diagrams.** Scraped from `mikrotik.com/product/<slug>`:
  2,874 measurements across 125 devices, 110 block-diagram URLs.
- **Experimental TUI (`browse`).** Interactive terminal browser — REPL with
  paging, OSC 8 links, context-scoped navigation.
- **Video transcripts via yt-dlp.** 518 MikroTik channel videos, ~1,890
  chapter-level segments with timestamps. NDJSON cache in `transcripts/`
  makes CI reproducible without a yt-dlp dependency.
- **Unicode superscript / subscript normalisation** in product names.
- **Auto-bump patch version after release** (Makefile + CI).
- **Security policy documentation** (`SECURITY.md`) + build-script hardening
  against shell injection.

### Fixed

- HTTP transport test stabilisation; lint sweep.
- `search_tests` response slimmed to reduce context bloat.

## [0.3.x] — 2026-03-31 → 2026-04-01

### Added

- **Streamable HTTP transport** via `--http` flag. Built on `Bun.serve()` +
  `WebStandardStreamableHTTPServerTransport`, stateful per-session routing,
  optional `--tls-cert` / `--tls-key` for direct HTTPS. Defaults to localhost;
  `--host 0.0.0.0` logs a warning.
- **OCI image publishing** (`ammo74/rosetta` on Docker Hub,
  `ghcr.io/tikoci/rosetta` on GHCR). Multi-arch linux/amd64 + linux/arm64.
  Smoke-tested in CI via `docker pull`.
- **`get_page` smart budgeting.** `max_length` default 16000, compact callout
  summary in TOC mode.

### Fixed

- Replaced crane with `Dockerfile + docker buildx` for OCI builds — several
  crane approaches all failed identically on Docker 28 with containerd image
  store.
- Per-session HTTP transport routing.

## [0.2.x] — 2026-03-30

### Added

- **npm distribution.** `bunx @tikoci/rosetta` as canonical install.
  Runtime version resolution (`import.meta.dirname` + `package.json` read)
  so `--version` shows a real number. Claude Desktop full-path PATH
  workaround documented in `--setup` output.
- **Changelog extraction** from `download.mikrotik.com/routeros/<ver>/CHANGELOG`;
  `routeros_search_changelogs` tool with version range + category + breaking
  filters.
- **Markdownlint configuration** (`.markdownlint.yaml`, `.markdownlintignore`).

### Fixed

- CI release workflow: pass HTML dir to `extract-properties`; tolerate
  Confluence zip absolute-path entry; lint issues; TypeScript dev-dependency
  for typecheck.
- `inspect.json` fetched from restraml GitHub Pages (removed `~/restraml`
  dependency).

## [0.1.0] — 2026-03-26

Initial public release.

### Added

- **Core MCP server** (`src/mcp.ts`) with 8 tools: `routeros_search`,
  `routeros_get_page`, `routeros_lookup_property`, `routeros_command_tree`,
  `routeros_device_lookup`, `routeros_command_version_check`,
  `routeros_current_versions`, `routeros_stats`.
- **HTML extraction pipeline** (317 pages, 4,860 properties, 1,034 callouts,
  2,984 sections) + **command tree** (46 RouterOS versions, 1.67M
  command-version junction rows) + **product matrix** (144 devices).
- **SQL-as-RAG** with FTS5 (`porter unicode61` for prose, plain `unicode61`
  for device model numbers), BM25 ranking, compound-term recognition,
  AND→OR fallback.
- **Compiled single-file binaries** for macOS arm64/x64, Linux x64, Windows
  x64 via `bun build --compile`.
- **`--setup` flow.** Downloads DB from GitHub Releases, prints MCP client
  config snippets for Claude Desktop, Claude Code, VS Code Copilot, Copilot
  CLI, Cursor, Codex.
- **`DB_PATH` env override** + three-mode DB path resolution (compiled /
  dev / package at `~/.rosetta/`).
- Bun tests for the query planner + schema health.

[Unreleased]: https://github.com/tikoci/rosetta/compare/v0.8.3...HEAD
[0.8.2 – 0.8.3]: https://github.com/tikoci/rosetta/compare/v0.8.1...v0.8.3
[0.8.0 – 0.8.1]: https://github.com/tikoci/rosetta/compare/v0.7.8...v0.8.1
[0.7.5 – 0.7.8]: https://github.com/tikoci/rosetta/compare/v0.7.4...v0.7.8
[0.7.0 – 0.7.4]: https://github.com/tikoci/rosetta/compare/v0.6.9...v0.7.4
[0.6.4 – 0.6.9]: https://github.com/tikoci/rosetta/compare/v0.6.3...v0.6.9
[0.5.x – 0.6.3]: https://github.com/tikoci/rosetta/compare/v0.4.5...v0.6.3
[0.4.x]: https://github.com/tikoci/rosetta/compare/v0.3.1...v0.4.5
[0.3.x]: https://github.com/tikoci/rosetta/compare/v0.2.1...v0.3.1
[0.2.x]: https://github.com/tikoci/rosetta/compare/v0.1.0...v0.2.1
[0.1.0]: https://github.com/tikoci/rosetta/releases/tag/v0.1.0
