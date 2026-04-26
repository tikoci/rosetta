# Backlog — rosetta

> Ideas, considerations, and future work. Anything that isn't "how the project works" (→ `CLAUDE.md`) or "why it's built this way" (→ `DESIGN.md`) goes here.
>
> **Convention:** Agents should add items here under the appropriate heading rather than creating new files. Include enough context that a different agent (or human) can act on it later without the original conversation.
>
> **Design principles and the North Star architecture are in `DESIGN.md`.** This file is the *action list* — what to build, what needs a decision, what's waiting on a trigger.
>
> **Last holistic review:** 2026-04-26. MCP-tool / backlog alignment pass —
> walked the 13-tool registry against this file. Promoted three items to ✅
> (changelog compact-summary mode, `routeros_search_tests` device filter,
> `routeros_current_versions` WinBox 4 in-band); added three follow-ups
> (workflow-arrow gaps on `stats` + `current_versions`,
> `routeros_command_version_check` `arch` consistency,
> `related`-bucket doc drift around `glossary`). Tool count and registry
> contract still match the Phase 2 frozen-13 list; no surprises.
>
> **Earlier review:** 2026-04-21. CI / release-workflow hygiene pass —
> captured FORCE semantics confusion, `bump-version` race, local-release
> deprecation, and changelog-discipline adoption. CHANGELOG.md back-filled
> from v0.1.0–v0.8.3.
>
> **Shipped since last review:** `canonicalize.ts` hardenings H4/H6/H7/H8
> (resolver plug-in point, `extractMentions()`, BOM/ZWSP tolerance,
> per-command `confidence` flag) — wired into `searchAll()` via
> `ClassifyOptions { isVerb }`. Earlier round (Mar–Apr): North Star steps
> 2–4 — `classifyQuery`, `searchAll()`, dropped folded
> `routeros_search_callouts` / `routeros_search_videos` (tool count 15→13;
> content in `related`), budget-aware `getPage()` with TOC-mode
> `properties` + `related_videos`.

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

### 🔴 CI / release-workflow hygiene (2026-04-21)

User flagged a bundle of related concerns after the v0.7.x–v0.8.x release
storm. Capture verbatim; address in small, separate PRs so each one is easy
to review.

1. **`FORCE`/`force` semantics are confusing agents.** The flag is named like
   a generic "re-do this step" but in practice npm publish is always skipped
   (npm is immutable), so "force" only re-uploads GitHub Release assets +
   re-tags OCI images + force-moves the git tag. Users / agents think they
   should always try `force=true` when something fails; what they really
   need is to bump the version and run again. Fix: **rename to something
   honest** (`republish_assets` or `overwrite_gh_release`), and make the
   workflow description say "does NOT re-publish npm — bump version first if
   you need that." Also consider: if a given tag already exists on npm,
   refuse a non-force run with a clear "version is already on npm; bump
   first" error instead of the current fast-follow bump dance.

2. **`bump-version` job races itself.** Back-to-back release runs produce
   `! [rejected] HEAD -> main (fetch first)` because each checkout pins to
   the SHA at workflow start. Fix: `git pull --rebase origin main` before the
   push, or retry the push up to 3× with rebase between attempts. The bump
   commit is trivially rebaseable (only touches `package.json`), so a rebase
   is safe.

3. **Drop the local `make release` path (or clearly label it internal).**
   DESIGN.md still says "local release continues to work as an alternative
   path" but this contradicts the user's stated goal: "ideally everything
   should be in GitHub without any local deps." Options: (a) delete the
   `release:` target from the Makefile and keep only `build-release` for
   local smoke; (b) gate it behind `ALLOW_LOCAL_RELEASE=1` with a loud
   warning. Either way, update DESIGN.md + CONTRIBUTING.md to make
   `workflow_dispatch` the only supported path. This also lets us trim
   preflight checks and the cross-compile step from the local flow.

4. **Release workflow still uses deprecated Node 20 actions.** `actions/setup-node@v4`, `actions/upload-artifact@v4`, `docker/login-action@v3`, `docker/setup-buildx-action@v3` all emit the "Node 20 deprecated, forced to Node 24 June 2026" warning. Bump or pin `FORCE_JAVASCRIPT_ACTIONS_TO_NODE24=true` before June to avoid a forced breakage window.

5. **Move lint + typecheck + tests earlier in `release.yml`.** Currently they
   run AFTER the full extraction pipeline (~2 minutes). A lint error that
   slipped past `test.yml` (see v0.8.2: `noNonNullAssertion` in
   `canonicalize.test.ts`) wastes the entire extraction budget before
   failing. Run them immediately after `bun install`, before `Download HTML
   export`. Extraction-specific tests (anything touching `ros-help.db`) can
   keep their current position.

6. **`html_url` input defaults to a Seafile direct-link that rotates.** When
   MikroTik publishes a new export, the hard-coded default becomes wrong and
   agents get a "not a valid ZIP archive" failure (happened on runs
   24748092748, 24750588839). Options: (a) fetch the latest export link from
   a known index URL; (b) make the input required with no default so the
   dispatcher has to look it up intentionally.

7. **Changelog discipline.** Adopted 2026-04-21 — CHANGELOG.md back-filled
   from git history and per-release notes. See rule in CLAUDE.md + CONTRIBUTING.md.
   Release workflow should promote `[Unreleased]` → dated `[vX.Y.Z]` as part
   of `build-and-release`: read `CHANGELOG.md`, extract the `[Unreleased]`
   section, use it as the body of the GitHub Release (instead of or
   alongside the current auto-generated "Database Stats" block), and commit
   the version-bumped `CHANGELOG.md` in the same step as `bump-version`.
   Skipped for force mode (no new version).

8. **`.npm-publish-checklist.md` in repo root is stale.** Predates the CI
   release workflow. Either delete it or move the still-relevant parts into
   CONTRIBUTING.md.

