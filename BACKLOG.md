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

### Command diff tool (upgrade breakage diagnosis)

A common real-world query pattern: "this used to work on my router, something broke after I upgraded." The LLM gets a vague prompt, needs to figure out if a command path changed or was removed between versions. We already have the data in `command_versions` — what's missing is a tool that diffs two versions directly.

Proposed: `routeros_command_diff` — given two versions (e.g. `7.15` → `7.22`), return added/removed command paths. This is the SQL equivalent of restraml's [diff.html](https://tikoci.github.io/restraml/diff.html) tool. The MCP tool hints should guide agents toward this when the user describes something that stopped working after an upgrade.

This could also pair with `routeros_search_callouts` — callouts often document breaking changes or version-specific behavior. Now also pairs with `routeros_search_changelogs` — changelogs have per-entry parsed descriptions with category and breaking flags, enabling precise "what changed in subsystem X between versions A and B" queries.

### ~~Add remote MCP transport mode for ChatGPT Apps~~ ✓ DONE

Implemented. Streamable HTTP transport via `--http` flag using `Bun.serve()` + `WebStandardStreamableHTTPServerTransport` (MCP spec 2025-03-26). Endpoint: `/mcp`. Supports `--port`, `--host`, `--tls-cert`/`--tls-key` flags and env vars. Defaults to localhost binding; LAN binding (`--host 0.0.0.0`) logs a warning. Origin header validation prevents DNS rebinding. `--setup` prints HTTP config snippets alongside stdio configs. Stdio remains the default for local clients.

## To Investigate

Items that need research or experimentation before they're actionable.

### Debounce inspect.json fetches during extract-all-versions

`extract-all-versions.ts` spawns `extract-commands.ts` for each version sequentially, and each invocation fetches its inspect.json from GitHub Pages. With ~48 versions this means ~48 sequential HTTP fetches. Consider:

- Batch-prefetch all inspect.json files with concurrency control (e.g. 5 at a time) before spawning extractors
- Cache fetched files in a temp dir so re-runs don't re-download
- Pass fetched data via stdin or temp file instead of having each subprocess fetch independently

Not urgent — the current sequential approach works and GitHub Pages has no rate limit. But it's slower than necessary.

### List-format properties

Some pages use `<ul><li><strong>name</strong> (type; Default: value)</li></ul>` for read-only properties instead of `confluenceTable`. These are currently not extracted. Need to:

- Quantify how many exist (`ros-html-assessment.json` has `listProperties` counts per page)
- Decide: same `properties` table or separate? Same extraction pass or new script?
- Check if the pattern is consistent enough for reliable parsing

### Special hardware pages

Several pages contain device-specific tables that are uniquely valuable for agents — they're the only structured source for "does this router actually support X":

- **Switch Chip Features** (`ROS/pages/15302988`) — chip model → feature matrix
- **Marvell Prestera** (`ROS/pages/30474317`) — Prestera switch chip model table
- **Bridging and Switching** (`ROS/pages/328068`) — RouterBoard/Switch Chip Model table
- **Peripherals** (`ROS/pages/13500447`) — supported USB/LTE/etc. peripherals

These are worth extracting into dedicated tables or enriching the device data. If MikroTik renames/moves these pages, that's a signal "something important changed."

Note: absence from the Peripherals page doesn't mean unsupported — most MBIM modems work without being listed.

### `_completion` data from deep-inspect.json

[tikoci/restraml PR #35](https://github.com/tikoci/restraml/pull/35) adds `deep-inspect.json` with argument completion values (enum choices like `protocol=tcp,udp,icmp`). This would significantly enrich the command tree. Watch for that PR to ship, then design schema extension.

### inspect.json extra-package coverage gaps

Our inspect.json data comes from CHR (x86_64) with extra-packages enabled. CHR does not have all packages — known gaps:

- **Wi-Fi driver packages** — `wifi-qcom.npk`, `wifi-qcom-ac.npk`, and other wireless driver packages. VMs don't have wireless hardware so these aren't present on CHR.
- **zerotier.npk** — not available on CHR builds.
- **Architecture-specific packages** — some packages exist only for certain hardware architectures (ARM, MIPS, etc.) and aren't in the CHR build.

The HTML documentation covers all packages including these. The `Packages` page lists the full set of available packages.

To make tool descriptions more accurate, we should:

1. Extract the definitive package list from the Packages doc page
2. Cross-reference with what inspect.json actually contains
3. Document which command paths come from missing packages (so agents know to check docs instead of command tree for those features)

### MCP resources (beyond tools)

The MCP spec supports **resources** — static or semi-static data that clients can fetch without a tool call. Worth investigating whether we should expose some data as resources rather than (or in addition to) tools:

- **Product matrix CSV** — `matrix/2026-03-25/matrix.csv` (144 products, 34 columns). Already in the DB as the `devices` table, but the raw CSV might be useful as a resource for agents that want the full 34-column dataset.
- **Versioned inspect.json** — raw command tree data. Some agents might want the raw JSON rather than our SQL interpretation.
- **RouterOS YAML schema** — restraml also generates RAML/YAML schemas. Could expose as a resource for code generation use cases.

Resources are a better fit than tools for large, infrequently-changing data that agents consume wholesale rather than querying.

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

### DB schema version check for bunx auto-updates

`bunx` auto-updates to the latest published package version on each session. If a future version drops or renames a table, the existing `~/.rosetta/ros-help.db` could be incompatible. The current `initDb()` uses `CREATE TABLE IF NOT EXISTS` and has migration logic (e.g., `ros_version` column), which handles additive changes. But destructive schema changes would break.

**Trigger:** Next time we make a breaking schema change (drop/rename table or column).

Proposed approach: store a schema version integer in the DB (e.g., `PRAGMA user_version` or a metadata table). On startup, compare against the expected version. If mismatch, auto-re-download the DB from GitHub Releases. Simple and handles the bunx upgrade case cleanly.

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
