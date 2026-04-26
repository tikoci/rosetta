# Design — rosetta

> **Audience:** LLM agents working on this codebase. Explains *why* things are the way they are.
> For *what* the project is and how it works, see `CLAUDE.md`.
> For ideas and future work, see `BACKLOG.md`.

## SQL-as-RAG Pattern

SQLite FTS5 as the retrieval layer for retrieval-augmented generation, exposed over MCP so any LLM client can use it. FTS5 with porter stemming hits ~90% of embedding quality for domain-specific technical corpora where users and content share precise terminology. No vector DB, no embedding pipeline, sub-millisecond queries.

This pattern is used across several `tikoci` projects (forum archives, documentation, device specs). The key insight: for corpora under ~500K documents where users and content share precise jargon, lexical matching with BM25 ranking is the practical middle ground between "just grep it" and deploying a vector database.

## Data Sources

| Source | Location | Format | Coverage |
|--------|----------|--------|----------|
| Confluence HTML | `box/latest/ROS/` | 317 HTML files | March 2026 export |
| inspect.json | [tikoci/restraml GitHub Pages](https://tikoci.github.io/restraml/) `<version>/extra/inspect.json` | JSON tree per version | 46 versions (7.9–7.23beta2) |
| Product matrix | `matrix/2026-03-25/matrix.csv` | CSV, 34 columns | 144 products, March 2026 |
| Product test results | `mikrotik.com/product/<slug>` | HTML (server-rendered) | 125 devices with tests, 110 with block diagrams |
| Changelogs | `https://download.mikrotik.com/routeros/{version}/CHANGELOG` | Plain text per version | All versions in ros_versions |
| YouTube transcripts | `https://www.youtube.com/@MikroTik/videos` via yt-dlp; cached in `transcripts/YYYY-MM-DD/videos.ndjson` | NDJSON cache (one `VideoCacheEntry` per line) | 518 videos, ~1,890 chapter-level segments |
| Agent skills | [tikoci/routeros-skills](https://github.com/tikoci/routeros-skills) | YAML frontmatter + markdown | 8 skills, ~30K words (community content) |

**restraml dependency:** Version discovery uses 1 GitHub API call (`api.github.com/repos/tikoci/restraml/contents/docs`); actual inspect.json files are fetched from GitHub Pages (no rate limit). For offline workflows, `extract-all-versions.ts` accepts a local docs directory and `extract-commands.ts` accepts a local file path.

**Version cadence:** HTML docs are pinned to a specific export (currently March 2026 / 7.22). inspect.json versions update automatically via restraml's CI — new versions appear weekly. The primary `commands` table uses the latest stable from inspect.json, which may be newer than the HTML docs export.

## Key Decisions

### v6 is out of scope

No inspect.json data exists for RouterOS v6. The documentation covers v7 only. Syntax, commands, and major subsystems (routing/BGP, firewall, bridging) all changed in v7 — v6 answers from this DB are significantly less reliable. Document as unknown territory in tool descriptions. Oldest version with command data is 7.9.

### Version accuracy degrades below long-term

The HTML docs aren't versioned — they reflect the then-current long-term release (~7.22, specifically 7.22.1 at export time). They don't pin to a version. This is why the extraction pipeline is careful about version tracking: the `commands` table and `command_versions` junction table provide structured version data that the prose docs don't.

**Accuracy tiers:**

- **Current long-term and above:** High confidence. Docs + command tree align well.
- **7.9–older stable:** Command tree data exists, but docs may not reflect older behavior. Callouts sometimes note version-specific differences — this is why we extract them.
- **Older than current long-term:** MikroTik does not backport fixes below the current long-term release. If a vulnerability is found in e.g. 7.11 and fixed in 7.11.1, it might get backported to the long-term branch but not to older stable branches. Recommend upgrading to at least the current long-term.
- **Below 7.9:** No command tree data at all.
- **v6:** Different syntax, different subsystems. Answers will be unreliable.

### RouterOS version scheme

MikroTik publishes current versions per channel at predictable URLs:

```text
https://upgrade.mikrotik.com/routeros/NEWESTa7.stable
https://upgrade.mikrotik.com/routeros/NEWESTa7.long-term
https://upgrade.mikrotik.com/routeros/NEWESTa7.testing
https://upgrade.mikrotik.com/routeros/NEWESTa7.development
```

Each returns a plain-text response with the version string (e.g., `7.22.1`). The **long-term** channel is our northstar — docs align best with whatever version is current there. The actual version at extraction was ~7.22.

### Junction table for version tracking

`command_versions` is a (command_path, ros_version) junction table — not per-version columns or per-version rows in `commands`. This scales to hundreds of versions without schema changes. The `commands` table holds only the primary version (latest stable, currently 7.22).

### Primary version = latest stable

The `commands` table is populated from the latest stable version. All other versions go into `command_versions` only (via `--accumulate` flag). This means `browseCommands()` always shows current-stable, while `browseCommandsAtVersion()` can show any tracked version.

### All versions extracted, filter at query time

46 versions including betas and RCs. Prefer more data over less. The `channel` column in `ros_versions` allows filtering to stable-only if needed.

### FTS5 for text, SQL WHERE for structured queries

Pages, callouts, and properties use FTS5 with `porter unicode61` for natural language search. Device specs use a different strategy: `devices_fts` uses `unicode61` **without** Porter stemming, plus a LIKE-based substring fallback before FTS.

**Why no Porter for devices:** Product names/codes are model numbers (RB1100AHx4, CCR2216-1G-12XS-2XQ, C53UiG+5HPaxD2HPaxD), not natural language. Porter stemming is unpredictable on alphanumeric identifiers — it could mangle "RB1100AHx4" in ways that break matching. Plain `unicode61` gives case-folding and Unicode normalization without destructive stemming.

**Why LIKE fallback:** FTS5 does whole-token matching, so searching "RB1100" won't find token "RB1100AHx4". FTS5 prefix queries (`RB1100*`) handle the case where the search term is a prefix of a token, but LIKE handles arbitrary substrings. For 144 devices this is instant — no index overhead concerns. The search cascade is: exact match → LIKE substring → FTS prefix → FTS OR fallback → structured filters only.

### MCP resources complement tools, they do not replace them

VS Code Copilot surfaces MCP resources through explicit UI flows such as Add Context > MCP Resources and the MCP: Browse Resources command. That makes resources a good fit for bulk, read-only datasets that users want to attach deliberately for reporting tasks, such as CSV exports of benchmarks or device catalogs.

They are not a cure-all for context pressure. Attaching a large resource can still consume significant context, so tools remain the right default for ranked, filtered retrieval. The split is:

- **Tools** for targeted queries, ranking, filtering, and iterative drill-down
- **Resources** for whole-dataset export or deliberate reporting workflows

This is why rosetta exposes the device test and device catalog CSVs as resources but keeps `routeros_search_tests` and `routeros_device_lookup` as the main interactive paths.

### Callout FK ordering

Callouts have FK to pages. On re-extraction, delete callouts before pages. `extract-html.ts` handles this.

### Extra-packages and inspect.json coverage

RouterOS ships a base image (`routeros.npk`) and optional **extra-packages** (`iot.npk`, `container.npk`, `zerotier.npk`, `gps.npk`, `wifi-qcom.npk`, etc.). The term "extra" comes from MikroTik's download page: users download `routeros.npk` plus an `extra-packages.zip` containing the extras. Despite the name, some extras aren't optional — Wi-Fi driver packages like `wifi-qcom.npk` are required for wireless to function on hardware using that chipset. The current way to install extra packages in RouterOS is via `/system/package/enable <name>` after running a version check that fetches the available list.

The `inspect.json` files from restraml are generated via GitHub Actions that run RouterOS CHR under QEMU. Two builds are performed per version:

1. **Base build** — only `routeros.npk` → published at `<version>/inspect.json`
2. **Extra build** — all extra-packages available on CHR → published at `<version>/extra/inspect.json`

We prefer the `extra/` variant (see `extract-all-versions.ts` which checks for `extra/inspect.json` first). However, the extra-package list is architecture-dependent — CHR (x86_64) has most packages but misses some:

- **Wi-Fi driver packages** (VMs don't have wireless hardware, but MikroTik devices have several different wireless drivers)
- **zerotier.npk** and potentially other third-party integrations
- Architecture-specific packages not available on CHR

The documentation pages cover all packages regardless of architecture, so the HTML extraction has broader coverage than inspect.json for extra-package commands. See BACKLOG.md for the gap analysis item.

### `schema_nodes` — multi-arch command tree with enrichment

`deep-inspect.json` files from [tikoci/restraml](https://github.com/tikoci/restraml) carry richer data than `inspect.json`: dual-arch (x86/arm64) command trees, `_completion` objects with valid argument values (11K+ args), and extended `_meta` provenance. The `schema_nodes` table stores this enriched data alongside the existing `commands` table.

**Key design decisions:**
- **`commands` regenerated, not replaced.** `extract-schema.ts` populates `schema_nodes` first, then regenerates `commands` + `command_versions` from it (Option B from the plan). This is the zero-downstream-churn path — all existing queries in `query.ts`, `browse.ts`, and `link-commands.ts` work unchanged.
- **Sparse `_arch` column.** NULL means both architectures have the node; `'x86'`/`'arm64'` means platform-specific. No per-arch row duplication in `schema_node_presence`.
- **`_attrs` catch-all for completion.** `_completion` data stores as `{ completion: { "no": { style: "arg", preference: 96 }, ... } }` in `_attrs` JSON. Shape is stable but could evolve, so it lives in the catch-all until we're confident enough to promote to columns.
- **desc decomposition.** `desc_raw` is parsed into structured `data_type`, `enum_values`, `range_min`/`range_max`, `max_length` — making "what type does this arg take?" answerable via SQL without NLP.
- **`dir_role` derived deterministically.** `'list'` (has cmd children), `'namespace'` (only dir children), `'hybrid'` (both). Derived at import time from child types.
- **`_package` placeholder.** Column exists but is NULL until restraml emits `_package` metadata per node. No schema migration needed when it arrives.

### `_completion` data — now available

[tikoci/restraml PR #35](https://github.com/tikoci/restraml/pull/35) shipped and `argsWithCompletion` jumped from 0 to 11K+. Completion objects on `arg` nodes have `{ [value]: { style, preference, desc? } }` with 17 style types (`none`, `arg`, `dir,flag-title`, `syntax-meta`, etc.). Stored in `schema_nodes._attrs` as JSON. Exposed in `browseCommands()` and `browseCommandsAtVersion()` responses. Future: promote to structured columns once the shape is confirmed stable across versions.

### CSV requires manual download

The old `curl -X POST -d "ax=matrix"` API is dead (late 2025). MikroTik's product matrix is now a Laravel Livewire/PowerGrid table. Export via browser: visit `mikrotik.com/products/matrix`, click export, choose "All". See `matrix/CLAUDE.md` for column schema.

### Product page test results + block diagrams

MikroTik publishes ethernet & IPSec benchmark tables and hardware block diagram images on individual product pages (`mikrotik.com/product/<slug>`). These are server-side rendered HTML (Laravel Livewire), parseable without JavaScript. Tables use `class="performance-table"` with CSS classes encoding packet size and metric type (`kpps size1518`, `mbps size512`).

**Slug discovery is the hard part.** MikroTik's product URL slugs follow no consistent pattern — some use lowercased product names with underscores, some use product codes with original casing, `+` sometimes becomes `plus`, sometimes `_`, sometimes nothing. Unicode superscript characters (², ³) in product names translate to regular digits. The extractor generates 4–6 candidate slugs per product and tries them sequentially. 15 products (mostly kits, bundles, discontinued) have no discoverable page. This is inherently fragile — MikroTik could change slugs or page structure at any time.

**Test results live in `device_test_results`** (normalized: one row per device×test_type×mode×config×packet_size) rather than denormalized JSON blobs. This enables SQL filtering (e.g., "show all devices sorted by routing throughput at 512-byte packets"). Results are auto-attached to device lookups for exact/small result sets — no separate tool needed.

**Block diagram URLs** are stored on the `devices` row as `block_diagram_url` (CDN PNG URL), not downloaded locally.

### HTML doc versioning is simple

Don't overengineer until there's a second HTML export to compare against. When that arrives, hash-based page diffing is sufficient. See BACKLOG.md for details.

### Changelogs: parsed entries, not blobs

MikroTik publishes per-version changelogs at `https://download.mikrotik.com/routeros/{version}/CHANGELOG` as plain text. Each entry is one `*)` (regular) or `!)` (breaking) line with a category prefix (subsystem name before ` - `). We parse into one row per entry rather than storing the whole changelog text per version — this enables FTS search across entries, category filtering, and breaking-only queries. The `is_breaking` flag corresponds to `!)` entries only; security-related entries are findable via FTS keyword search (no separate flag). Multi-line entries are concatenated into a single description. No FK to `ros_versions` — changelogs may be fetched for patch versions not in the command tree.

### Skills: dual-corpus RAG with attribution boundary

Agent skills from tikoci/routeros-skills are community-created supplemental guides, not official MikroTik documentation. The integration maintains a clear **attribution boundary**: every skill response (MCP resource read, TUI display) prepends a provenance header explaining the content is AI-generated, human-reviewed, may contain errors, and should be verified against official docs via `routeros_search`/`routeros_get_page`.

**Why resources, not tools:** Skills are complete documents (~2K–8K words each), not search results. With only 8 skills, there's nothing to search — agents browse a listing and read one. MCP Resources (`rosetta://skills/{name}`) are the right surface: deliberate context attachment, like the schema and CSV resources. This avoids adding tool #17, aligning with the North Star consolidation direction. If the corpus grows beyond ~20 skills, FTS5 is pre-built for future integration into the unified `routeros_search` via `related.skills`.

**Why include community content in an "unopinionated" project:** Rosetta's primary corpus is authoritative MikroTik docs. Skills are opinionated guides written for agents. The provenance system keeps them clearly separated — agents can choose how much weight to give each. The pattern is textbook + study guide: the system labels which is which. Since RouterOS training data is limited, having curated practical guidance available (with appropriate caveats) is net positive for agent effectiveness.

**Extraction:** GitHub API fetch at build time (in CI). Supports local path (`--local`) for development and `--from-cache` for offline/cached mode. Skills update when a new DB is built — no automatic sync.

### `canonicalize.ts` — vendoring intent and DB-backed verb resolver

`src/canonicalize.ts` parses any RouterOS-CLI-shaped input (well-formed scripts, prose, markdown, partial fragments) into `{ path, verb, args }` tuples. It is intentionally a **vendored module** rather than a published library. The same module is mirrored in [tikoci/lsp-routeros-ts](https://github.com/tikoci/lsp-routeros-ts) — the goal is shape parity, not code reuse.

**Why vendoring instead of a shared library:**

- Each consumer has different *data backends*. rosetta is offline but has the full `commands` table — every cmd verb at every menu, version-tagged. lsp-routeros-ts is online (it can ask `/console/inspect`) but has no prospective knowledge of paths until it tests them. A shared library would have to settle for the lowest-common-denominator data model.
- The "RouterOS logic" — tokenizer, scoping rules for `[…]` / `{…}` / `;`, path resolution, `..` navigation — is universally true. We want this part to stay aligned across consumers so that what we learn in one repo flows back to the others by manual diff, not a release cadence.
- The pure-module split lets each consumer plug in its own verb classifier. The parser asks "is `info` a verb at `/interface/wifi-qcom`?" via `CanonicalizeOptions.isVerb`. rosetta answers that with a SQL query against `commands`; lsp-routeros-ts answers with a static `verbs.json` (planned: see issue #4) augmented by classifications observed in `/console/inspect highlight` responses; standalone callers omit the option and get the small built-in universal-verb-set heuristic. The universal set remains active even when a resolver is supplied because the command tree does not enumerate every helper verb (for example `find`) under every parent path.

**rosetta-side wiring:** `src/canonicalize-resolver.ts` exports `makeDbVerbResolver(db)` returning an `(token, parentPath) => boolean` function backed by `SELECT 1 FROM commands WHERE name=? AND parent_path=? AND type='cmd'`, with per-resolver in-memory caching. `searchAll()` builds the resolver lazily and threads it through `classifyQuery({ isVerb })`. The pure module stays DB-free; the adapter is the only place that imports `bun:sqlite`.

**Hardening roadmap (issue #5, H1–H8):** H4 (this resolver), H6 (`extractMentions`), H7 (BOM/ZWSP), and H8 (confidence flag) shipped. H1 (lenient mode for prose-shaped input), H2 (`Tok.Var`), H3 (paren expression scope), H5 (`source={…}` as block value) remain — they all preserve the same `CanonicalizeOptions` shape so downstream consumers can pick up improvements by diff.

## Cross-References

| Project | Relationship |
|---------|-------------|
| [tikoci/restraml](https://github.com/tikoci/restraml) | Source of `inspect.json` command tree + RAML schema. GitHub Actions run CHR under QEMU to extract command AST via `/console/inspect`, daily checks for new versions. PR #35 adds deep-inspect. Also publishes [GitHub Pages tools](https://tikoci.github.io/restraml/) (see below). |
| [tikoci/routeros-skills](https://github.com/tikoci/routeros-skills) | Source of agent skill guides. Community-created RouterOS domain knowledge for AI agents. 8 skills with YAML frontmatter + markdown body. Embedded in rosetta DB via `extract-skills.ts`. |
| [tikoci/vscode-tikbook](https://github.com/tikoci/vscode-tikbook) | RouterOS script notebook for VSCode. Potential consumer of this DB for Copilot-assisted scripting. |
| [tikoci/lsp-routeros-ts](https://github.com/tikoci/lsp-routeros-ts) | Consumer: hover help, property docs, command path → URL mapping. |
| [tikoci/netinstall](https://github.com/tikoci/netinstall) | RouterOS REST API gotchas (HTTP verb mapping, property name differences). |

### restraml GitHub Pages tools

restraml publishes all `inspect.json` files and interactive tools on GitHub Pages:

- **Index:** <https://tikoci.github.io/restraml/> — version list, links to raw JSON
- **Lookup:** <https://tikoci.github.io/restraml/lookup.html> — command path lookup across versions
- **Diff:** <https://tikoci.github.io/restraml/diff.html> — diff command trees between two versions
- **Raw JSON:** `https://tikoci.github.io/restraml/<version>/extra/inspect.json` (e.g. [7.22](https://tikoci.github.io/restraml/7.22/extra/inspect.json))
  - Base (no extras): `<version>/inspect.json`
  - With extra-packages: `<version>/extra/inspect.json` (preferred — what we extract)

These tools use client-side JavaScript + GitHub API to navigate the inspect.json data. The lookup and diff tools are relatively popular — they answer questions like "was `/ip/firewall/raw` available in 7.15?" and "what changed between 7.21 and 7.22?".

This project has the same data in SQL form, which is more powerful for programmatic queries but less accessible for quick browser lookups. The two are complementary — the GitHub Pages tools are the public-facing interface, while this MCP server is the agent-facing interface to the same underlying command tree data.

## Distribution

### Compiled binaries (no runtime dependencies)

Testers are network admins, not developers — they won't have `bun`, `make`, or `git`. Compiled single-file executables via `bun build --compile` bundle the Bun runtime, `bun:sqlite`, and all dependencies into one binary per platform (~50–80 MB). Testers download a ZIP, run `--setup`, and paste a JSON snippet.

Cross-compilation from macOS to darwin-arm64, darwin-x64, windows-x64, linux-x64. The `--define` flag injects build-time constants (`VERSION`, `REPO_URL`, `IS_COMPILED`) so the binary knows its version and where to find the DB.

### `import.meta.dirname` problem

Bun bakes `import.meta.dirname` at compile time — a compiled binary looks for `ros-help.db` at the *original build path*, not next to the executable. Fixed by detecting the `IS_COMPILED` build-time constant and using `path.dirname(process.execPath)` instead.

### Database via GitHub Releases

The SQLite DB is ~230 MB on disk, ~50 MB gzipped. GitHub Releases has no bandwidth cap for public repos and allows 2 GB per asset. The `--setup` flag downloads from the "latest" release URL (`/releases/latest/download/ros-help.db.gz`), which means we can push new DB versions without changing the binary.

Alternatives considered:

- **Git LFS:** Bandwidth-limited on free tier, clones include all versions
- **GitHub Pages:** 1 GB site limit, 100 MB per file
- **S3/R2:** Extra infrastructure for a testing release

### Binary doubles as setup tool

The `--setup` flag downloads the DB and prints MCP client config snippets for Claude Desktop, Claude Code, VS Code Copilot, Copilot CLI, Cursor, and Codex. This avoids a separate install script and keeps the tester workflow to two steps: run binary, paste config.

### MCP Registry namespace and publishing

Namespace: `io.github.tikoci/rosetta` — GitHub-based reverse-domain namespace. Requires GitHub OAuth for initial publish (`mcp-publisher login github`), no DNS domain verification needed. Chosen for speed over a custom domain namespace.

Publishing order: official MCP Registry (`registry.modelcontextprotocol.io`) first, then GitHub MCP Registry (`github.com/mcp`). The official registry is metadata-only — `server.json` declares the npm package identity and stdio transport. GitHub MCP Registry is a curated discovery surface.

Version policy: publish registry metadata only on tagged stable releases. `server.json` version must stay in sync with `package.json`. CI automation for registry publish deferred until OIDC auth is configured (see BACKLOG.md).

### Code signing deferred

macOS Gatekeeper and Windows SmartScreen warn on unsigned binaries. For v0.1 testing, documented workarounds are sufficient. Signing can be added when distribution goes wider.

### CI release workflow for provenance

Local `make release` works but builds are only as trustworthy as the laptop. The `release.yml` GitHub Actions workflow runs the same extraction pipeline from a remote HTML export URL, creating a release with a traceable commit SHA, CI log, and DB stats in the release notes. This also prepares for eventual NPM publishing — CI-built artifacts have verifiable provenance. Local release continues to work as an alternative path.

### OCI image build: Dockerfile + docker buildx

OCI images are built with a standard `Dockerfile.release` + `docker buildx build --push --platform linux/amd64,linux/arm64`. The builder stage uses `--platform=$BUILDPLATFORM` (always the CI host — amd64) and Bun's `--target` cross-compilation to produce the arm64 binary without QEMU emulation. No crane required.

**Why not crane:** Multiple approaches using crane (single-layer hand-crafted tars; `crane append` + jq config modification) were tried and all failed identically on Docker 28's containerd image store — every exec call failed with `no such file or directory` despite `crane export` confirming file contents were correct. The root cause was never diagnosed. Docker buildx is the correct tool for standard images.

**Two Dockerfiles:**
- `Dockerfile` — base image without DB (for local dev use, DB mounted via `-v`)
- `Dockerfile.release` — release image with DB baked in (`COPY ros-help.db /app/`), used by `release.yml` CI

### npm via npmjs.org

Published as `@tikoci/rosetta` to the public npm registry. The canonical install command is `bunx @tikoci/rosetta` — this is the primary recommendation in the README and in `--setup` output.

The `bin/rosetta.js` shim detects the runtime — under Bun it imports `src/mcp.ts` directly, under Node it spawns `bun` as a subprocess (since the server requires `bun:sqlite`). If Bun is not installed, the Node path prints a clear error directing the user to install Bun and use `bunx`. The `files` whitelist includes `bin/`, `src/`, and `matrix/` — no database, no build artifacts. Published from the `release.yml` workflow using an `NPM_TOKEN` org secret.

### DB path routing (`src/paths.ts`)

Three invocation modes with different DB default locations:

| Mode | Detection | DB location | Config output |
|------|-----------|-------------|---------------|
| **Compiled** | `IS_COMPILED` build-time constant | Next to executable | Full path to binary |
| **Dev** | `.git` exists in project root | Project root | `bun run src/mcp.ts` with `cwd` |
| **Package** | Neither compiled nor dev | `~/.rosetta/ros-help.db` | `bunx @tikoci/rosetta` |

`DB_PATH` env var overrides all modes. Package mode creates `~/.rosetta/` on first run. The `~/.rosetta/` path was chosen over platform-native data dirs (XDG, `~/Library/Application Support`, `%APPDATA%`) for simplicity — same path on all OSes, visible and predictable.

This logic is shared via `src/paths.ts` (used by `db.ts`, `mcp.ts`, `setup.ts`) to avoid divergence between the three path resolution copies. `paths.ts` also exports `resolveVersion()` — reads `package.json` at runtime when the compile-time `VERSION` constant isn't defined, so `bunx @tikoci/rosetta --version` shows a real version number instead of "dev".

## Guiding Principles

These shape all development decisions. If a backlog item or PR conflicts with them, the item is wrong and should be reframed.

### Principle 1 — TUI and MCP are a pair, not a tool and its test harness

The `browse` TUI is a first-class path into the rosetta data, as legitimate as the MCP server. Both surfaces take short, NL-like input and lead the user through the same discovery chain: search → drill-down → related content. The TUI deliberately mimics the MCP tool shape (`s <query>` ≈ `routeros_search`, `page <id>` ≈ `routeros_get_page`, etc.) so improvements on one side reinforce the other.

**Implication:** logic lives in core functions in `query.ts`. `mcp.ts` and `browse.ts` are thin adapters. If a backlog item says "add X to the TUI" or "add X to MCP," first check whether it belongs in core — usually it does.

### Principle 2 — Dual-use is the feature, not a compromise

The TUI's dual role (user tool + test harness for MCP behavior) is deliberate. Gaps visible in `browse` almost always point to gaps in the MCP tool surface. Resist shoving more logic into `browse.ts` or `mcp.ts` — heuristics that could help both audiences belong in `query.ts`.

### Principle 3 — Fewer tools, smarter `routeros_search`

Agents in real sessions typically use `routeros_search` and `routeros_get_page`; anything beyond that is rare. The response is not more tool-description steering — it's making `routeros_search` answer more of the question before the agent asks again. See "North Star Architecture" below.

### Principle 4 — Command/schema work tracks restraml's output shape

The shape of `deep-inspect.json` drives the schema on this side. Structural work, per-arch presence, and completion data are all landed in `schema_nodes`. The `_attrs.completion` catch-all holds completion objects; promotion to structured columns is the next step once shape is confirmed stable across versions.

RouterOS commands have four parts: **Path** (`/ip/`), **Dir** (`/ip/address`), **Command** (`set|print|remove|add`), **Parameters** (named or positional). The `searchProperties()` query function exists for internal use (TUI, restraml enrichment), but was removed as an MCP tool — it was useless without command-tree context. Property data matters for other reasons (feeding restraml's enrichment pipeline).

## North Star Architecture — Unified `routeros_search`

**Status (2026-04-20):** Shipped. `classifyQuery` lives in `src/classify.ts` (pure module, 42 table-driven tests in `classify.test.ts`). `searchAll()` in `src/query.ts` wraps `searchPages` and runs classifier side queries. Both `routeros_search` (MCP) and the TUI `s` command are thin adapters over `searchAll()` per Principle 1. Folded standalone tools `routeros_search_callouts` and `routeros_search_videos` are gone — content surfaces in `related.callouts` / `related.videos`. Tool count dropped 15 → 13.

A single `routeros_search(query)` call that does enough preprocessing, cross-table lookup, and response synthesis that a typical RouterOS question gets a useful, multi-source answer in one roundtrip. Both MCP and TUI route through the same core function.

### Input classifier

Before any FTS query, pre-parse the input with cheap regex-based detectors. Each fires independently:

| Detector | Pattern | Side effect |
|---|---|---|
| **Command path** | `^/[\w-]+(/[\w-]+)*` | Look up in `commands`; return node + children + linked page |
| **Command fragment** | `foo=bar`, `add chain=forward` | Match tokens against `commands.name` and `properties.name` |
| **Version** | `\b7\.\d+(?:\.\d+)?(?:beta\d+\|rc\d+)?\b` | Check `ros_versions`, narrow results |
| **Changelog topic** | Matches a known category | Side query `changelogs` filtered by category |
| **Device model** | `RB\d+`, `CCR\d+`, `hEX`, `hAP`, `CRS\d+`, `CHR` | Side query `devices_fts` |
| **Property name** | Single short lowercase token in `properties.name` | Return property directly (only if no page/command match) |
| **Known topic** | Union of changelog categories + path segments | Soft signal for topic routing |

Detectors are non-exclusive. `bgp 7.22 route reflection` fires **topic**, **version**, and general FTS.

### Enriched response shape

```text
{
  query, classified: { version, topics, command_path, device, property },
  pages: [ ... ],
  related: {
    command_node,    // single object (the matched command-tree node), not an array
    callouts, properties, changelogs, videos, skills, commands, devices, glossary
  },
  next_steps: [ ... concrete follow-up calls ... ]
}
```

All array `related` sections cap at 2–3 entries (scaled by `limit` — see "hunger knob" in CLAUDE.md). `command_node` is a single object when the classifier identified a command path. Empty sections omitted.

### Zero-result handling

Never return bare empty results. Run OR fallback → re-run classifier side queries → return "nothing matched — you might try" block with concrete next queries informed by the classifier.

### Tool consolidation target

Baker's-dozen-ish ceiling is now 14 tools: the surface was consolidated from 15 to 13, then `routeros_explain_command` was added deliberately as a read-only bridge for write-shaped CLI questions. Lower targets (~8–10) would require merging structural drill-downs like `routeros_command_tree`, `routeros_lookup_property`, or `routeros_command_diff` into `routeros_search`, which trades clarity for compression. Not pursuing.

**Folded into `routeros_search` side queries (shipped — no longer standalone MCP tools):**
- `routeros_search_properties` — removed: useless without command-tree context (function kept internally for TUI)
- `routeros_search_callouts` — surfaces in `related.callouts`. `searchCallouts()` kept as internal helper.
- `routeros_search_videos` — surfaces in `related.videos`. `searchVideos()` kept as internal helper and also used by `routeros_get_page` TOC-mode `related_videos`.

**Keep as standalone drill-downs:**
- `routeros_search_changelogs` — version range + category filters are too specific
- `routeros_search_tests` — packet-size + config combinatorics
- `routeros_get_page`, `routeros_device_lookup`, `routeros_command_tree`, `routeros_command_version_check`, `routeros_command_diff`, `routeros_lookup_property`, `routeros_stats`, `routeros_current_versions`

**Name:** keep `routeros_search`. Semantic drift is cheaper than a rename.

## History

What was built, in rough order (March 2026):

1. **PDF extraction** (archival) — `ros-pdf-to-sqlite.py`, `ros-pdf-assess.py`. Proved the concept but PDF parsing was lossy. Superseded by HTML extraction. These files have been removed from the working tree; they exist in git history.
2. **HTML extraction** — `extract-html.ts`, `extract-properties.ts`. 317 pages, 4,860 properties, 1,034 callouts.
3. **Command tree** — `extract-commands.ts`. Single-version first, then multi-version with `extract-all-versions.ts` (46 versions, 1.67M junction entries).
4. **Command linking** — `link-commands.ts`. Automated heuristic matching: code block paths + `<strong>`/`<code>` tag patterns. ~92% dir coverage.
5. **MCP server** — `mcp.ts` + `query.ts`. 11 tools with compound term recognition, BM25 ranking, AND→OR fallback.
6. **Knowledge boundaries** — Tool descriptions document data currency (March 2026 export, 7.9–7.23beta2 versions, no v6).
7. **Distribution** — Compiled single-file binaries via `bun build --compile`, `--setup` mode for DB download + MCP client config, GitHub Releases for assets.
8. **CI release workflow** — `release.yml` workflow_dispatch: download HTML export from URL → extraction pipeline → quality gate → build artifacts → create GitHub Release. Establishes provenance for eventual NPM publishing.
9. **HTTP transport** — Streamable HTTP via `--http` flag for remote/LAN MCP clients (ChatGPT Apps, OpenAI platform). Uses `Bun.serve()` + `WebStandardStreamableHTTPServerTransport`. Optional TLS.
10. **MCP Registry metadata** — `server.json` manifest + CI validation for official registry publication.
11. **North Star (April 2026)** — Regex classifier (`classify.ts`) + `searchAll()` wrapper. Unified `routeros_search` now returns pages + `related` (command_node, properties, devices, callouts, videos, changelogs, skills, glossary) + classifier-informed `next_steps`. Folded `routeros_search_callouts` / `routeros_search_videos` into `related`. MCP tool count 15 → 13.
12. **Smart `get_page()` (April 2026)** — Budget-aware TOC mode. When `max_length` is exceeded, the TOC response now surfaces top properties + related videos + callout summary inline, so small-budget callers rarely need a second tool call.
13. **Canonicalize hardening + `routeros_explain_command` (late April 2026)** — Issue #5 H4/H6/H8 landed: `canonicalize.ts` gained a pluggable `isVerb` resolver (rosetta wires a DB-backed `commands`-table adapter; LSP plans a static `verbs.json` one), an `extractMentions()` for navigation-only path references, and a per-command `confidence` flag. Resolver hits *supplement* the curated universal verb set rather than replacing it (helpers like `find` aren't enumerated under every parent path in `/console/inspect`). On top of that, a read-only `routeros_explain_command` tool brought the MCP surface to 14 — read-only tier-1 explainer for write-shaped CLI questions, threading the new `confidence` through `args` + `warnings`. H1/H2/H3/H5 remain on the books with the same options shape preserved for downstream pickup.