9. **Shrink the Makefile to its ETL role.** User flagged 2026-04-21 that it
   feels duplicative. Inventory:
   - **Real value (keep):** `preflight`, `extract`, `extract-full`, the
     `extract-*` individual steps, `extract-*-from-cache` variants, `link`,
     `clean`. These are the multi-step data pipeline and aggregated check —
     exactly where `make` earns its keep.
   - **Pure delegation to bun (drop):** `install`, `serve`, `search`,
     `browse`, `assess`, `typecheck`, `test`, `lint`, `setup`. Every one is
     `bun run …` with no chaining. Agents must consult Makefile + package.json
     + bun CLI to know the right invocation — strictly additive confusion.
   - **Duplicates CI, and item #3 says to drop the local path anyway
     (drop):** `build-release`, `release`, `bump-version`.

   Proposed one-line Makefile header after the shrink: "Makefile is the data
   ETL pipeline. For dev tasks use `bun test`, `bun run typecheck`,
   `bun run lint`, `bun run src/mcp.ts`. For release use the `Release`
   workflow_dispatch in GitHub Actions."

   Follow-through: update CLAUDE.md examples that currently invoke
   `make test` / `make lint` / `make release` etc.; remove `make` mentions
   from CONTRIBUTING.md dev commands; tighten CLAUDE.md's "Re-extraction"
   section (those still use `make`, correctly).

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

### 🟡 Extractor import side-effects (remaining)

`extract-test-results.ts` is now safe to import in tests because extraction runs
only under `import.meta.main` and DB import moved inside `main()`. Other
extractors still import `db.ts` at module-evaluation time, so future pure-parser
tests can reintroduce cross-file DB singleton contamination if they statically
import those modules without `DB_PATH=:memory:`.

Action: apply the same pattern to extractor entrypoints (`main()` +
`if (import.meta.main) await main()` + dynamic `await import("./db.ts")` in
`main`) so helpers can be imported without DB side effects.

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

### ✅ Changelog tool: compact summary mode — DONE

All three sub-items shipped in `src/mcp.ts::routeros_search_changelogs` and
`groupChangelogsByVersion()`: (1) grouped-by-version output with per-version
`entry_count` + `breaking_count`, (2) `limit` max raised to 500, (3)
`from_version` is exclusive (callsite + tool description). Recorded for
history.

**Follow-up (🟢, optional):** add `category` rollup *within* a version group
(e.g. version → categories → entries) when results span many subsystems —
only worth it if real sessions still produce noisy output now that grouping
is in place. Capture a session example before acting.

### 🟡 Multi-arch schema remaining items

- **`browseCommands(arch)` filtering behavior** — currently enrichment-only, not exclusion. MCP doc says "shows arm64-specific interfaces" but results include all. Decide: hide x86-only nodes when `arch=arm64`, or tag them? If hiding: move arch to WHERE filter.
- **`schema_node_presence` has no arch column** — can't answer "did this arm64-only node exist in 7.20?" separately from x86. Defer until arch filter behavior and GC are settled.
- **Accumulate mode drops presence for removed nodes** — non-primary version commands removed by primary can't be FK-referenced. Fix: union all versions' nodes (large) or legacy presence table (no FK). Defer until GC designed.
- **`commands` UNIQUE(path) vs `schema_nodes` UNIQUE(path, type)** — `INSERT OR IGNORE` could silently drop a row if RouterOS ever has same-path different-type entries. Not possible today; note for future.

### ✅ `routeros_search_tests` device filter — DONE

MCP tool exposes `device` (substring match) and `searchDeviceTests()` accepts
it (`src/mcp.ts:1305`, `src/query.ts:1741`). TUI parity confirmed. Recorded
for history.

### ✅ Workflow-arrow gaps on `stats` + `current_versions` — DONE

`routeros_stats` description now ends with `→ routeros_search`;
`routeros_current_versions` ends with `→ routeros_search_changelogs`
(suggesting `to_version=<latest>`, `from_version=<user's version>`).
`KNOWN_EXCEPTIONS` removed from `src/mcp-contract.test.ts` —
the workflow-arrow check is now uniform across all 13 tools. Recorded
for history.

### 🟢 `arch` as a *suggestion*, not a filter — and the package angle

