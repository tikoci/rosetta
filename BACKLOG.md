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

### ~~Archival Python scripts~~

`ros-pdf-to-sqlite.py` and `ros-pdf-assess.py` were from the original PDF-based approach. **Removed** — files are in git history if needed.
