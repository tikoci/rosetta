# Backlog — rosetta

> Ideas, considerations, and future work. Anything that isn't "how the project works" (→ `CLAUDE.md`) or "why it's built this way" (→ `DESIGN.md`) goes here.
>
> **Convention:** Agents should add items here under the appropriate heading rather than creating new files. Include enough context that a different agent (or human) can act on it later without the original conversation.

## Ready to Build

Items with clear scope and no blockers.

### ~~Fix CI workflow so tests actually pass~~ ✓ DONE

Fixed in v0.2.0. Tests use in-memory SQLite — no DB file needed. The original failure was from an earlier codebase state. Re-enabled `push` and `pull_request` triggers on `main` branch. Also added `release.yml` workflow for CI-built database + release artifacts.

Note: actions/checkout@v4 emits a Node.js 20 deprecation warning — update to a version that supports Node.js 24 before the June 2026 deadline.

### ~~Section-level page chunks for large pages~~ ✓ DONE

Implemented. 2,984 sections across 275 pages extracted from h1–h3 headings with anchor IDs. `get_page` returns a table of contents (heading + char_count + deep-link URL) when `max_length` is exceeded and sections exist. `section` parameter on `get_page` retrieves specific sections by heading text or anchor_id. No new MCP tool — extended `get_page` instead. Deferred `sections_fts` as unnecessary for current use case (TOC + section retrieval don't need FTS).

### ~~Device/product data (Phase 1)~~ ✓ DONE

Implemented. 144 products from `matrix/2026-03-25/matrix.csv` loaded into `devices` table with `devices_fts` FTS5 index. Single MCP tool `routeros_device_lookup` combines exact match (by product name/code) with FTS search + structured filters (architecture, min_ram_mb, license_level, has_poe, has_wireless). Extractor `src/extract-devices.ts` is idempotent (DELETE + INSERT), handles UTF-8 BOM, normalizes RAM/storage to MB integers. Added to `extract` and `extract-full` Makefile pipelines. 69 tests passing (15 new for device queries). CSV stored in git — manually downloaded from mikrotik.com/products/matrix.

### ~~Device test results + block diagrams (Phase 2)~~ ✓ DONE

...sults (ethernet + IPSec throughput benchmarks) for 125 of 144 devices, plus block diagram URLs for 110 devices. New `device_test_results` table with `product_url` and `block_diagram_url` columns on `devices`. Test results auto-attach to `device_lookup` results for exact matches and small result sets (≤5). Extractor `src/extract-test-results.ts` uses multi-slug URL candidate strategy (4–6 variants per product). 15 products originally had no discoverable page — resolved via sitemap + override table (see "Product page slug coverage" ✓ DONE below).

### ~~Command diff tool (upgrade breakage diagnosis)~~ ✓ DONE

Implemented as `routeros_command_diff`. Given `from_version` and `to_version`, returns added/removed command paths with counts. Optional `path_prefix` scopes the diff to a subtree (e.g., `/ip/firewall`, `/routing/bgp`). Returns a note when either version is outside the tracked range (7.9–7.23beta2). Tool description includes a 3-step workflow: `command_diff` → `search_changelogs` → `command_version_check`. Tests in `query.test.ts`. Pairs with `routeros_search_changelogs` for human-readable changelog entries.

### ~~Add remote MCP transport mode for ChatGPT Apps~~ ✓ DONE

Implemented. Streamable HTTP transport via `--http` flag using `Bun.serve()` + `WebStandardStreamableHTTPServerTransport` (MCP spec 2025-03-26). Endpoint: `/mcp`. Supports `--port`, `--host`, `--tls-cert`/`--tls-key` flags and env vars. Defaults to localhost binding; LAN binding (`--host 0.0.0.0`) logs a warning. Origin header validation prevents DNS rebinding. `--setup` prints HTTP config snippets alongside stdio configs. Stdio remains the default for local clients.

### ~~Device AKA matching — Phase 1 (separator normalization + slug-normalized path)~~ ✓ DONE

Investigated 2026-04-04. Tested 27 common MCP-user alias patterns. Two fixes shipped:

1. **Dash/underscore-split LIKE** — query split changed from `/\s+/` to `/[\s\-_]+/`. Fixes `rb5009-out` → `RB5009UPr+S+OUT`, `hap-ax3` → `hAP ax³` (via LIKE), `hap_ax3` → `hAP ax³`, `knot_emb_lte4` → `KNOT Embedded LTE4*` etc.
2. **Slug-normalized LIKE fallback** — when all LIKE/FTS paths fail, strips all non-alphanumeric chars from both the query and `product_url` slug (`REPLACE(url,'_','')`), then tries `LIKE '%/product/%{normalizedQuery}%'`. Min length: 5 chars. Fixes `hapax3` → `hAP ax³`, `hapax2` → `hAP ax²`, `wapaxlte7` → `wAP ax LTE7 kit`, `fiberboxplus` → `FiberBox Plus`, `sxtsq5ax` → `SXTsq 5 ax` (once product_url is populated).

**Key signal:** MikroTik's own web team uses a distinct naming convention for URL slugs — these are essentially a "second taxonomy" of product names used consistently throughout the website. The slug is the most common form users copy from browser URLs or site searches. Indexing it as a first-class AKA source is the right call.

**Coverage after fixes** (against live DB, 2026-04-04):
- Products with existing product_url: all AKA forms resolve ✓
- 15 previously-missing devices with NULL product_url: slug-normalized path can't help until `extract-test-results.ts` re-runs (which will populate product_url via the sitemap fix)

**Remaining failures after Phase 1** (fixed in Phase 1.5 below):
- ~~`hap ax 3` → returns 4 results (digit `3` filtered as too-short term; `hap ax` matches 4 products)~~ ✓ Fixed
- ~~`rb5009` → returns 3 variants with no disambiguation context~~ ✓ Fixed
- `hex 2024` / `hex_2024` → returns 7 results (`hEX refresh` has NULL product_url; "2024" not in name) — still needs alias table (Phase 2)
- `chateaulte18` → MISS until product_url populated — resolved once extract-test-results re-runs with sitemap fix

### ~~Device AKA matching — Phase 1.5 (superscript normalization + disambiguation)~~ ✓ DONE

Implemented 2026-04-05. Three improvements to `searchDevices()` in `query.ts`:

1. **Unicode superscript normalization** — bidirectional: queries are normalized to ASCII at entry (`normalizeDeviceQuery()`), and `product_name` is normalized in SQL via nested `REPLACE()` calls (`NORMALIZE_PRODUCT_NAME()`). Handles `²`↔`2`, `³`↔`3`, `¹`↔`1`. Fixes `hap ax3` → exact match `hAP ax³`, `hap ac2` → exact match `hAP ac²`, and Unicode-in-query `hAP ax³` → exact match too.
2. **Single-digit LIKE term preservation** — the `t.length >= 2` filter that dropped single-char terms now keeps single digits when accompanied by longer terms (≥2 chars). Fixes `hap ax 3` → 1 result `hAP ax³` (previously returned 4 because `3` was dropped).
3. **Multi-match disambiguation notes** — `disambiguationNote()` detects common prefix among results, then identifies key differences (enclosure IN/OUT, PoE in/out, wireless chains, LTE). Returns a human-readable string in the `note` field. Example: `rb5009` → 3 results + note mentioning enclosure and PoE output differences.

**Verified against real DB** (2026-04-05): `hap ax3` ✓, `hap ax 3` ✓, `hap ac2` ✓, `hAP ax³` ✓, `hap be3` → `hAP be³ Media` ✓, `rb5009` → 3 variants with disambiguation ✓, `rb5009-out` → 1 result ✓, `hap ax` → 4 results with PoE note ✓.

10 new tests + 5 new device fixtures added to `query.test.ts`. All 142 tests pass.

## To Investigate

Items that need research or experimentation before they're actionable.

### SafeSkill automated security scan — review notes (2026-04-06)

Reviewed https://safeskill.dev/scan/tikoci-rosetta (v0.4.0 scan, 107 findings, overall score 73).

**Fixed:**
- `scripts/build-release.ts`: replaced `execSync(joinedString)` with `spawnSync("bun", argsArray)` and `spawnSync("zip", argsArray)`. The old pattern passed a shell-joined string through `/bin/sh`, creating a shell injection surface even though all inputs were controlled. Array-form bypasses the shell entirely. Also collapsed the identical `if (windows) / else` zip branches.
- Added `SECURITY.md` with reporting process, scope, and HTTP transport security notes. Standard practice for npm packages; improves SafeSkill transparency score.

**Dismissed (false positives):**
- "Spawns child process" on `RegExp.exec()` in `extract-html.ts` — SafeSkill pattern-matched on the word "exec" incorrectly.
- "Data flow: os.homedir → fetch" in `setup.ts` — `os.homedir()` builds a local DB file path; the download URL is hardcoded. No actual data flows to a network sink.
- All other child_process findings in `bin/rosetta.js` (Node→Bun delegation), `extract-all-versions.ts`, and `scripts/` — these are build tooling / npm shim, not the runtime MCP server. SafeSkill is designed for MCP AI tools and treats build scripts as production code.
- "Command injection: execSync('which bunx')" in `setup.ts` — hardcoded string, no injection surface.
- "Data flow: readFileSync(package.json) → execSync" in the old `build-release.ts` — now fixed by array-form anyway.

**Remaining SafeSkill score gaps (not acted on):**
- "Code quality 1/5" — likely reflects test coverage or strict TypeScript settings. Not worth chasing SafeSkill's metric blindly.
- "Transparency 3/7" — improved by adding `SECURITY.md`. Could further improve with `CODE_OF_CONDUCT.md` if the project grows a contributor community, but overkill now.
- "Prompt injection 18/20" — our tool descriptions are clean. Minor gap likely cosmetic.

### MikroTik /app auto-update behavior

The `/app` YAML supports `auto-update: true`, which is documented to pull the latest container image on each boot. This is set in our rosetta /app template. Initial testing on CHR 7.23beta5 confirms the app installs and runs correctly, but the auto-update pull-on-boot behavior needs verification across reboots with new image tags pushed. Specifically: does RouterOS pull `:latest` fresh on each boot, or does it cache by digest? Does it require `docker-tag-based-pulling` or `checking-for-updates`?

### ~~Product page slug coverage (15 missing devices)~~ ✓ DONE

Implemented in `extract-test-results.ts`. Two-layer approach:
1. **Sitemap validation** — `fetchSitemap()` fetches `https://mikrotik.com/sitemap.xml` once at extraction time, builds a `Set<string>` of all 543 valid product slugs. Generated candidates are prioritized when they appear in the sitemap set.
2. **Override table** — `SLUG_OVERRIDES` maps all 15 known-opaque product names to their correct sitemap slugs (derived from 2026-04-04 research). New products with predictable slugs are handled automatically by the sitemap validation; only truly opaque cases need the override table.

`buildSlugCandidates()` replaces direct `generateSlugs()` calls, priority: override → sitemap-validated generated → raw generated fallback. Sitemap fetch errors are non-fatal (falls back to heuristics only). Coverage goes from 129/144 (89%) to 144/144 (100%).

### Device AKA matching — Phase 2 (aliases table for renames and versioned names)

**Investigated 2026-04-04, updated 2026-04-05.** After Phase 1 + 1.5, one failure mode remains:

**Renamed products** — Some products have a common user shorthand that refers to a new model with a completely different name:
- `hex 2024` → should find `hEX refresh` (E50UG). The word "2024" doesn't appear anywhere in the product name or code. MikroTik renamed it "refresh" but users call it "2024" because the URL slug is `hex_2024`. This is a genuine rename — no amount of tokenization can bridge it without an explicit alias.
- `hex s 2025` → correctly finds `hEX S (2025)` ✓ (product name contains "2025")
- `chateau lte18 ax` → exact match ✓ when extracted; `chateaulte18` → works once product_url populated via sitemap fix

~~**Problem 2: Versioned names with superscript digits**~~ ✓ Fixed in Phase 1.5 — bidirectional Unicode normalization + single-digit term preservation.

~~**Problem 3: Multi-match results lack context**~~ ✓ Fixed in Phase 1.5 — `disambiguationNote()` detects enclosure/PoE/wireless/LTE differences.

**Recommended approach for remaining gap:**
1. **`device_aliases` table** — `(alias TEXT, device_id INTEGER)` with explicit mappings for known renames. Would handle `hex 2024` → `hEX refresh`, future rebrands, etc. Keep it small: only aliases that can't be derived from names/codes/slugs.

**Signal insight:** The URL slug naming is a second authoritative taxonomy — MikroTik's web team consistently uses it across the site, and it's what users copy from browser URLs. The Phase 1 slug-normalized path already leverages this. For renamed products, the slug IS the AKA: `hex_2024` is the "real name" of `hEX refresh` as far as search is concerned.

**Trigger:** Address when user reports false-empty on a renamed product, or when adding new products that have breaking renaming patterns.


### Tool count and MCP client tool-list limits

At 14 tools, rosetta is approaching the practical limit where MCP clients start to struggle. Observations:
- Some clients display all tools in a flat list — 14+ entries with long descriptions is a wall of text for the model to parse at each turn.
- Claude Code and VS Code Copilot handle many tools well, but ChatGPT and some smaller-context clients may not.
- Each new data source (videos, changelogs, devices, tests) has added its own search tool, following the pattern. This pattern is clean but doesn't scale.

**Consolidation candidates (low coupling):**
- `routeros_search_videos` → fold into `routeros_search` (see "Unified search entry point" under Improvements)
- `routeros_search_tests` → fold into `routeros_device_lookup` (tests are always per-device; a `include_benchmarks` param would work)
- `routeros_stats` + `routeros_current_versions` → combine into a single `routeros_info` tool

**Keep separate (high coupling to distinct workflows):**
- `routeros_search` / `routeros_get_page` / `routeros_lookup_property` / `routeros_search_properties` — core doc workflow
- `routeros_command_tree` / `routeros_command_version_check` / `routeros_command_diff` — version/upgrade workflow
- `routeros_search_callouts` — unique content type agents specifically need

**Trigger:** Monitor how agents use the tools (see "Usage analytics" backlog item). If agents consistently ignore 3+ tools, consolidation is worthwhile. If they use them all in different contexts, the current split is fine.

### Debounce inspect.json fetches during extract-all-versions

`extract-all-versions.ts` spawns `extract-commands.ts` for each version sequentially, and each invocation fetches its inspect.json from GitHub Pages. With ~48 versions this means ~48 sequential HTTP fetches. Consider:

- Batch-prefetch all inspect.json files with concurrency control (e.g. 5 at a time) before spawning extractors
- Cache fetched files in a temp dir so re-runs don't re-download
- Pass fetched data via stdin or temp file instead of having each subprocess fetch independently

Not urgent — the current sequential approach works and GitHub Pages has no rate limit. But it's slower than necessary.

### List-format properties

Some pages use `<ul><li><strong>name</strong> (type; Default: value)</li></ul>` for read-only properties instead of `confluenceTable`. These are currently not extracted.

**Investigated 2026-04-04.** The assessment tool (`assess-html.ts`) already detects these. Results:

- **496 list-format properties** across **73 pages** (23% of all pages)
- Current table-format extraction: 5,130 properties — list-format adds 8.8% more
- Pattern is consistent: `<li><strong>name</strong> (type; Default: value): description</li>`

**Top pages by list property count:**

| Page | Count | Notes |
|------|-------|-------|
| Queues | 61 | CIR/MIR params, burst settings, PCQ classifiers |
| Hotspot customisation | 58 | HotSpot variables and template params |
| RADIUS | 46 | RADIUS attribute definitions (Service-Type, NAS-Port-Type, etc.) |
| Product Naming | 37 | Product code conventions (not really properties) |
| CRS1xx/2xx series switches | 25 | Switch chip feature flags |
| Packet Sniffer | 23 | Capture filter params |

54 of 73 pages have ≤5 list properties each (long tail).

**Recommendation:** Extract into the same `properties` table — same schema fits. Add to `extract-properties.ts` as a second pass after table extraction. The pattern is regular enough for reliable parsing. Queues, Hotspot, and RADIUS alone justify the effort — these are high-traffic reference pages for agents.

### Special hardware pages

Several pages contain device-specific tables that are uniquely valuable for agents — they're the only structured source for "does this router actually support X":

- **Switch Chip Features** (`ROS/pages/15302988`) — chip model → feature matrix
- **Marvell Prestera** (`ROS/pages/30474317`) — Prestera switch chip model table
- **Bridging and Switching** (`ROS/pages/328068`) — RouterBoard/Switch Chip Model table
- **Peripherals** (`ROS/pages/13500447`) — supported USB/LTE/etc. peripherals

These are worth extracting into dedicated tables or enriching the device data. If MikroTik renames/moves these pages, that's a signal "something important changed."

Note: absence from the Peripherals page doesn't mean unsupported — most MBIM modems work without being listed.

### `_completion` data from deep-inspect.json

~~[tikoci/restraml PR #35](https://github.com/tikoci/restraml/pull/35) adds `deep-inspect.json` with argument completion values (enum choices like `protocol=tcp,udp,icmp`). This would significantly enrich the command tree. Watch for that PR to ship, then design schema extension.~~

**Investigated 2026-04-04.** deep-inspect.json is now published on restraml GitHub Pages. Available at `https://tikoci.github.io/restraml/<version>/extra/deep-inspect.json` starting from **7.22.1** (stable) and **7.23beta4** (dev). Not present for 7.22 or earlier, or 7.23beta2.

**Current state:** The file exists and includes a `_meta` root field with version info and completion stats, but **`_completion` fields are not yet populated** — `argsWithCompletion: 0` across all checked versions (7.22.1, 7.23beta4, 7.23beta5). The command tree content is otherwise identical to inspect.json.

**`_meta` structure:**

```json
{
  "version": "7.22.1",
  "generatedAt": "2026-03-28T03:25:43.709Z",
  "completionStats": { "argsTotal": 34548, "argsWithCompletion": 0, "argsFailed": 0 }
}
```

**Next steps:**

1. Watch for future restraml builds where `argsWithCompletion > 0` — that's the trigger
2. The `_meta.version` and `generatedAt` fields are immediately useful for extraction traceability — consider capturing these in `ros_versions` even before completion data arrives
3. Prefer deep-inspect.json over inspect.json for versions where it exists (superset of data)

### inspect.json extra-package coverage gaps

Our inspect.json data comes from CHR (x86_64) with extra-packages enabled. CHR does not have all packages — known gaps:

- **Wi-Fi driver packages** — `wifi-qcom.npk`, `wifi-qcom-ac.npk`, and other wireless driver packages. VMs don't have wireless hardware so these aren't present on CHR.
- **zerotier.npk** — not available on CHR builds.
- **Architecture-specific packages** — some packages exist only for certain hardware architectures (ARM, MIPS, etc.) and aren't in the CHR build.

The HTML documentation covers all packages including these. The `Packages` page lists the full set of available packages.

**Investigated 2026-04-04.** Cross-referenced the command tree against HTML docs. Key findings:

**Pages with docs but poor/no command tree coverage:**

| Subsystem | Doc pages | Commands in tree | Gap reason |
|-----------|-----------|-----------------|------------|
| WiFi (`/interface/wifi`) | WiFi (224559120), Interworking (334168086) | 2,584 cmds, only 3 pages linked | Linking gap + CHR has no wifi hardware |
| Wireless (`/interface/wireless`) | Wireless (1409138), Wireless Interface (8978446) | 128 cmds | Legacy; main overview page has 0 links |
| ZeroTier | ZeroTier (83755083) | 1 cmd in tree | Package missing from CHR |
| LoRa (`/iot/lora`) | LoRa (16351615) | 475 cmds, only 17 documented | Linking gap |
| IoT GPIO | GPIO (68944101) | Under `/iot`, 0 links | Linking gap |
| Scripting builtins | Scripting (47579229), etc. | `/if`, `/while`, `/put`, `/tonum`, etc. | Script functions in tree but not linked to doc pages |

**Impact for agents:** When a user asks about WiFi, ZeroTier, or LoRa commands, the command tree tools return incomplete/no results. The docs have the information but agents don't know to fall back to `routeros_search` or `routeros_get_page`.

**Actionable improvements:**

1. **Tool description hints** — add guidance to `routeros_command_tree` tool description noting that WiFi/wireless, ZeroTier, and LoRa commands may be incomplete in the tree; suggest `routeros_search` as fallback
2. **Improve linking** — the 92% dir coverage stat masks that some high-value subsystems (WiFi, LoRa, scripting) have much lower coverage. A targeted linking pass for these specific subsystems would have outsized impact
3. **Package manifest** — extract the definitive package list from the Packages doc page and cross-reference with what inspect.json actually contains, so agents get a clear "these packages are not in the command tree" signal

### MCP resources (beyond tools)

The MCP spec supports **resources** — static or semi-static data that clients can fetch without a tool call. Worth investigating whether we should expose some data as resources rather than (or in addition to) tools:

- Implemented: `rosetta://datasets/device-test-results.csv` and `rosetta://datasets/devices.csv` expose the two main reporting datasets as CSV resources for clients that support MCP resources.
- **Product matrix CSV** — `matrix/2026-03-25/matrix.csv` (144 products, 34 columns). The normalized `devices.csv` resource exists now, but the raw source CSV might still be useful as a resource for agents that want the original export columns exactly as MikroTik published them.
- **Versioned inspect.json** — raw command tree data. Some agents might want the raw JSON rather than our SQL interpretation.
- **RouterOS YAML schema** — restraml also generates RAML/YAML schemas. Could expose as a resource for code generation use cases.

Resources are a better fit than tools for large, infrequently-changing data that agents consume wholesale rather than querying. In VS Code/Copilot they are explicitly attached context, not an automatic substitute for tool calls.

### Product matrix CSV automation

The product matrix CSV is downloaded manually via browser from `https://mikrotik.com/products/matrix` (PowerGrid table with export button). There is no stable URL for direct download. A GitHub agent could potentially automate this: navigate the site, trigger the export, and open a PR with the updated CSV — no URL input needed in the release workflow.

### Cross-reference with forum data

The MikroTik forum archive (also an SQL-as-RAG project using SQLite FTS5) could be cross-searched with official docs. A JOIN or cross-search could surface community knowledge alongside official documentation. Need to think about: same DB vs. separate MCP tools vs. query-time federation.

### macOS code signing and notarization for compiled binaries

Compiled Bun binaries trigger macOS Gatekeeper because they are unsigned and unnotarized. Current workaround is documented in README (System Settings → Privacy & Security → Allow Anyway, or `xattr -d com.apple.quarantine`). The "Run with Bun" install option avoids this entirely.

To properly sign and notarize:

- **Ad-hoc signing** (`codesign -s -`) — free, no account needed, but does NOT suppress Gatekeeper on other machines. Only useful for local development.
- **Developer ID signing + notarization** — requires an **active** Apple Developer Program membership ($99/year). The certificate type needed is "Developer ID Application". The flow: `codesign --sign "Developer ID Application: ..."` → `xcrun notarytool submit` → `xcrun stapler staple`.
- Windows SmartScreen has a similar story — EV code signing certificates (~$200-400/year) from a CA are needed to build SmartScreen reputation.

**Recommendation:** The Bun-based install option is the pragmatic alternative. Code signing is worth doing if the compiled binaries get wider distribution, but not a blocker for early testers.

## Deferred

Items explicitly postponed until a trigger condition is met.

### Automate official MCP Registry publish in release workflow

`server.json` and CI validation are now in place, but release-time publication to `registry.modelcontextprotocol.io` is deferred until namespace auth is set up for CI (`mcp-publisher login github-oidc` or DNS/HTTP method with secrets).

**Trigger:** CI auth method finalized and secrets configured for publish.

When triggered:

- Add publish step to `.github/workflows/release.yml` after `npm publish`.
- Sync `server.json` version from release tag (`vX.Y.Z` -> `X.Y.Z`) before publish.
- Execute `mcp-publisher publish server.json` in release job and fail release if publish fails.
- Verify result with registry search API query for `io.github.tikoci/rosetta`.

### Docker v1 tar / crane — OCI build anti-pattern

All crane-based OCI image construction approaches (single-layer hand-crafted tars; `crane append` + jq config modification) failed on Docker 28's containerd image store: all exec calls returned `no such file or directory` despite `crane export` confirming files existed. Root cause never diagnosed.

**Status:** Resolved — switched to `Dockerfile.release` + `docker buildx build --push --platform linux/amd64,linux/arm64`. Standard Docker builds work correctly.

**If re-evaluation of crane is needed:** See `~/.copilot/skills/tikoci-oci-image-building/SKILL.md` for the full anti-pattern documentation and what was tried.

### OCI image armv7 support in release pipeline

Current CI builds linux/amd64 and linux/arm64 via `docker buildx`. `linux/arm/v7` is deferred because Bun target support for this path is unverified.

**Trigger:** Bun reliably supports armv7 compilation for `src/mcp.ts`.

When triggered:

- Add `linux/arm/v7` to `--platform` in the `docker buildx build` CI step
- Add arm/v7 case to the `TARGETARCH` switch in `Dockerfile.release`

### Documentation version tracking

**Trigger:** Second HTML export is available.

When it arrives:

- Add `doc_exports` metadata table (export date, page count, hash)
- Compare text hashes to detect changed pages
- Watch the special hardware pages above for renames/moves — these are the ones that matter most if they change
- Simple diff is fine; don't overengineer

### Copilot context provider

VSCode extension client-side can provide doc context via MCP or direct DB queries. Depends on `lsp-routeros-ts` integration being further along.

### ~~DB schema version check for bunx auto-updates~~ ✓ DONE

`SCHEMA_VERSION = 1` exported from `paths.ts`, stamped via `PRAGMA user_version` in `initDb()`, and checked at MCP server startup before `db.ts` is imported. On mismatch, auto-re-downloads the DB (same pattern as the empty-DB auto-download). `setup.ts --setup` validation also prints the schema version and warns on mismatch. Covered by a `checkSchemaVersion()` test in `query.test.ts`.

**Increment `SCHEMA_VERSION` in `src/paths.ts` whenever a destructive schema change is made (DROP/RENAME table or column).**

## Improvements

Smaller items that would make things better but aren't urgent.

### Unified search entry point — routeros_search as the primary discovery tool

**Problem:** With 14 tools, agents face a "which tool do I start with?" decision. In practice, `routeros_search` is the documented primary entry point, but it only searches page FTS. Video transcripts, callouts, properties, and changelogs each require a separate tool call. Agents observed in real sessions rarely call `routeros_search_videos` unprompted — they don't know video data exists unless they happen to read the tool list carefully or get directed to it.

**Approach options (not mutually exclusive):**

1. **`routeros_search` surfaces video results** — add an `include_videos` boolean param (default: true). When enabled, interleave video segment results (tagged with source type) alongside page results. BM25 scores aren't directly comparable across FTS tables, so interleaving would need a heuristic (e.g., top N pages + top M videos, clearly labeled). Start with separate sections in the response: `pages: [...]`, `videos: [...]`.

2. **Unified search mode** — a new `routeros_unified_search` that queries pages, videos, callouts, and properties in parallel and returns a merged ranked result. More ambitious but addresses the broader "too many entry points" problem. Risk: larger output, slower, harder to tune ranking across content types.

3. **Tool description routing** — improve `routeros_search` tool description to explicitly mention that video transcripts exist and suggest `routeros_search_videos` as a follow-up. Cheapest change, but relies on agents reading and following routing hints (they sometimes do, sometimes don't).

**Recommended first step:** Option 3 (description routing) is trivial and helps immediately. Then option 1 for the next release — `include_videos=true` by default, with a `pages` + `videos` split in the response. Defer option 2 until the pattern is validated.

**Signal to watch:** Which tools agents actually invoke in real sessions. If agents consistently skip `routeros_search_videos`, that's a strong signal that option 1 is needed. See "Usage analytics" backlog item below.

### Usage analytics — which tools do agents actually call?

**Problem:** With 14 tools, tool descriptions are the primary steering mechanism for agent behavior. But we have no visibility into which tools agents invoke, in what order, or which queries return empty. Without data, tool description tuning is guesswork.

**What to track (local-only, no outbound network):**
- Tool invocation counts (which tools are popular, which are never used)
- Empty-result rates per tool (signals misunderstanding or bad queries)
- Query terms per tool (what agents are asking for)
- Tool chaining patterns (search → get_page → lookup_property vs. search → dead end)
- Session-level sequences (do agents discover the right tool, or do they give up?)

**Privacy and design constraints:**
- **No outbound network** — data stays in a local SQLite table or log file. No phoning home.
- **Opt-in** — disabled by default. Enable via env var (`ROSETTA_LOG_USAGE=1`) or CLI flag.
- **Minimal overhead** — a single `INSERT` per tool call into a `usage_log` table in the existing DB (or a separate `usage.db` to avoid bloating the main DB).
- **Read access** — `routeros_stats` could optionally include usage summary if logging is enabled.

**Schema sketch:**
```sql
usage_log (
  id INTEGER PRIMARY KEY,
  timestamp TEXT NOT NULL,  -- ISO 8601
  tool TEXT NOT NULL,       -- 'routeros_search', 'routeros_get_page', etc.
  query TEXT,               -- the user's query/input (first 200 chars)
  result_count INTEGER,     -- number of results returned
  session_id TEXT           -- MCP session ID for chaining analysis
)
```

**Trigger:** Implement when there's a real question about which tools to consolidate or deprecate. The REST API page popularity mentioned in conversation is a good initial data point — but anecdotal. Systematic data would inform the unified search design above.

**Long-term:** If the MikroTik /app deployment gets traction, aggregate usage across routers (opt-in) could reveal what the RouterOS community actually asks AI about. But that requires outbound network + consent, so it's a separate, much later consideration.

### Agent-assisted linking

Currently ~92% of dirs are linked to documentation pages. The remaining ~8% could be mapped by having agents manually review unlinked commands and match them to pages. Low priority — 92% is good enough for most queries.

### LSP integration

[tikoci/lsp-routeros-ts](https://github.com/tikoci/lsp-routeros-ts) hover handler should consume property data from this DB. Needs a settings field for `routeros.helpDatabasePath`. The data is ready; the consumer needs work.

### ~~npm package experience (`bunx @tikoci/rosetta`)~~ ✓ DONE

Implemented. Three-mode DB path resolution (`src/paths.ts`): compiled → next to executable, dev → project root, package → `~/.rosetta/`. `setup.ts` detects mode and prints `bunx @tikoci/rosetta` configs for package mode (VS Code Copilot, Claude Desktop, Claude Code, Copilot CLI, Cursor). `bin/rosetta.js` Node error path now prints clear message directing to `bunx`. README restructured with bunx as primary Quick Start option, compiled binaries as secondary. `package.json` has `engines: {bun: ">=1.1"}` field.

### Changelog tool output size and version-range queries

Observed in a real Copilot CLI session: querying changelogs between 7.21.3 and 7.22.1 produced 802 lines / 23.2KB of JSON output, which Copilot CLI saved to a temp file as "too large to read at once." Issues:

- **Output too verbose** — each entry returns full `description` + `excerpt` + `released` date. For version-range queries spanning multiple releases, this produces a wall of JSON. Consider a compact summary mode: group by version, then by category, with counts and only the descriptions (no excerpt duplication).
- **`limit` max of 100 may be too low** — the model's first attempt used limit > 100 and hit a validation error. For "what changed between X and Y" queries spanning 3+ releases, 100 entries may genuinely not be enough. Consider raising to 200 or 500, or making the grouped summary the default for range queries.
- **No `exclude_version` parameter** — asking for changes between 7.21.3 and 7.22.1 likely includes 7.21.3 entries too, which the user already has. Consider making `from_version` exclusive (changes *after* 7.21.3) or adding an `exclude_from` flag.

### Browse REPL enhancements (Phase 3)

The `browse` command provides a keyboard-driven REPL over all extracted data. It doubles as a test harness — interacting with data the same way an MCP agent would, so gaps visible in `browse` often point to MCP tool deficiencies. Tracked issues and improvements:

#### Navigation and context

- **`b` (back) is unreliable** — the history stack works mechanically (`pushCtx` / `popCtx`) but the UX is confusing. After searching, selecting a page, then pressing `b`, the user returns to the search results — but the prompt doesn't convey what context you're in or whether there's anything to go back to. Consider: (a) show current context in the prompt (e.g., `rosetta[Bridge VLAN Table]>`), (b) show nothing / "Already at top" when stack is empty. The RouterOS CLI has no back concept — it has `/` to go to root. A similar `home` or `/` command might be more intuitive than `b`.
- **Number references don't consistently navigate** — documentation pages use `#N` (numbered results) which work to view content. But other tool outputs (callouts, properties, videos) also show numbered results that are not selectable. `handleNumberSelect()` only handles `search`, `sections`, and `devices` contexts. Properties, callouts, changelogs, and video results should also support number selection. For callouts, selecting should navigate to the source page. For videos, selecting should open/show the timestamped URL.
- **`[XX more results...]` is not actionable** — search results show "X of Y results" but there's no way to page forward or request more. Need either: (a) a `more` / `next` command to load the next page, or (b) increase default limit and truncate display with paging. The pager handles long output already, so (b) may be simpler — bump the query limit and let the existing pager handle display.

#### Parameter alignment with MCP tools

- **`tests` command has no device filter** — `routeros_search_tests` MCP tool also lacks a `product_name` / `device` parameter. Without it, the test results table is a wall of data with no way to scope to a single device. This is both a TUI gap and an MCP tool gap. The MCP tool's `DeviceTestFilters` type needs a `device` field that adds `WHERE d.product_name LIKE ?` to the query. In `browse`, `tests rb5009 ethernet 1518` should filter by device name.
- **Search parameters not exposed** — MCP tools like `routeros_search` accept `limit`, `routeros_search_changelogs` accepts `breakingOnly`, `fromVersion`, `toVersion`, `category`, but the TUI doesn't expose these. Consider a parameter syntax like `s firewall .limit=20` or flags like `s firewall --limit 20`. Alternatively, specific shorthands: `cl 7.21..7.22 iot` already works for changelogs, similar patterns for other tools.
- **Commands should mirror MCP tool catalogs** — right now `browse` has commands like `dev`, `cmd`, `cl`, `vid`, `tests`, `cal` that roughly map to MCP tools but the mapping isn't systematic. Each TUI command should correspond to exactly one MCP tool, with the same parameters. This makes `browse` a faithful test harness and makes it obvious when an MCP tool is missing a parameter. Currently `search` maps to `routeros_search`, `dev` to `routeros_device_lookup`, etc. — document the mapping in help output.

#### Pager and display polish

- **Pager controls should use RouterOS style** — instead of `── N more lines (Enter=next, q=stop) ──`, use the RouterOS-style bottom bar: `-- [Q quit | SPACE next page | DOWN line]`. This is familiar to the target audience and consistent with the "card catalog for RouterOS admins" positioning.
- **Document text formatting could be improved** — page text from `getPage()` is raw extracted text with no spacing between headings and body text. During HTML extraction, we could insert blank lines before headings and retain some minimal formatting signals (e.g., `**bold**` from `<strong>`, `-` from `<li>`). This would cost little in token overhead but improve readability both in `browse` and in MCP tool output. This is an extraction-level improvement (affects `extract-html.ts`), not just a display concern.
- **Code blocks lack visual separation** — code sections show `── code ──` separator but the code itself has no indentation or syntax differentiation. Even a 2-space indent for code lines would help visually.

#### Version and metadata display

- **`ver` / `versions` should include WinBox version** — add WinBox 4 latest version info alongside RouterOS channels. Available from `https://upgrade.mikrotik.com/routeros/winbox/LATEST.4`. Small fetch, high value for the target audience. Consider adding to both the TUI command and the `routeros_current_versions` MCP tool.
- **Stats could show more operational info** — database file size, last extraction date, schema version. Some of this is in `getDbStats()` already.

#### Wishlist (lower priority)

- **Tab completion** — complete command names (`cmd`, `prop`, `dev`…) and path prefixes (`/ip/firewall/…`) using readline's completer callback. Command paths could be pre-fetched from the `commands` table at startup.
- **History persistence** — save readline history to `~/.rosetta/browse_history` so queries survive across sessions.
- **Raw SQL mode** — `sql SELECT …` command for ad-hoc queries. Guard with `--allow-sql` flag.
- **Export** — `export <format>` to dump the current view as JSON, CSV, or Markdown.
- **Audit views** — data quality commands: unlinked commands, pages with no properties, devices with no test results.
- **Bookmarks** — save frequent queries/pages for quick recall. Store in `~/.rosetta/bookmarks.json`.

### `routeros_search` cross-table awareness

**Problem:** `routeros_search` only searches the `pages_fts` index. When an agent starts with a broad question like "VRRP" or "BGP route reflection", the search returns page results but gives no signal that there are also relevant callouts, properties, changelogs, video transcripts, or device-specific data. The agent has to know about and call 5+ other tools independently.

**Observed in TUI testing (2026-04-09):** Using `browse` as an LLM proxy, the search results are often a good starting point but the user (or agent) has no way to know what *else* is available without manually trying each catalog. An agent that only calls `routeros_search` misses warnings in callouts, version-specific gotchas in changelogs, and tutorial videos.

**Current state of tool description routing:** `routeros_search` description includes `→ routeros_search_videos`, `→ routeros_search_callouts` hints, but agents inconsistently follow these. Real-session observation: agents rarely call `routeros_search_videos` unprompted.

**Recommended approach (incremental):**

1. **Phase 1 — Summary counts in search results** (low effort, high signal): When `routeros_search` returns page results, also run quick `SELECT count(*)` queries against other FTS tables for the same query terms. Include in the response: `"related": { "callouts": 3, "changelogs": 12, "videos": 2 }`. This gives agents (and TUI) a clear signal that more data exists without bloating the response. The agent can then make an informed decision to call the specific tool.

2. **Phase 2 — Top-N cross-table results** (medium effort): Include the top 2-3 results from each related table directly in the search response, tagged by source type. Still separate sections, not interleaved. This is the `include_videos=true` option from the existing "Unified search" backlog item.

3. **Phase 3 — Unified ranked search** (high effort, questionable value): True cross-table BM25 ranking. Probably not worth it — BM25 scores aren't comparable across different FTS tables with different column weights.

**Signal:** Phase 1 is the clear next step. It directly addresses the "agent doesn't know other data exists" problem with minimal response size impact.

### `routeros_search_tests` missing device filter

The `routeros_search_tests` MCP tool and `searchDeviceTests()` function accept `test_type`, `mode`, `configuration`, `packet_size`, and `sort_by` — but no `device` or `product_name` filter. This makes the tool nearly useless for the most common query: "show me benchmarks for [specific device]."

**Current workaround:** `routeros_device_lookup` auto-attaches test results for exact matches and small result sets (≤5), so agents can get per-device benchmarks that way. But `routeros_search_tests` positioned as a "cross-device" comparison tool has no way to scope to a subset of devices.

**Fix:** Add `product_name` to `DeviceTestFilters`. In SQL: `JOIN devices d ON ... WHERE d.product_name LIKE ?`. Also update the `browse` `tests` command to accept a device name in the filter string.

**In TUI:** `tests rb5009 ethernet 1518` should match product names containing "rb5009" and filter to ethernet tests at 1518 bytes.

### ~~Archival Python scripts~~

`ros-pdf-to-sqlite.py` and `ros-pdf-assess.py` were from the original PDF-based approach. **Removed** — files are in git history if needed.

### ~~MikroTik YouTube transcript extraction~~ ✓ DONE (local extraction + CI import complete)

Full pipeline implemented (2026-04-08):
- `videos` + `video_segments` + `videos_fts` + `video_segments_fts` tables in schema
- `src/extract-videos.ts` — `yt-dlp`-based extractor: fetches playlist, downloads VTT + info.json per video, parses cues, splits by chapters, stores in DB. Only English subtitles via `--sub-langs en`.
- `routeros_search_videos` MCP tool — FTS over chapter titles + transcript text, with timestamps for deep links
- Timeout guardrails: `--socket-timeout 15`, `--retries 2`, `Bun.spawnSync timeout: 120_000ms`
- Cache system: `saveCache` / `importCache` / `loadKnownBad` / `findLatestCache` in `extract-videos.ts`. NDJSON format, `transcripts/YYYY-MM-DD/videos.ndjson` committed to git.
- `transcripts/known-bad.json` — 10 known non-English video IDs seeded (Russian, Spanish, Latvian, Albanian, Indonesian)
- Makefile: `extract-videos`, `extract-videos-from-cache`, `save-videos-cache`
- `--from-cache` mode runs without `yt-dlp` (CI path), `--save-cache` exports DB → NDJSON after run
- Tests: 12 yt-dlp mock tests + cache function tests (saveCache, importCache, loadKnownBad, findLatestCache)
- Non-English videos: ~27 stored as metadata-only (no transcript — `yt-dlp` finds no English VTT). Graceful, not a failure.

**Local extraction completed** for 518 videos (April 2026). Cache committed at `transcripts/2026-04-09/videos.ndjson`. CI import step added to `release.yml`.

### ~~Add extract-videos-from-cache to release.yml~~ ✓ DONE

Added `make extract-videos-from-cache` step to `release.yml` after "Extract changelogs" and before "Link commands to pages". Stats step already includes VIDEOS/SEGMENTS counts with `2>/dev/null || echo 0` safeguards. No `yt-dlp` needed in CI — the committed NDJSON (`transcripts/2026-04-09/videos.ndjson`, 518 videos) is the sole source.

For fresh transcript updates: run `make extract-videos && make save-videos-cache` locally, then commit `transcripts/YYYY-MM-DD/videos.ndjson` and push.

### Video extraction failures — periodic retry or known-bad additions

**Context (2026-04-09 extraction, 3 passes over ~26 hours):**
- Pass 1: 232 new, 275 skipped, 81 no-transcript, 154 failed
- Pass 2: 5 new, 499 skipped, 0 no-transcript, 149 failed
- Pass 3 (make save-videos-cache): 6 new, 504 skipped, 0 no-transcript, 143 failed
- **Final DB: 518 videos, 1890 segments, ~1799 with transcripts, 84 metadata-only (no transcript)**

**Failure pattern:** 143 videos consistently fail across all passes. Gradual improvement (154 → 149 → 143) suggests YouTube rate limiting / anti-bot that slowly allows access rather than permanent unavailability. Not the same as "no-transcript" (those are stored successfully).

**Possible causes for consistent failures:**
1. YouTube anti-bot measures triggering on the same IPs
2. Videos with no English captions *and* yt-dlp can't even get metadata
3. Age-restricted / geo-restricted videos (yt-dlp errors on access)

**Recommended next step:** Run another round of `make extract-videos` after a 48–72 hour gap. If a video fails 4+ times over several days, add it to `transcripts/known-bad.json` with the reason (or investigate with `yt-dlp <url>` manually to confirm the error type).

**No-transcript (84 videos):** These are stored successfully in DB as metadata-only. Many are old MUM conference talks with no auto-captions. `known-bad.json` has 10 explicitly non-English IDs seeded. Additional ones can be added as they're identified.

### Video title superscript normalization (applied 2026-04-09)

**Implemented:** `normalizeSuperscripts()` in `extract-videos.ts` normalizes ⁰¹²³⁴⁵⁶⁷⁸⁹ and ₀₁₂₃₄₅₆₇₈₉ → ASCII digits at insert time (both yt-dlp and importCache paths). Existing DB rows updated via SQL UPDATE (triggers propagated to FTS5 index).

**Effect:** Searching "hap ax3" now finds "hAP ax3" (was "hAP ax³"). Searching "hap ax2" finds "hAP ax2" (was "hAP ax²"). The NDJSON cache retains original form (fidelity to source); normalization applied at import time.

**Note:** The `devices_fts` table (products) uses `unicode61` without porter and stores the original product names from the matrix CSV (e.g. "hAP ax³" in the CSV). ✅ Same normalization applied to `extract-devices.ts` and existing DB rows updated — searching "ax3" now finds "hAP ax3" (was "hAP ax³"), "ac2" finds "hAP ac2" (was "hAP ac²"), etc.
