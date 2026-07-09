# Changelog

All notable user-visible changes to `@tikoci/rosetta` are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); project
uses [Semantic Versioning](https://semver.org/).

> **Agentic rule.** Any change with a user-visible effect (CLI, MCP tool shape,
> DB schema, CI behaviour, install flow) adds an entry under **[Unreleased]**
> in the same PR / commit. Promoting `[Unreleased]` to a dated version header
> is a manual step, done by hand alongside the `package.json` version bump
> before dispatching a latest-channel release (see `MANUAL.md` "Release
> Workflow") — CI no longer auto-bumps versions or auto-promotes CHANGELOG on
> any channel. Prerelease (`alpha`/`beta`/`rc`) release runs never promote
> `[Unreleased]` either, since they don't represent the next stable version.
> CI-only auto-bumps and pure refactors with no external effect are
> intentionally omitted — git history is authoritative for those.
>
> **Not a git log.** Don't list every commit. One bullet per behaviour change,
> grouped under `Added` / `Changed` / `Fixed` / `Removed` / `Deprecated` /
> `Security`. Details and rationale belong in `DESIGN.md`; the "what's next"
> backlog belongs in `BACKLOG.md`.

## [Unreleased]

### Added

- **New Docusaurus `/docs` prose extractor (`extract-docusaurus.ts`) replaces `extract-html.ts` as the default prose source.** Discovers pages via `sitemap.xml`, fetches raw Markdown from manual.mikrotik.com, and populates `pages`/`sections`/`properties`/`callouts` — 360 in-scope `/docs` pages as of 2026-07-07 (CLI Reference and `/hardware` remain out of scope, tracked as follow-up work). `make extract`/`make extract-full` now run it by default; the legacy Confluence pipeline survives as `make extract-legacy-confluence` for rebuilding historical release DBs.
- **New `pages.rosetta_id` column** (schema v6) gives Docusaurus-sourced pages a stable, URL-derived identifier alongside the existing integer `id` — see `DESIGN.md` and `briefings/B-0012-docusaurus-manual-migration.md` "H7 — Identity / rosetta-id design".
- **npm prerelease dist-tag channel.** Testers can now opt into an in-progress build via `bunx @tikoci/rosetta@next` (newest prerelease of any stage) or `@alpha`/`@beta`/`@rc` (pinned to one stage), without moving the default `latest` channel. Channel is driven entirely by `package.json`'s committed version (a `-alpha`/`-beta`/`-rc` suffix means prerelease); OCI image tags (`:alpha`/`:beta`/`:rc`/`:next`) mirror the same scheme, and the bare `:latest` OCI tag now never moves on a prerelease release run. See `README.md` "Prerelease channels" and `MANUAL.md` "Release Workflow".
- **`bun test --coverage` now runs on every release build**, summarized in the workflow's step summary and uploaded as a `coverage-lcov` artifact — informational only, not a gate.

### Changed

- **Relative Markdown links inside property descriptions now resolve to live `manual.mikrotik.com` URLs** instead of being left as broken relative paths once extracted out of their source page.
- **`release.yml` CI now builds the DB from the live Docusaurus extractor, not the legacy Confluence HTML export.** The `html_url` workflow input is gone; a new `extract-docusaurus.ts --check-counts --strict` step proves the docs-count invariant on every release run instead of only in manual/local runs. Rebuilding a historical pre-migration DB remains possible via the local-only `make extract-legacy-confluence` target — it is no longer reachable from CI.
- **Release version bumps are now a manual step for every channel, including `latest`.** CI's old `bump-version` job (blind `PATCH + 1`, auto-committed straight to `main`) is gone entirely — it couldn't reason across the new prerelease channels. A new preflight fails a latest-channel release if `CHANGELOG.md` lacks a `## [<version>]` heading for the bare `package.json` version being released, so CHANGELOG promotion can't be skipped by accident. See `MANUAL.md` "Version bumps are a manual step".

### Fixed

- **`release.yml`'s first real `0.11.0-alpha` dispatch (2026-07-09) failed at "Run tests (fast-fail)" despite 0 failing tests** (649 pass / 0 fail). Root cause: `bunfig.toml` carried a long-dormant `[test].coverageThreshold = { lines: 0.70, functions: 0.80 }` (present since April 2026, never actually exercised because `test.yml` never ran `bun test` with `--coverage`) — the first time `--coverage` ran anywhere in CI was `T-0037`'s new step, and real coverage (55.64% lines / 62.78% functions) tripped the dormant threshold, failing the whole release despite every test passing. `bunfig.toml`'s threshold is removed — coverage reporting is informational only, per `VALIDATION.md` `V-coverage-reported`, and should never gate on its own. Also hardened `release.yml`'s error reporting so a real future failure of this kind is self-explanatory instead of a bare "Process completed with exit code 1": the "Run tests (fast-fail)", "MCP contract tests (real DB)", and "MCP retrieval eval (Phase 0)" steps now each emit an explicit `::error::` annotation distinguishing an actual test failure from a nonzero exit with no failing tests reported.

### Removed

- **CI's automatic `package.json`/`CHANGELOG.md` version-bump commit** (the `bump-version` job in `release.yml`) — superseded by the manual version-bump step above.

## [0.10.0] — 2026-07-08

### Changed

- **v0.10.x will be last release(s) based on Confluence HTML doc extraction.** v0.11.x and beyond will use new manual.mikrotik.com as source for MikroTik documentation pages.

### Fixed

- **Only changelog and version bump.** Promote to an even-number release. Otherwise, identical to 0.9.3.

## [0.9.3] — 2026-07-07

### Changed

- **YouTube transcript cache refreshed for the final Confluence-corpus release.** The committed transcript cache now covers 538 MikroTik channel videos through June 19, 2026, and remains the source release CI imports via `extract-videos-from-cache`.
- **Product matrix snapshot refreshed for the final Confluence-corpus release.** The default device extractor now consumes the July 7, 2026 browser-exported matrix snapshot with 156 products.
- **Release docs now identify local-only source refreshes.** `MANUAL.md` distinguishes cache inputs that CI consumes from live sources CI already refreshes, including the product-matrix browser export caveat.

## [0.9.2] — 2026-06-18

### Changed

- **Docs now flag MikroTik's manual.mikrotik.com migration.** Project docs record that future RouterOS manual updates are Docusaurus-based, not Confluence HTML exports, and outline the extraction/MCP/TUI redesign options.

### Fixed

- **Schema-mismatch setup guidance now points MCP users at a fresh bunx resolution.** The refresh message tells users to restart the MCP client or run `bunx @tikoci/rosetta@latest --refresh` when their cached package is older than the published DB.

### Removed

- **Stale `ros-toc.json` PDF-era artifact removed.** The current HTML extraction pipeline is the source of RouterOS page metadata, and no runtime code consumed the empty-title TOC file.

## [0.9.1] — 2026-05-26

### Fixed

- **Release npm publish now fails fast on missing or unauthorized `NPM_TOKEN`.** The release workflow verifies npm package availability and read-write package access before extraction, artifact publishing, OCI pushes, or GitHub Release creation; partial release retries can update existing GitHub Release assets before publishing to the explicit npm registry.
- **Release skill extraction now authenticates GitHub API reads.** The `extract-skills.ts` GitHub API calls use `GITHUB_TOKEN`/`GH_TOKEN` when available, and release CI passes `github.token` to avoid unauthenticated API 403s while fetching `tikoci/routeros-skills`.

## [0.8.13] — 2026-05-03

### Added

- **`make verify` target.** Runs typecheck + lint + tests + MCP contract tests + Phase 0 retrieval eval in one command. Requires a populated DB (`make extract` first). Covers V-typecheck, V-lint, V-unit, V-tool-registry, V-tool-shapes, V-tool-budget, V-retrieval-floor. Skips the clean-tree check that `make preflight` enforces.

### Changed

- **CLAUDE.md is now a thin routing index, and agent rules live in narrow `.github/instructions/*.instructions.md` files.** Canonical reference material moved to `MANUAL.md` and `DESIGN.md`, legacy broad instruction files became routing stubs, and Copilot-facing guidance now points at the scoped rule files instead of duplicating the whole project reference.
- **TUI/MCP parity and CLI help/manual parity are now CI-enforced.** New `src/browse-parity.test.ts` proves every MCP tool has a matching `.routeros_*` browse dot-command, and new `src/cli-help.test.ts` locks `MANUAL.md`'s CLI Flags table to `bun src/mcp.ts --help`. The `--help` output now documents `browse <cmd> [args]`, `browse --once <cmd>`, and TLS env var names explicitly.
- **MCP contract tests and Phase 0 retrieval eval are now blocking in release CI.** Both were previously `continue-on-error: true` pending a first green CI run; both have now passed — `continue-on-error` removed and step names updated (dropped `(non-blocking)` suffix).
- **Work tracking restructured.** `BACKLOG.md` slimmed to an inbox + triggers list. Active work now lives in `tasks/T-NNNN-*.md` (frontmatter: status, depends_on, conflicts_with, validation, acceptance). Research and decision notes live in `briefings/B-NNNN-*.md`. New `VALIDATION.md` matrix names every load-bearing invariant and the CI step that proves it. Three new `.github/skills/` (`pick-next-task`, `promote-idea`, `verify-task`) wrap the conventions. `CLAUDE.md` and `.github/copilot-instructions.md` doc-rule tables updated to match.
- **Task verification docs now distinguish current proofs from planned ones.** `tasks/README.md` and the `verify-task` skill no longer assume a `make verify` target already exists, `VALIDATION.md` now points `V-db-min-content` at the real inline release step, and `V-retrieval-self` is recorded honestly as a tracked gap until release CI actually runs the self-supervised eval.
- **The test workflow now exercises the real stdio MCP client path.** `.github/workflows/test.yml` runs `src/mcp-stdio-client.test.ts`, which spawns `bun src/mcp.ts` through `@modelcontextprotocol/sdk`'s `StdioClientTransport`, proves the 14-tool registry/resources surface over stdio, and catches stdout framing pollution.
- **Release `bunx-smoke` matrix now includes `windows-latest`.** Catches the EBUSY / readonly-WAL / temp-file class of bugs on Windows. Step uses `RUNNER_TEMP` instead of `mktemp` (not available in Git Bash) and sets `shell: bash` as the job default.
- **Release CI now runs the Phase 1 self-supervised retrieval eval (non-blocking).** After the existing Phase 0 hand-curated eval step, `release.yml` now executes `src/eval/self-supervised.ts` against the freshly built full DB and appends the pass/fail result to the workflow summary. Results are visible but non-blocking until a stable baseline is established.

### Removed

- **`make release`, `make build-release`, `make bump-version` removed from Makefile.** All release artifact production now goes through the GitHub Actions `release.yml` workflow. The Makefile retains ETL targets and developer checks (`make preflight`, `make verify`).

### Security

- **CodeQL ignore scope now anchors the root `skills/` cache explicitly.** `.github/codeql/codeql-config.yml` now ignores `/skills/**` instead of an unanchored `skills/**`, keeping the committed `.github/skills/` workflow docs distinct from the extracted root-level skill cache.

## [0.8.12] — 2026-05-02

### Fixed

- **Windows package-mode DB installation no longer renames a SQLite-opened temp
  file.** Download validation now finalizes every SQLite statement before close,
  and `replaceDbFile` retries transient `EBUSY` / `EEXIST` / `EPERM` rename
  failures for up to 30 seconds to cover delayed handle release, antivirus, or
  indexers.
- **Abandoned `.tmp.*` DB artifacts are removed immediately when no active
  download lock exists**, so failed Windows installs do not keep accumulating
  274 MB temp databases between launches.

## [0.8.11] — 2026-05-02

### Fixed

- **Stale `.tmp.*` cleanup now runs on every startup**, not only when a download
  is triggered. This removes accumulated 274 MB temp files from previous failed
  downloads even when the DB is already healthy.
- **Windows rename now handles `EBUSY`** in addition to `EEXIST`/`EPERM` in the
  `replaceDbFile` fallback path, providing better defense against antivirus or
  indexer locks on the destination.
- **Schema-mismatch recovery messages no longer reference `bun pm cache rm`** or
  use shell `&&` syntax. The actionable command is now
  `bunx @tikoci/rosetta@latest --refresh`, which works cross-platform and
  handles both package and DB refresh in one step.

## [0.8.10] — 2026-05-02

### Security

- **CodeQL + Dependency Review wired up.** New
  [`.github/workflows/codeql.yml`](.github/workflows/codeql.yml) runs the
  `security-and-quality` suite (security-extended + code-quality queries)
  against `javascript-typescript` and `actions` on push, PR, and a weekly
  cron. [`.github/codeql/codeql-config.yml`](.github/codeql/codeql-config.yml)
  excludes vendored/generated content (`box/`, `dude/`, `transcripts/`,
  `matrix/`, `skills/`, `fixtures/`, `dist/`, `images/`) so scans focus on
  shipped/runtime TypeScript, extractors, the bin shim, release scripts, and
  workflow YAML; test/eval harnesses are excluded to avoid temp-file/file-race
  noise outside shipped code. New
  [`.github/workflows/dependency-review.yml`](.github/workflows/dependency-review.yml)
  blocks PRs introducing high-severity dependency advisories. New
  [`.github/dependabot.yml`](.github/dependabot.yml) opens weekly grouped
  update PRs for `github-actions` and `bun` ecosystems. The Test workflow
  gains an "AI findings probe" step that polls candidate Code Quality
  endpoints and prints a CI notice (no-op until GitHub ships a stable API).
  Repo-level Dependabot security updates, secret scanning with push protection,
  and private vulnerability reporting are enabled.
  See `SECURITY.md` for the configured posture summary.

### Changed

- **Documentation/instruction cleanup:** agent-facing instructions, release/extraction docs,
  and BACKLOG structure now match the current CI pipeline, MCP resource surface,
  and `DESIGN.md` source-of-truth for cross-tikoci command validation strategy.
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

### Fixed

- **bunx/package startup no longer races the shared `~/.rosetta/ros-help.db`.**
  Package-mode DB preparation now uses a sidecar lock so concurrent MCP clients
  wait for the first download instead of competing to rename the file on
  Windows. Waiters no longer probe-lock the canonical DB while another process
  is replacing it, startup aborts instead of falling through to a schema-only
  empty DB when recovery fails, probes no longer create a missing canonical DB
  as a side effect, and stale `.tmp` / `-wal` / `-shm` artifacts are cleaned up
  instead of accumulating in `~/.rosetta/`.
- **Video transcript VTT cleanup:** malformed cue markup is dropped without
  leaking tag fragments into extracted transcript text.
- **Release workflow npm propagation log:** the bunx smoke-test polling loop
  now reports the correct attempt number while waiting for the npm registry.

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