(2026-04-26 — captured user's framing during MCP-tool / backlog audit.)

**Decision direction (not yet implemented):** `arch` should NOT be a
hard filter on `routeros_command_version_check` /
`routeros_command_tree` / `routeros_command_diff`. Real-world usage:

- 95–99% of RouterOS commands behave identically across arches; filtering
  hides answers from agents who passed `arch` defensively.
- Agents often try to fill in optional params even when they shouldn't.
  An agent that *thinks* it knows the arch (chained from a model lookup
  via `routeros_device_lookup`) shouldn't be punished with empty results
  if our inspect data only covers one arch.
- We extract from CHR (x86_64) primarily, plus arm64 deep-inspect. We
  have **no** MIPSBE / ARM 32-bit data — yet ARM 32-bit is plausibly the
  most common deployed arch (Audience, cAP ax, hAP family below ax², many
  switches).

**Behaviour we want instead:**

1. Accept `arch` on every command-tree tool as an *advisory* hint, not a
   WHERE clause. Always return all matching nodes from the data we have.
2. When `arch` is supplied AND we have inspect data for it (today: `x86`
   or `arm64`), prefer that arch's data in the response and tag the
   record (e.g. `_arch: 'arm64'`).
3. When `arch` is supplied but we have no data for it (today: anything
   that is not x86/arm64), return arm64 (or x86) data with an explicit
   `note` field on the response: e.g. `"rosetta has no inspect data for
   ARM 32-bit yet; the answer below comes from arm64 inspect data and is
   likely correct for shared subsystems but may diverge for wireless
   drivers and arch-specific packages."`
4. Track `arch` solicitations passively (count by value) so we know
   which gaps to prioritise filling. No telemetry shipped — local-only,
   piggyback on the deferred `usage_log` / `ROSETTA_LOG_USAGE=1` idea.

**The bigger problem isn't arch — it's package.** Agents asking "why
doesn't `/interface/wifi-qcom/...` work on my router?" usually have a
package-availability problem, not an arch problem. Wireless is the worst
offender:

- `wifi-qcom` (newer, ax/ax2/ax3 hardware) vs the older `wireless`
  driver (legacy chips). RouterOS lets both packages co-exist — older
  `wireless` becomes a CAPsMAN-only (CAPsMAN v1) controller package
  while `wifi-qcom` drives the local radios with its own newer CAPsMAN
  scheme. Sorting this out is hard for agents without grounded data on
  the specific model.
- A "valid" command can be unavailable simply because the package isn't
  installed. CHR-derived inspect data has most extra-packages but
  notably NOT the wireless-driver packages (no Wi-Fi hardware in CHR).
- This points to wanting per-node **package** annotations
  (`schema_nodes._package` is already a placeholder column awaiting
  restraml metadata). Higher leverage than arch filtering.

**Future-work nudges (capture, don't act now):**

- **Backfill MIPSBE / ARM 32-bit inspect data** by pointing restraml's
  `/console/inspect` extractor at a permanent real router instead of
  CHR. Likely candidates: a hAP ax² (ARM64, but already covered) — what
  we actually need is an Audience or hAP ac² (ARM 32-bit) and a hEX or
  RB750Gr3 (MMIPS / MIPSBE). Requires controlled upgrade flow on the
  test rig so the data tracks current versions.
- **Wireless driver disambiguation.** When `routeros_device_lookup`
  identifies a model, surface its expected wireless driver
  (`wifi-qcom` vs `wireless`) and CAPsMAN scheme as a soft hint — not
  as a hard cross-product. The model → driver mapping lives in product
  matrix data we already have; the hard part is per-device family
  rules.
- **Package awareness in command responses.** Once
  `schema_nodes._package` is populated, every command-tree response
  should mention the providing package. Agents can then reason about
  "is this command unavailable, or is the package just not enabled?".

No code change in this audit pass. The previously-proposed `arch`
parameter on `routeros_command_version_check` is folded into this entry
— if we add `arch` there in the future, ship it in the
"suggestion-not-filter" mode described above so all three command-tree
tools behave consistently.

### ✅ Doc drift — `related` block listing missing `glossary` — DONE

Added `glossary` to `DESIGN.md` "Enriched response shape" example
(plus a clarifying line that `command_node` is a single object, not an
array, and that array buckets scale with `limit`); added it to the
North Star history entry; added it to the `CLAUDE.md` overview line and
the `routeros_search` row in the tool table. CLAUDE.md's "Folded into
routeros_search.related" paragraph already mentioned glossary, so no
change there. Recorded for history.

### 🟢 Browse REPL — paging + pass-through params

`[XX more results...]` isn't actionable — bump default limits, let pager handle it. Add general flag parser (`--limit`, `--version`, `--breaking`) so TUI exercises same surface as MCP.

**Partial (TUI polish round-2):** pager now accepts digit `1`–`9` to jump directly to that page (status line shows `[1-N jump]` hint). Pass-through param parser still TBD — currently only dot-commands accept `key=value` form.

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

### 🟡 Cross-tikoci alignment — `explain → validate → run` for RouterOS commands

**Trigger:** none in the strict sense — this is the *direction* most other
backlog items implicitly serve. Capture the design intent here so future
work (canonicalize hardening, package metadata, code-mode tools) can
cite it.

**Status:** rosetta is tier-1 (read-only docs / schema / glossary),
canonicalize.ts in rosetta and lsp-routeros-ts is the start of tier-2
(parse + classify), tier-3 (run on a router) does not exist as a
tikoci-owned MCP yet. There is a third-party
[`jeff-nasseri/mikrotik-mcp`](https://github.com/jeff-nasseri/mikrotik-mcp)
that takes the API↔MCP-mapping route — see "Why API↔MCP-mapping isn't
the answer" below.

#### The three-tier picture (what we are building toward)

| Tier | Scope | Connects to a router? | Owns the trust property |
|---|---|---|---|
| **1. Rosetta** (this repo) | RouterOS docs, command tree (46 versions), properties, devices, changelogs, glossary, skills. SQL-as-RAG over an offline DB. | **No.** "Rosetta does not modify or connect to a router" is a load-bearing trust claim. | Always read-only against a baked DB. The agent can call `routeros_search` 100 times and never touch a real device. |
| **2. Validator** (could live in rosetta or in a new MCP — open question) | Given a candidate command, return canonical form + args validated against schema + version bracket + package required + arch implications + breaking-change warnings from changelog. NO router connection. | **No.** Pure offline reasoning over rosetta + restraml `deep-inspect.json`. | Read-only over the validator's input data. Same trust property as tier 1, just a richer API. |
| **3. Runner** (separate MCP, NOT this repo) | Actually executes a command against a router via REST / SSH / API. Always re-validates server-side using tier 2 even if the calling agent skipped it. | **Yes.** This is the only place a tikoci MCP touches a real device. | Has to earn trust via auth, dry-run mode, audit log, idempotency hints. Out of scope here — capture only the *interface* it should accept from tier 2. |

The split exists so that the trust property (tier 1 never modifies) is
preserved even as we add tier-3 capability. An agent that wires up only
tiers 1+2 gets all the syntax/version reasoning a thoughtful operator
would do, with zero blast radius. Adding tier 3 then lets the agent
*finish* the loop without changing anything about how tiers 1+2 behave.

#### Why API↔MCP-mapping isn't the answer

`mikrotik-mcp` (and similar) expose each RouterOS REST endpoint as a
distinct MCP tool. That is faithful to the API but mismatched to how
LLMs fail on RouterOS:

- **Tool count explodes.** Every menu × every verb × every version
  shape becomes a tool. The 13-tool ceiling we hold ourselves to here
  exists for a reason — once a model has 100+ tools, selection
  accuracy collapses and descriptions get truncated.
- **Forces the model to fabricate.** RouterOS has hundreds of property
  names, many overloaded across menus (`disabled`, `chain`, `name`).
  Training data covers the famous ones inconsistently. With API-shaped
  tools the agent must guess property names to fill the input schema —
  the worst place to be wrong, because the call leaves the model and
  hits the router.
- **No room for "ask docs first" behaviour.** When the only surface is
  the router itself, every wrong guess is a real call. With a docs
  tier in front, wrong guesses are turned into "you might mean…"
  responses.
- **Where it does work:** simple, well-known commands (`/system/identity/print`,
  `/ip/address/print`). Useful for inspection. The tier-3 runner we
  describe should *cover* those uses too — but with rosetta-grounded
  validation in front of writes.

Our position: agents arrive with surprisingly good RouterOS intuition
from training (VLAN semantics, firewall chains, basic CLI shape), and
surprisingly bad recall on the specifics that matter (exact property
names per version, package requirements, which CAPsMAN scheme a wifi
driver belongs to). Rosetta's job is to fill in the second list cheaply
so the model's first list isn't wasted.

The horse/water framing applies here: we can't force the agent to call
rosetta before guessing. But the existing `limit=` "hunger knob",
`related` block, glossary, and skills surface are all about making the
*one* call a thoughtful agent does make return enough context that the
guessing stops.

#### The fix-and-retry loop — modelled on tikapp.html WebMCP

`~/GitHub/restraml/docs/tikapp.html` registers a working WebMCP surface
for the `/app` YAML editor. The pattern we want to mirror for RouterOS
commands is right there:

- **`set_tikapp_editor_content`** writes YAML AND validates in the same
  call, returning `{ ok, valid, status, message, errorCount, errors[],
  schemaVersion, validationError }`. The tool description literally
  tells the agent: *"This call is only fully successful when ok=true
  and valid=true. If ok=false, read errors and call this tool again
  with corrected YAML."* Reported to work well with Gemini 2.5 (try →
  error → fix → retry → valid in one chain).
- **`get_routeros_app_yaml_schema_outline`** returns a compact schema
  summary plus `writingHints` written *for an agent*: "The required
  top-level key is services. Inline file contents belong under
  top-level configs…". Agent can ask for the schema before writing,
  then write against it.

Translating that pattern to RouterOS commands gives us three concrete
tool sketches (names are placeholders — name them when we ship):

1. **`routeros_explain_command(command, ros_version?, model?)`** —
   *Stepping stone, useful on its own.* Takes a candidate command
   string. Returns:
   ```text
   {
     canonical: { path, verb, args },           // from canonicalize.ts
     confidence,                                // 'high' | 'medium' | 'low'
     classified: { topics, version, device },
     args: [
       { name, type, default, valid_values?,
         description, present_in_versions, _from: 'schema_nodes' }
     ],
     warnings: [
       { kind: 'unknown-arg' | 'arg-removed-in-version' |
              'requires-package' | 'arch-not-in-our-data',
         message, suggestion }
     ],
     pages: [ ... ],                            // doc pages for the menu
     changelog_hits: [ ... ]                    // entries mentioning this path
   }
   ```
   Equivalent today would be 4–5 separate tool calls (`routeros_search`
   + `routeros_lookup_property` per arg + `routeros_command_version_check`
   + `routeros_search_changelogs`). Bundling them is exactly the
   "single roundtrip for a typical question" North Star principle
   applied to *write-shaped* questions.

2. **`routeros_validate_command(command, target_version?, target_model?)`** —
   Same input as `_explain` plus a target context. Returns the
   `_explain` shape with `warnings` upgraded into `errors[]` (typed
   the same way tikapp's validator does — `path`, `arg`, `kind`,
   `message`, optional `suggestion`). The tool description should be
   blunt: *"Only fully successful when `ok: true`. Otherwise read
   `errors` and call again with a corrected command."* Same loop
   shape Gemini 2.5 handles in tikapp.

3. **`routeros_validate_script([command1, command2, ...], context)`** —
   Bulk validate. Returns per-command `{ ok, errors[] }` plus a
   *script-level* annotation: which commands `read` vs `modify` vs
   `delete`, which depend on others (`add` then `set` referencing the
   added item), which would survive a reboot vs not. Lets the agent
   report a plan to the human before any tier-3 call. This is also the
   shape a tier-3 runner should accept: validate the whole script
   first, run the whole script, return per-command results.

The runner (tier 3) becomes mostly mechanical at that point: run each
validated command, attach the actual response, surface validator
warnings the agent ignored. Validation lives in tier 2 either way; the
runner just enforces it.

#### Code-mode (Parra) — what it actually buys us for RouterOS

David Parra's Anthropic Code Conf talk
(<https://youtu.be/v3Fr2JR47KA>) argues that letting the model write
small programs that orchestrate MCP tool calls in one round-trip beats
tool-call-per-turn for cost, latency, and composability. RouterOS-shaped
example: *"validate this 30-line firewall config against 7.22 on a
hAP ax² and tell me which rules might fail."* Today the agent must
call our 13 atomic tools 30+ times. With code mode it writes:

```ts
// pseudo: agent snippet inside a hypothetical run_query tool
const results = []
for (const line of script) {
  const r = explainCommand(line, { ros_version: '7.22', model: 'hAP ax²' })
  if (r.warnings.length) results.push({ line, warnings: r.warnings })
}
return results
```

Concrete code-mode primitives rosetta could eventually expose:

- **`run_query(snippet)`** — sandboxed JS/TS with access to a typed
  surface mirroring `query.ts` (`searchAll`, `getPage`,
  `lookupProperty`, `browseCommands`, `checkCommandVersions`,
  `explainCommand`). Returns whatever the snippet returns, capped by a
  budget.
- **Bulk-shaped tool variants** — `lookupPropertyMany`, `searchMany`,
  `explainCommandMany` — useful even without code mode, and required
  for code mode to not N+1.
- **Tighter response schemas** — code-mode inner loops want flat
  arrays of small objects, not the agent-friendly prose-plus-related
  shape we ship today. We may want a `format: 'compact' | 'rich'`
  param on the heavy tools so a code-mode caller can opt out of
  next-step hints and excerpts they will not show to a human.

Not free: sandboxing (Bun has WASM and V8 isolates, or we could ship a
small DSL), token budgeting per snippet, error-shape consistency. The
win is real for the validate-a-script use case; iffy for one-off
questions that are already well-served by `routeros_search`.

#### What rosetta should add NOW to enable tier 2/3 (concrete, ordered)

Strictly within rosetta's "no router connection" scope, in the order
that pays for itself:

1. **`routeros_explain_command`** as a real MCP tool (sketch above).
   Bundle of 4–5 existing query functions; reuses canonicalize.ts
   with the DB resolver we just shipped. No new schema. Agent value
   is immediate and per-call cost is comparable to one
   `routeros_search`. This is the smallest concrete next step.
2. **Confidence-flag plumbing into `routeros_search` /
   `routeros_lookup_property` results.** Canonicalize already
   produces `confidence`; surface it in `classified.confidence` on
   `searchAll()` and as a per-result field on lookup. Tier-2 tools
   downstream will gate on it.
3. **Package metadata on `schema_nodes._package`.** Already a
   placeholder column. Higher leverage than arch — a validator that
   says "this command needs `wifi-qcom` which is not present on
   x86 CHR" is far more useful than one that says "we have no x86
   data for this command." Pairs with the arch entry above.
4. **`routeros_validate_command`** — once `_explain` ships and we
   have package metadata, `validate` is mostly a wrapper that
   upgrades warnings to errors based on a target context.
5. **Bulk variants** of `_explain` / `_validate` for code mode.
6. **`run_query(snippet)`** — explore only after 1–5 land. Sandbox
   choice and shape are downstream concerns the user explicitly
   parked.

Items 1–3 are also interesting on their own — even without ever
shipping tier 3, an explainer + confidence + package metadata makes
rosetta's existing search noticeably better for write-shaped
questions, which is currently its weakest suit.

#### Open design questions (worth flagging, not deciding now)

- **Where does the validator live?** Inside this repo (rosetta tools
  18, 19, …) or as a separate `tikoci/routeros-validator` MCP that
  declares rosetta as a runtime dependency? Trade-off: same-process
  is one less moving part for users; separate-process keeps the
  "rosetta is read-only docs, full stop" framing crisp. Lean toward
  in-process for now — `_explain` is just a query bundle and
  packaging it as its own MCP would dilute the trust claim more than
  it helps.
- **Does the validator call `/console/inspect` on a real router for
  edge-case completion?** Today restraml's deep-inspect data covers
  x86 + arm64 latest. For unrepresented arches (MIPSBE, ARM 32-bit)
  or older versions the validator quality is bounded. A permanent
  router rig owned by restraml CI is the path — already flagged in
  the arch-as-suggestion entry. Validator quality tracks inspect
  data freshness; that is a feature, not a bug.
- **Cross-pollination with `lsp-routeros-ts`.** A
  `routeros_validate_command` is essentially an LSP `textDocument/diagnostic`
  on a one-line buffer. We could share validation logic the same way
  we already share `canonicalize.ts`. Worth a sketch when LSP picks
  up the H4 resolver work — same vendoring discipline.
- **Trust labelling on every response.** Validator output should
  always carry a `validated_against: { ros_version, arch,
  inspect_source, package_check: 'on'|'off' }` block so the agent
  (and the human reading agent output) knows what was checked. We
  already do something similar via `confidence`; this extends it to
  the validation layer.
- **Where rosetta ends and the runner begins.** The strict line:
  rosetta is allowed to *return* commands it would run, but never
  run them. If we ever feel pressure to relax that (e.g., "but we
  could just hit upgrade.mikrotik.com…"), we already do — that is
  `routeros_current_versions`. Limit network calls to read-only
  public endpoints documented in the tool description. Anything
  router-specific belongs in tier 3.

#### Why this is the cross-tikoci core

Most of the project map in `~/GitHub/CLAUDE.md` is implicitly serving
this picture:

- `restraml` produces the inspect schema the validator needs.
- `rosetta` produces the prose context the agent needs to *want* to
  validate (and the corpus the validator pulls from).
- `lsp-routeros-ts` is the same validator shape, rendered for IDEs
  instead of MCP.
- `routeros-skills` adds opinionated "how to do this on RouterOS"
  guides the agent can pull in alongside docs.
- `quickchr` gives restraml the iteration loop to refresh inspect
  data without a real device.
- Future runner (wherever it lives) closes the loop.

Capturing this so future backlog items can say "this serves
explain/validate/run" instead of re-deriving the picture each time.

### 🟡 MCP-client diversity is the deployment gate (cross-tikoci)

**Companion to the explain → validate → run entry above.** The user
flagged this as the issue they are *actively mulling* — it is the gating
question for the cross-tikoci direction, not the tool surface itself.

**Problem.** "Install rosetta" today means a different ritual depending
on the client: Claude Desktop wants `claude_desktop_config.json`,
Claude Code wants `~/.claude/settings.json` or `mcp.json`, VS Code
Copilot wants `.vscode/mcp.json` *or* a workspace-level extension hook,
Copilot CLI has its own path, Codex has yet another, Cursor and web
clients each differ again. Even with `bunx @tikoci/rosetta` collapsing
the *runtime* story, the *config* story is N-fold. Adding a separate
validator MCP and an eventual runner MCP multiplies that — three
config blocks per client. Users will not put up with it.

**Constraints.**

- Bun is a hard runtime requirement for rosetta (`bun:sqlite`,
  `Bun.serve`, etc. — see root `~/CLAUDE.md`). Any "minimal" wrapper
  must accept that.
- Trust property must survive: rosetta has to remain identifiable as
  read-only, even when bundled with a write-capable runner. If a user
  cannot tell *at install time* which tools touch a router, the trust
  story is gone.
- We are not in a position to ship per-client installers ourselves;
  the matrix grows and we do not own those clients.

**Possible directions** (capture, do not decide here):

1. **VS Code extension as opinionated host** — extends
   `vscode-tikbook` (Theme 3 already prototypes rosetta MCP injection
   via `mcp.json`). The extension becomes the *single* install step:
   "install TikBook" pulls in rosetta MCP + the LSP + (eventually) a
   validator and offers the runner as a prompted opt-in. Pro: one
   install for the most common tikoci user (network admin in VS Code).
   Con: only covers VS Code; Claude Desktop / Code / others still need
   their own path. Also conflates "use TikBook" with "use rosetta MCP"
   when many users want one without the other.

2. **Single MCP identity, multiple tool prefixes** — one `tikoci`
   MCP that exposes `routeros_*` (rosetta), `routeros_validate_*`
   (validator), and (gated, opt-in) `routeros_run_*` (runner) tools.
   Pro: one config block per client. Con: tool count balloons past
   the 13-tool ceiling rosetta deliberately holds; trust labelling
   gets harder; one bug takes everything down.

3. **`bunx @tikoci/install <client>`** — an opinionated installer
   CLI that knows the config conventions of the major MCP clients
   and writes the right blocks. Pro: keeps each MCP small and
   independent; user runs one command. Con: we own the client matrix
   forever; clients change their conventions.

4. **Status quo + per-client docs** — what we do today. Pro: nothing
   to maintain. Con: every additional tikoci MCP makes this worse;
   already a tax for users with rosetta + the LSP.

**Position to take (initial lean, revisit):** path 1 (VS Code
extension as the *primary* curated install) for the "I am a network
admin in VS Code" user, plus path 4 (per-client docs) for everyone
else. Path 2 stays off the table because it dilutes the trust
property. Path 3 is the back-pocket option if the docs surface gets
too noisy.

**Why park this here.** The explain → validate → run design is
useless if it cannot land in front of users. Decide the install
strategy (or at least which paths are out) before scaling MCP-tool
count past today's 13. Most cross-tikoci backlog items implicitly
assume "and then users will install both" — flag the assumption.

**Cross-references.**

- `vscode-tikbook/ROADMAP.md` Theme 3 — rosetta MCP bundling prototype.
- `vscode-tikbook/ROADMAP.md` Theme 6 — Copilot integration surfaces.
- `tikoci-crossref` skill — "MCP-client diversity is the deployment
  gate" learning under "Critical Cross-Project Learnings."

---

## Improvements (smaller, not urgent)

### 🟢 MCP considerations from TUI round-2

Items the TUI cleanup surfaced that *also* apply to the agent-facing MCP surface (most TUI fixes are pure UX and don't need MCP equivalents — these two do):

- **Structured highlights in search responses.** FTS5 `snippet()` returns `**…**` boundary markers. Agents currently see them as literal asterisks inside JSON string values. Consider returning a sibling `highlights: [{ start, end }]` array (offsets into the excerpt text) alongside the raw text, so clients can render bold/colour without parsing the markers themselves. The TUI now post-processes `**…**` → ANSI bold in dot-command output as a stopgap.
- **`routeros_current_versions` enrichment.** WinBox 4 version is now returned
  in-band (no flag — confirmed in tool description + response shape). Still
  open as an opt-in `additional_data=true` flag: download URLs
  (mikrotik.com/download per channel) and tikoci-sourced refs (restraml
  inspect.json index, OpenAPI3, `/app` YAML schema). All tikoci refs MUST be
  flagged with provenance ("from tikoci/restraml — community, not official
  MikroTik"). Helps agents construct download links and locate machine-
  readable specs without a separate web search.

### 🟢 Stop words — post-classifier

Context-dependent stop words are exactly what `classifyQuery()` will handle. NL questions should stop-list "set"; command input should keep it. No action until classifier ships.

### 🟢 Usage analytics

Local-only `usage_log` table, opt-in via `ROSETTA_LOG_USAGE=1`. More important after North Star ships — measures whether consolidated search replaced specialized tools.

### �� Agent-assisted linking (remaining ~8% of command dirs)

Targeted manual review of WiFi, LoRa, scripting to close highest-value gaps.

### 🟢 LSP integration

`lsp-routeros-ts` hover handler should consume property data. Consumer-side work — data is ready.

**`canonicalize.ts` parity (issue #5).** rosetta and `lsp-routeros-ts` both vendor `canonicalize.ts` and intentionally diverge only in their `CanonicalizeOptions.isVerb` backend (rosetta: DB; LSP: static `verbs.json` + `/console/inspect highlight`). The hardening roadmap from the cross-project audit is tracked in [issue #5](https://github.com/tikoci/rosetta/issues/5):

- ✅ **H4** — pluggable `isVerb` resolver (shipped 2026-04-26). rosetta wires DB-backed; LSP can pick this up by diff once it has a verbs source.
- ✅ **H6** — `extractMentions(input)` for navigation-only path references (shipped 2026-04-26).
- ✅ **H7** — BOM / zero-width space tolerated (shipped 2026-04-25).
- ✅ **H8** — `confidence` flag on each `CanonicalCommand` (shipped 2026-04-26).
- ⬜ **H1** — `mode: 'strict' | 'lenient'` to drop leading prose words and split mid-line slashes. Biggest remaining item for prose / chat-style input.
- ⬜ **H2** — dedicated `Tok.Var` for `$identifier` so vars never become path segments.
- ⬜ **H3** — re-audit paren `(…)` expression scope independent of menu-specific verbs. The original `:if ($x = 1) do={ /log/info "yes" }` anchor was confounded by H4 (`/log/info` is not a command in the current DB); recognized body commands are preserved today.
- ⬜ **H5** — `{ … }` after `key=` treated as a literal block value, not a recursive scope.

**Cross-side artifacts.** Issue #4 proposes publishing `routeros-docs-links.json` (path → URL/title for ~551 dirs) as a CI artifact; H4 suggests doing the same for `verbs.json` so LSP can ship a cmd/dir manifest without bundling the DB. Both are downstream-of-rosetta artifacts — safe to bundle once issue #5 H4 is also wired into LSP. Keep the curated universal verb fallback active alongside any resolver: rosetta's `commands` table does not enumerate all helper verbs (notably `find`) under every parent path, so a DB/static resolver should supplement universal verbs rather than replace them.

### 🟢 Browse REPL wishlist

Tab completion, history persistence (`~/.rosetta/browse_history`), raw SQL mode, export (JSON/CSV/Markdown), audit views (unlinked commands, pages without properties), bookmarks.

### 🟢 Video extraction — periodic retry

143 consistent-fail videos (likely rate-limited). Re-run after 48-72h gaps; add to `known-bad.json` after 4+ failures.

---

## MCP Behavioral Testing — research + roadmap (2026-04-22)

**Problem.** Current tests cover unit-level query functions, transport mechanics, schema health, and file/release structure (12 test files, ~5,700 lines). What they do **not** cover is the actual *behavior agents experience*: "given this user-style query, does `routeros_search` return the right page in the top-3? Does the `related` block surface what we expect? Did a recent extraction or query-planner tweak silently regress retrieval quality?" The TUI catches broad shape problems; nothing today catches subtle quality regressions in the agent-facing path.

**Constraints (Tikoci principles).**

- Open-source, low-cost — no monthly LLM bill for re-checking the same prompts.
- No telemetry baked into the shipping product. Anything user-visible must be opt-in and easy to disable.
- Prefer deterministic, in-repo checks over network calls. Reserve LLM judging for things that genuinely need semantic interpretation.
- Tests must justify their cost (CI minutes, maintenance, credits).

### ✅ Phase 0 — Golden-query retrieval set (no LLM, deterministic) — **DONE 2026-04-22**

Implemented in `src/eval/retrieval.ts` + `fixtures/eval/queries.json` + `fixtures/eval/baseline.json`. Run with `make eval`. 20 golden queries across 6 shapes; per-shape thresholds; baseline regression gating with 2pp tolerance; `--filter`, `--json`, `--update-baseline` flags; `requires_commands_min` skip mechanism for slim dev DBs (cmd-path shape needs full extract). Fixture format ended up as JSON (not yaml — Bun has built-in JSON, no extra dep). All metrics green on local dev DB at landing time: recall@5 100%, MRR 96%, classifier accuracy 100%.

**Real bugs surfaced during golden-set tightening (worth filing):**

- 🟡 **Changelog version-rollup gap.** Classifier extracts `version="7.22"` from "what changed in 7.22", but DB only has changelogs for the patch versions (`7.22.1`, `7.22.2`, …). `searchAll().related.changelogs` is silently empty. Either (a) classify rolls up a major version to "match any 7.22.*", or (b) the changelog query does a `LIKE '7.22%'` fallback when the exact version is missing. Either fix should preserve exact-match precedence. Caught only because the eval expected the related block to populate.
- 🟡 **Bridge VLAN ranking.** "Bridge VLAN Table" (the dedicated case-study page) ranks #6 for `bridge vlan filtering on a switch` — outside the default top-5. Other bridging/VLAN pages do rank, so this isn't a wrong-answer bug, but it suggests the title-weighted BM25 isn't pulling the most-on-topic page to the top. Worth a one-shot look at compound terms for "bridge vlan" / "VLAN table" before treating as a real regression.

### ✅ Phase 1 — Self-supervised query generation (auto-grow the golden set) — **DONE 2026-04-22**

Implemented in `src/eval/self-supervised.ts` + `fixtures/eval/self-supervised-baseline.json`. Run with `make eval-self`. Auto-generates ~170 deterministic queries from sections, properties, and page titles using a seeded RNG (splitmix32 with constant `0xC0FFEE`) — no `Math.random()`, baselines diff cleanly across runs. Per-strategy thresholds: title hit@5 ≥ 90%, section hit@10 ≥ 65%, property hit@10 ≥ 55%, overall MRR ≥ 45%. Cmd-path strategy auto-skips when `commands` table has < 1000 rows (slim dev DB). 5pp regression tolerance (vs Phase 0's 2pp) accounts for auto-gen noise. Final metrics on dev DB: title hit@5 100%, section hit@10 85%, property hit@10 88%, MRR 65%.

### ✅ Phase 2 — Tool-shape contract + token-budget tests — **DONE 2026-04-22**

Implemented in `src/mcp-contract.test.ts`. Runs inside `bun test`. 17 assertions across three blocks: (A) frozen 13-tool registry + workflow-arrow (→) convention, (B) token-budget guardrails on 10 canonical queries (`tokens(x) = ceil(JSON.stringify(x).length / 4)` — guardrail not precision; all queries currently use 20–32% of budget), (C) response-shape invariants for 5 representative queries (top-level keys exist, classifier output matches expected subset, `pages` is a bounded array, `related` buckets hold non-empty arrays or a single object for `command_node`, `next_steps` is an array). No new deps (no `tiktoken`). Block C originally used `toMatchSnapshot`, but the snapshot file was captured on a slim dev DB and diverged from the full CI-built DB (more populated `related_buckets`: `changelogs`, `videos`, `command_node`, `commands`). Switched to explicit invariants that hold on any populated DB — the snapshot surface was re-solving what Phase 0 already does for corpus-linked expectations.

Tool-surface change ritual documented in `CLAUDE.md` (under "Changelog discipline"): updating the registry requires touching both `src/mcp.ts` and `EXPECTED_TOOLS` in the test, plus a `CHANGELOG.md` entry. Description-only edits don't trigger the test.

**Real findings (Phase 2):**

- 🟢 **Two tools lack the `→ next_tool` workflow-arrow convention:** `routeros_stats` and `routeros_current_versions`. Both are terminal/informational, but the convention says every tool should suggest a follow-up. The Phase 2 contract test currently allows these two as documented exceptions. Suggested next steps: `stats → routeros_search`, `current_versions → routeros_search_changelogs`. Small `mcp.ts` edit when convenient.

**Review findings + follow-ups (2026-04-22 post-land):**

- ✅ **Snapshot corpus-coupling (two rounds).** Round 1: initial redaction kept `{id, title}` for each page → every Confluence re-export would churn snapshots. Loosened to counts + classifier output. Round 2 (triggered by first CI release attempt): even count-based snapshots broke because the slim dev DB had fewer `related_buckets` (no `videos`/`command_node`/`commands`/`changelogs`) than the full CI-built DB. Replaced snapshots entirely with explicit shape-invariant assertions that work on any populated DB. Corpus-linked expectations belong in Phase 0's golden set (the right surface for "this page should rank"), and response-shape correctness is now asserted directly.
- ✅ **Dedicated Phase 2 CI pickup on release.** Block B/C still skip inside the *shared* full-suite `bun test` process when another test has pinned `db.ts` to `:memory:`. `release.yml` compensates with a separate `bun test src/mcp-contract.test.ts` step after the full suite: the file starts in a fresh process with a real DB and the token-budget + snapshot checks actually execute. Block A still runs in the full suite too. The longer-term cleanup remains the same "Test isolation — DB-leak guards" idea (pass a DB handle into `query.ts` instead of reading the singleton).
- 🟡 **`test.yml` intentionally does NOT get the dedicated step.** A clean `push` / `pull_request` CI checkout has no `ros-help.db` (the file is gitignored and only built in `release.yml`), so a dedicated `bun test src/mcp-contract.test.ts` there would find an empty DB and skip B/C anyway — redundant with Block A from the main run. The contract test's guard is defensive (`getDbStats()` wrapped in try/catch) so clean checkouts cleanly skip instead of crashing. When we eventually land a small committed fixture DB (or seed one at CI start), revisit wiring `test.yml` too.
- ✅ **CI wiring — Phase 0 + Phase 2 wired to `release.yml`.** `release.yml` runs Phase 0 (`bun run src/eval/retrieval.ts`) as a non-blocking post-extract step and the dedicated real-DB Phase 2 contract test. Phase 1 stays local-only for now (noisier, auto-gen).
- 🟡 **Baseline rebuild cadence.** `fixtures/eval/baseline.json` and `self-supervised-baseline.json` are committed metrics on the *current local* DB. Each real DB refresh will drift. 2pp (Phase 0) / 5pp (Phase 1) tolerance absorbs small moves; larger moves need `--update-baseline` in the DB-refresh commit. Document this as part of the HTML-export refresh ritual when we next re-extract.
- ✅ **Phase 1 determinism now holds across all strategies.** The initial cmd-path sampler used SQL `ORDER BY RANDOM()` and would have churned the sample set on a full DB. Fixed by selecting a stable ordered set and applying the same seeded JS shuffle (`0xC0FFEE`) as the other strategies. This keeps `self-supervised-baseline.json` reproducible across runs on the same DB.
- 🟢 **Two real bugs Phase 0 surfaced are ready to fix** — changelog version-rollup (already tracked above) and the two missing workflow arrows. Both are small, both prove the framework's value. Do before Phase 3.

### 🟡 Phase 3 — Local-LLM judge (free, opt-in, never CI-default)

For the small set of queries where structural checks aren't enough — "is this excerpt actually relevant?" type questions.

- **Tool:** `ollama` running Llama 3.2 3B, Qwen 2.5 3B, or Phi-3.5 mini. All quantized, all free, all run on a developer laptop.
- **Use:** `bun run src/eval/judge.ts --model llama3.2:3b` — runs the golden set, asks the local model to score each top-1 result on a 3-point rubric ("relevant / partially / not"). Outputs a delta vs the previous run.
- **Boundary:** never runs in CI by default. Documented as "opt-in deeper check, run before a release or after a query-planner change."
- **Why local:** zero credit cost, fully reproducible (fixed model + temperature=0), no privacy concern, no dependency on a paid API key.

### 🟢 Phase 4 — Cheap remote judge (gated, batched, cached)

Only after Phases 0–2 are stable, and only for queries where local-LLM judgment proves insufficient.

- **Models:** Gemini 2.0 Flash, GPT-4o-mini, or Claude Haiku — pennies per run for ~50 queries.
- **Caching:** key on `(query, response_hash)` — only re-judge when retrieval output actually changed. A run where nothing regressed is effectively free after the first time.
- **Trigger:** manual `bun run src/eval/judge-remote.ts` or weekly scheduled workflow with `workflow_dispatch`. Never on every PR.
- **Budget guardrail:** print estimated cost before running; abort if over a configurable cap (default $0.50/run).
- **Backpocket only:** capture the design now so we're ready if Tikoci picks up traction and someone wants to wire it in.

### 🟢 Phase 5 — Differential testing across DB builds

Pure-SQL, no-LLM way to catch extraction regressions without needing a curated query set.

- Run the golden set against two DB builds: previous release artifact (downloaded from GHCR `sha-*` tag) vs HEAD's `ros-help.db`.
- For each query, diff the top-3 page IDs. Flag any query whose top-3 changed; CI emits a markdown table to the PR.
- Most changes will be benign (new pages from a fresher Confluence export). Worth manual review when extraction logic itself changed.
- Free, deterministic, catches "this commit accidentally broke `extract-html.ts`" regressions before release.

### 🟢 Out-of-the-box ideas worth keeping in mind

- **Mutation testing for queries.** Build a small synonym/typo table once (e.g. "firewall" ↔ "fw", "filter" ↔ "filtering"), generate variants of each golden query, assert the expected page still ranks top-5. Catches over-fitting in `compound terms` and the classifier without an LLM in the loop.
- **TUI session log → eval corpus.** The DEFERRED "TUI session log" item gets new value here: opt-in local-only logging captures *real* user query shapes, which become next month's golden set. Stays on the user's machine; never shipped. Pairs naturally with the existing `usage_log` idea (also opt-in, also deferred).
- **Existing frameworks evaluated.** Promptfoo (YAML configs, MCP support, Ollama grader — best fit for Phase 3/4 if we don't roll our own), mcpvals (TS/Bun-friendly, Apache-licensed, golden + LLM-scored), DeepEval (Python — wrong stack), mcp-as-a-judge (middleware for AI coding gates — wrong use case). Recommendation: Phases 0–2 are small enough to write directly without a framework (~200 LOC total); revisit Promptfoo if/when we hit Phase 3.

### Ordering rationale

Phase 0 alone closes the biggest gap. Phases 1–2 are additive and stay free forever. Phase 3 is the first thing that needs *any* infrastructure (Ollama install) but still costs zero credits. Phase 4 is in the back pocket for when traction warrants it. Phase 5 is independent and can land any time after Phase 0 — it's the "did extraction regress?" guard that fits the `release.yml` flow naturally.
