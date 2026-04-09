# rosetta

RouterOS documentation as SQLite FTS5 — RAG search + command glossary via MCP.

## Project Documentation

Three files, three jobs — agents should use these, not create new top-level `.md` files:

| File | What goes in it |
|------|----------------|
| `CLAUDE.md` | Architecture, schema, conventions — what the project **is** and how it works |
| `DESIGN.md` | Decisions, data sources, constraints, cross-references — **why** things are the way they are |
| `BACKLOG.md` | Ideas, considerations, future work — structured parking lot for anything not yet active |

**Rule:** If it's a decision or rationale → `DESIGN.md`. If it's an idea, question, or future work → `BACKLOG.md`. If it's how the project works → `CLAUDE.md`.

## What This Is

MikroTik's help site (Confluence-based) exports both a ~107MB PDF and an HTML archive of all RouterOS documentation (~317 pages). This project extracts the **HTML export** into a searchable SQLite database and exposes it as an MCP server using the **SQL-as-RAG** pattern: SQLite FTS5 as the retrieval layer for retrieval-augmented generation, exposed over MCP so any LLM client can use it.

Two outputs:

1. **SQL-as-RAG MCP Server** — 13 tools plus 2 CSV resources for LLM agents to search docs, look up properties, browse the command tree, check version history, query device benchmarks, fetch current versions, and attach bulk datasets for reporting
2. **RouterOS Glossary** — command-tree → documentation mapping, feeding [lsp-routeros-ts](https://github.com/tikoci/lsp-routeros-ts) (hover help) and future Copilot integration

## Current State

- **317 pages** from Confluence HTML export (March 2026), with breadcrumb paths, page IDs, help.mikrotik.com URLs
- **515K words**, **14K code lines** (identified by `brush: ros` code blocks)
- **1,034 callouts** extracted (Note/Warning/Info/Tip) from Confluence callout macros
- **2,984 sections** extracted from h1–h3 headings across 275 pages, with anchor IDs for deep linking
- **4,860 properties** extracted from confluenceTable rows (name, type, default, description)
- **40K command tree entries** from `inspect.json` (551 dirs, 5114 cmds, 34K args), primary version: 7.22 (latest stable)
- **46 RouterOS versions tracked** (7.9 through 7.23beta2) — 1.67M command_versions entries
- **92% of dirs linked** to documentation pages via automated code-block + heuristic matching
- **144 devices** from MikroTik product matrix CSV (hardware specs, license levels, pricing)
- **2,874 device test results** from mikrotik.com product pages (ethernet + IPSec throughput benchmarks at 64/512/1518 byte packets) for 125 devices, with block diagrams for 110
- **Changelogs** parsed per-entry from MikroTik download server (category, breaking flag, version metadata)
- **FTS5 indexes** with `porter unicode61` tokenizer (pages, properties, callouts, changelogs) and `unicode61` without porter (devices), BM25-weighted ranking
- **MCP server** with 14 tools and 2 CSV resources: search, get_page, lookup_property, search_properties, command_tree, search_callouts, search_changelogs, command_version_check, command_diff, device_lookup, search_tests, stats, current_versions; resources: `rosetta://datasets/device-test-results.csv`, `rosetta://datasets/devices.csv`

## Schema

```sql
-- Pages (from Confluence HTML export)
pages (
    id INTEGER PRIMARY KEY,  -- Confluence page ID
    slug, title, path,       -- path = 'RouterOS > Firewall > Filter'
    depth, parent_id,
    url,                     -- help.mikrotik.com/docs/spaces/ROS/pages/{id}/{slug}
    text, code, code_lang,
    author, last_updated,
    word_count, code_lines, html_file
)

-- FTS5 over pages
pages_fts USING fts5(title, path, text, code,
    content=pages, content_rowid=id,
    tokenize='porter unicode61'
)

-- Callouts (Note/Warning/Info/Tip from Confluence callout macros)
callouts (
    id, page_id REFERENCES pages(id),
    type,          -- 'Note' | 'Warning' | 'Info' | 'Tip'
    content TEXT,
    sort_order
)

-- FTS5 over callouts
callouts_fts USING fts5(content, ...)

-- Sections (page chunks split by h1–h3 headings)
sections (
    id, page_id REFERENCES pages(id),
    heading, level,        -- heading text, 1/2/3
    anchor_id,             -- Confluence heading ID for deep-link URLs
    text, code,
    word_count, sort_order
)

-- Property tables extracted from confluenceTable
properties (
    id, page_id, name, type, default_val,
    description, section, sort_order,
    UNIQUE(page_id, name, section)
)

-- FTS5 over properties
properties_fts USING fts5(name, description, ...)

-- RouterOS command tree (from inspect.json)
commands (
    id, path UNIQUE,     -- '/ip/firewall/filter'
    name, type,          -- 'dir' | 'cmd' | 'arg'
    parent_path,
    page_id,             -- linked doc page (nullable)
    description,         -- from inspect.json desc field
    ros_version          -- primary version tag
)

-- Version tracking
ros_versions (
    version PRIMARY KEY, -- '7.22', '7.23beta2'
    channel,             -- 'stable' | 'development'
    extra_packages,      -- 0|1
    extracted_at
)

command_versions (
    command_path, ros_version,
    PRIMARY KEY (command_path, ros_version)
)

-- MikroTik product hardware specs (from product matrix CSV)
devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_name UNIQUE, product_code,
    architecture,        -- ARM 64bit, ARM 32bit, MIPSBE, MMIPS, SMIPS
    cpu, cpu_cores, cpu_frequency,
    license_level,       -- 3/4/5/6
    operating_system,    -- RouterOS, RouterOS v7, RouterOS / SwitchOS
    ram, ram_mb,         -- original text + normalized MB
    storage, storage_mb,
    poe_in, poe_out, max_power_w,
    wireless_24_chains, wireless_5_chains,
    eth_fast, eth_gigabit, eth_2500,
    sfp_ports, sfp_plus_ports, eth_multigig,
    usb_ports, sim_slots, msrp_usd,
    product_url,         -- mikrotik.com product page URL
    block_diagram_url    -- CDN URL to block diagram PNG
)

-- FTS5 over devices (unicode61 only — no porter stemming for model numbers)
devices_fts USING fts5(product_name, product_code, architecture, cpu, ...)

-- Device performance test results (from mikrotik.com product pages)
device_test_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id REFERENCES devices(id),
    test_type,           -- 'ethernet' | 'ipsec'
    mode,                -- 'Bridging' | 'Routing' | 'Single tunnel' | '256 tunnels'
    configuration,       -- '25 ip filter rules' | 'AES-128-CBC + SHA1' | etc.
    packet_size INTEGER, -- 64, 512, 1400, 1518
    throughput_kpps REAL,
    throughput_mbps REAL,
    UNIQUE(device_id, test_type, mode, configuration, packet_size)
)

-- Changelogs (parsed per-entry from MikroTik download server)
changelogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,    -- '7.22', '7.22.1'
    released TEXT,            -- '2026-Mar-09 10:38'
    category TEXT NOT NULL,   -- subsystem: 'bgp', 'bridge', 'wifi'
    is_breaking INTEGER NOT NULL DEFAULT 0,  -- 1 for !) entries
    description TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    UNIQUE(version, sort_order)
)

-- FTS5 over changelogs
changelogs_fts USING fts5(category, description,
    content=changelogs, content_rowid=id,
    tokenize='porter unicode61'
)

-- YouTube video metadata (from yt-dlp transcript extraction)
videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL UNIQUE,   -- YouTube video ID
    title, description, channel,
    upload_date,                     -- YYYYMMDD string
    duration_s INTEGER,              -- duration in seconds
    url TEXT NOT NULL,               -- https://youtube.com/watch?v=...
    view_count INTEGER,
    like_count INTEGER,
    has_chapters INTEGER NOT NULL DEFAULT 0  -- 1 if yt-dlp provided chapters
)

-- FTS5 over video titles/descriptions
videos_fts USING fts5(title, description,
    content=videos, content_rowid=id,
    tokenize='porter unicode61'
)

-- Chapter-level transcript segments (one row per chapter, or one row for no-chapter videos)
video_segments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER REFERENCES videos(id),  -- FK to videos.id (INTEGER, NOT videos.video_id)
    chapter_title TEXT,              -- NULL if video has no chapters
    start_s INTEGER NOT NULL DEFAULT 0,
    end_s INTEGER,                   -- NULL for single-segment no-chapter videos
    transcript TEXT NOT NULL,        -- joined cue text for this segment
    sort_order INTEGER NOT NULL
)

-- FTS5 over transcript segments
video_segments_fts USING fts5(chapter_title, transcript,
    content=video_segments, content_rowid=id,
    tokenize='porter unicode61'
)
```

## Usage

### MCP Server

```sh
bunx @tikoci/rosetta           # npm package (recommended)
bun run src/mcp.ts             # dev mode (stdio transport)
./rosetta                      # compiled binary
```

Register in MCP client config (bunx example — no paths needed):

```json
{
  "servers": {
    "rosetta": {
      "command": "bunx",
      "args": ["@tikoci/rosetta"]
    }
  }
}
```

### MCP Tools

| Tool | Purpose |
|------|---------|
| `routeros_search` | FTS5 search across pages. BM25 ranked, AND→OR fallback |
| `routeros_get_page` | Full page text by ID or title. Section-aware: `max_length` defaults to 16000; large pages return TOC (with callout summary instead of full callouts); `section` param retrieves specific sections (also subject to `max_length`) |
| `routeros_lookup_property` | Property by exact name, optionally filtered by command path |
| `routeros_search_properties` | FTS across property names + descriptions, AND→OR fallback |
| `routeros_command_tree` | Browse command hierarchy at a given path |
| `routeros_search_callouts` | FTS across callouts, type-only browse, AND→OR fallback |
| `routeros_search_changelogs` | FTS across parsed changelog entries, version range + category + breaking-only filters |
| `routeros_command_version_check` | Version range for a command path, boundary notes |
| `routeros_command_diff` | Structural diff between two RouterOS versions — added/removed commands at a path prefix |
| `routeros_device_lookup` | Hardware specs by product name/code, FTS search with structured filters (architecture, RAM, license, PoE, wireless) |
| `routeros_search_tests` | Cross-device performance benchmarks — filter by test_type, mode, configuration, packet_size; one call replaces 125+ individual lookups |
| `routeros_search_videos` | FTS across YouTube video transcript segments — chapter-level results with timestamps and excerpts |
| `routeros_stats` | DB health: page/property/command/device counts, link coverage |
| `routeros_current_versions` | Live-fetch current RouterOS versions per channel |

Tool descriptions include workflow arrows (→ next tool) and empty-result hints to guide LLM agents between tools.

Device lookup matching is intentionally heuristic, not perfect canonical identity resolution. `routeros_device_lookup` handles many user forms (exact name/code, LIKE, FTS, slug-normalized fallback, superscript normalization, and disambiguation notes), but renamed-model aliases can still miss and should be treated as ongoing work rather than a solved problem.

### MCP Resources

| Resource | Purpose |
|----------|---------|
| `rosetta://datasets/device-test-results.csv` | Full joined benchmark dataset as CSV for reporting, charts, and bulk export |
| `rosetta://datasets/devices.csv` | Full device catalog as CSV with normalized fields and URLs |

Resources are for explicit context attachment in MCP clients that support them (for example, VS Code's Add Context > MCP Resources). They complement the tools rather than replacing them.

### CLI Search

```sh
bun run src/search.ts "DHCP server"
```

### Direct SQL

```sh
sqlite3 ros-help.db "SELECT title, url FROM pages_fts WHERE pages_fts MATCH 'DHCP lease' ORDER BY rank LIMIT 5;"
```

## Distribution

Four install paths:

### Option A: MikroTik /app container (primary for router admins)

RouterOS 7.22+ on x86 or ARM64. One `/app/add` command installs the container with auto-update. The MCP endpoint URL is shown as `ui-url` in the router UI (WebFig or CLI). Uses the same OCI images from GHCR. HTTPS via MikroTik-managed `*.routingthecloud.net` certificates (requires `/ip/cloud`; CHR free/trial mode needs `use-https=no`).

### Option B: npm package (`bunx @tikoci/rosetta`)

Requires [Bun](https://bun.sh/). MCP clients use `bunx @tikoci/rosetta` as the command — no paths to configure. Database auto-downloads to `~/.rosetta/ros-help.db`. No Gatekeeper/SmartScreen issues since there's no standalone binary.

### Option C: Compiled binary (no runtime needed)

Single-file executables from GitHub Releases. User runs `--setup` to download DB and print MCP config.

### Release Workflow

The Makefile is the source of truth for releasing. It chains preflight checks, build, git tagging, and upload:

```sh
make build-release VERSION=v0.1.0          # Build artifacts only (no git, no upload)
make release VERSION=v0.1.0                # Full flow: preflight → build → tag → push → create release
make release VERSION=v0.1.0 FORCE=1        # Update existing: preflight → build → force-move tag → upload --clobber
```

`make preflight` runs independently as a health check: clean working tree, DB exists, typecheck, tests, lint.

Produces in `dist/`:

- `rosetta-macos-arm64.zip` — macOS Apple Silicon
- `rosetta-macos-x64.zip` — macOS Intel
- `rosetta-windows-x64.zip` — Windows
- `rosetta-linux-x64.zip` — Linux
- `ros-help.db.gz` — compressed database

Also publishes multi-arch OCI images (linux/amd64 + linux/arm64):

- `ammo74/rosetta:<tag>` on Docker Hub
- `ghcr.io/tikoci/rosetta:<tag>` on GHCR

Per release, tags are `VERSION`, `latest`, and `sha-<12-char-commit>`.

The `FORCE=1` flag:

- Force-moves the git tag to HEAD (`git tag -f`)
- Force-pushes the tag (`git push --force`)
- Replaces release assets (`gh release upload --clobber`)

Without `FORCE`, the release target errors if the tag already exists and uses `gh release create`.

### Tester Workflow

**Option A: npm (requires Bun — recommended)**

Configure MCP client with `bunx @tikoci/rosetta` as the command. Database auto-downloads on first launch to `~/.rosetta/ros-help.db`. No setup step needed.

```sh
bunx @tikoci/rosetta --setup   # Optional: verify + print MCP config snippets
```

**Option B: Compiled binary (no runtime needed)**

1. Download platform ZIP from GitHub Releases
2. Run `rosetta --setup` (downloads DB, prints config)
3. Paste config into MCP client (Claude Desktop / Claude Code / VS Code Copilot / Copilot CLI / Cursor / Codex)

### CLI Flags

| Flag | Purpose |
|------|---------|
| `--setup` | Download DB + print MCP config |
| `--setup --force` | Re-download DB |
| `--version` | Print version |
| `--help` | Print usage |
| `--http` | Start with Streamable HTTP transport (instead of stdio) |
| `--port <N>` | HTTP listen port (default: 8080, env: `PORT`) |
| `--host <ADDR>` | HTTP bind address (default: localhost, env: `HOST`) |
| `--tls-cert <PATH>` | TLS certificate PEM file (enables HTTPS) |
| `--tls-key <PATH>` | TLS private key PEM file (requires `--tls-cert`) |
| *(none)* | Start MCP server (stdio) |

HTTP/TLS env vars:

- `PORT`, `HOST` (lower precedence than CLI flags)
- `TLS_CERT_PATH`, `TLS_KEY_PATH` (lower precedence than `--tls-cert`/`--tls-key`)

### HTTP Transport

For MCP clients that require HTTP instead of stdio (e.g., OpenAI platform, remote/LAN access):

```sh
rosetta --http                              # localhost:8080/mcp
rosetta --http --port 9090                  # custom port
rosetta --http --host 0.0.0.0              # LAN-accessible
rosetta --http --tls-cert cert.pem --tls-key key.pem  # HTTPS
```

Uses the MCP Streamable HTTP transport (spec 2025-03-26) via `Bun.serve()` + `WebStandardStreamableHTTPServerTransport` in stateful mode with per-session transport routing. Each MCP client session gets its own transport instance and `McpServer`, matching the SDK's recommended pattern. The endpoint is `/mcp`. Clients connect with a URL like `http://localhost:8080/mcp`.

**Security:** Defaults to localhost binding. LAN binding (`--host 0.0.0.0`) logs a warning. Origin header validation prevents DNS rebinding. For production network exposure, use a reverse proxy or `--tls-cert`/`--tls-key`.

## Files

| File | Purpose |
|------|---------|
| `src/mcp.ts` | MCP server — 13 tools + 2 CSV resources, stdio + Streamable HTTP transport |
| `src/query.ts` | NL → FTS5 query planner, BM25 ranking, OR fallback, version sorting |
| `src/db.ts` | Schema init, singleton DB, WAL mode |
| `src/extract-html.ts` | HTML → pages + callouts + sections tables (repeatable) |
| `src/extract-properties.ts` | Property table parsing from HTML |
| `src/restraml.ts` | Shared helpers for fetching from tikoci/restraml (GitHub API + Pages) |
| `src/extract-commands.ts` | inspect.json → commands table (version-aware) |
| `src/extract-all-versions.ts` | Batch extract all RouterOS versions from restraml |
| `src/extract-devices.ts` | Product matrix CSV → devices table (idempotent) |\n| `src/extract-test-results.ts` | mikrotik.com product pages → device_test_results + block diagram URLs (idempotent) |
| `src/extract-changelogs.ts` | MikroTik download server changelogs → changelogs table (idempotent) |
| `src/extract-videos.ts` | MikroTik YouTube channel transcripts → videos + video_segments tables (incremental; requires yt-dlp) |
| `src/link-commands.ts` | Command ↔ page mapping |
| `src/assess-html.ts` | HTML archive assessment (run once) |
| `src/search.ts` | CLI search tool |
| `src/query.test.ts` | Bun tests — query planner + DB integration + schema health (in-memory SQLite) |
| `src/release.test.ts` | Release readiness tests — file consistency, build constants, structural patterns, container setup |
| `src/mcp-http.test.ts` | HTTP transport integration — session lifecycle, multi-client, errors (live server process) |
| `src/setup.ts` | DB download from GitHub Releases + MCP client config printing |
| `src/paths.ts` | Shared DB path + version resolution — three modes: compiled / dev / package (`~/.rosetta/`) |
| `server.json` | Official MCP Registry metadata manifest for `io.github.tikoci/rosetta` publication |
| `scripts/build-release.ts` | Cross-compile binaries for 4 platforms, package ZIPs |
| `scripts/container-entrypoint.sh` | OCI image entrypoint — defaults to HTTP transport, optional TLS from env |
| `bin/rosetta.js` | npm bin shim — Bun: direct import, Node: spawns `bun` subprocess |
| `.github/workflows/test.yml` | CI: typecheck + test + lint on push/PR/manual |
| `.github/workflows/release.yml` | CI: build DB from HTML export URL + publish OCI images + create GitHub Release + npm publish |
| `ros-help.db` | The SQLite database (WAL mode) |
| `CONTRIBUTING.md` | Build, test, development setup, release process |

## Re-extraction

When a new HTML/PDF export is available:

```sh
# Place new export in box/ and update symlink
# ln -s documents-export-<date> box/latest
make clean
make extract       # runs extract-html, extract-properties, extract-commands, extract-devices, link (single version)
make extract-full  # runs extract-html, extract-properties, extract-all-versions, extract-devices, link (all versions)
```

The Makefile orchestrates the full pipeline. Each script drops and recreates its tables.

## CI Release Workflow

The `release.yml` workflow (`workflow_dispatch`) builds the database from a remote HTML export URL and creates a GitHub Release — same pipeline as local, but traceable to a specific commit and CI log.

**Inputs:** `html_url` (required — direct download URL to `.zip`), `version` (required — tag like `v0.2.0`), `docs_date` (optional — export date for traceability), `full_versions` (default: true — all 46 RouterOS versions), `force` (default: false — overwrite existing release).

**Steps:** download + validate zip → extract HTML → run full extraction pipeline → quality gate (typecheck + test + lint) → build release artifacts + OCI image tars → publish OCI images to Docker Hub/GHCR → smoke-test pulled `sha-*` images on `/mcp` → create GitHub Release with DB stats in release notes.

For Seafile links (box.mikrotik.com), append `&dl=1` for direct download. Product matrix CSV uses the committed copy in `matrix/`.

## Source Details

### HTML Archive (Primary)

- **Export:** Confluence space export, March 2026
- **Format:** 317 HTML files + attachments in `box/latest/ROS/` (symlink → `box/documents-export-2026-3-25`)
- **Structure:** Consistent Confluence classes (`confluenceTable`, `confluenceTh`, `syntaxhighlighter-pre`)
- **Property tables:** 605 tables with "Property | Description" headers across 147 pages
- **Code blocks:** `data-syntaxhighlighter-params="brush: ros"` for RouterOS CLI

### Command Tree (inspect.json)

- **Source:** `inspect.json` files from [tikoci/restraml](https://github.com/tikoci/restraml) — 46 versions extracted
- **Access path:** version discovery via GitHub API (1 call to `api.github.com/repos/tikoci/restraml/contents/docs`), inspect.json fetched from GitHub Pages (`https://tikoci.github.io/restraml/<version>/extra/inspect.json`) — no rate limit on the actual data. Optional local path override for offline extraction.
- **Generation:** GitHub Actions run RouterOS CHR under QEMU, daily version checks. Two builds per version: base (`routeros.npk` only) and extra (all extra-packages available on CHR). We use the `extra/` variant.
- **Content:** Full RouterOS API from `/console/inspect` — 551 dirs, 5114 cmds, 34K args (primary: 7.22)
- **Versions:** 7.9 through 7.23beta2 (stable + development channels). New versions appear weekly; the latest stable is auto-detected as primary.
- **Primary version:** latest stable from inspect.json (currently 7.22.1) — used for the `commands` table and linking. Note: this is newer than the HTML docs export (pinned to 7.22) since HTML exports are manual/monthly while inspect.json versions are automated/daily.
- **Version tracking:** 1.67M entries in `command_versions` junction table
- **Coverage gap:** CHR doesn't have Wi-Fi hardware, so wireless driver packages (`wifi-qcom`, etc.) are missing from inspect.json. Some packages like `zerotier` are also absent. The HTML docs cover these — inspect.json doesn't.

### Product Matrix (CSV)

- **Source:** Manual browser export from `https://mikrotik.com/products/matrix` (PowerGrid table)
- **Format:** CSV with UTF-8 BOM, 34 columns, 144 products (March 2026)
- **Location:** `matrix/2026-03-25/matrix.csv` — date-stamped snapshots stored in git
- **Download:** Open the URL, click the export/download icon (top-left), choose "All", save to `matrix/<ISODATE>/matrix.csv`
- **Columns:** Product name, product code, architecture, CPU, cores, frequency, license level, OS, RAM, storage, dimensions, PoE in/out, power, wireless chains/antenna, ethernet/SFP/combo ports, USB, SIM, price
- **Architectures:** ARM 64bit, ARM 32bit, MIPSBE, MMIPS, SMIPS
- **Normalized fields:** RAM and storage parsed to MB integers at extraction time for structured filtering
- **Name-matching caveat:** Product references vary across official sources (matrix name, product code, product URL slug, and HTML docs). The Product Naming page (`ROS/pages/17498146`) helps with pattern-based decoding, but there are exceptions and renames, so alias coverage remains iterative.

### Product Test Results + Block Diagrams

- **Source:** Individual product pages on `https://mikrotik.com/product/<slug>` (scraped via HTTP + linkedom)
- **Coverage:** 125 of 144 devices have test results, 110 have block diagram URLs
- **Test types:** Ethernet (bridging/routing at 64/512/1518 byte) and IPSec (tunnel throughput at 64/512/1400 byte with AES/SHA cipher configs)
- **Modes:** Ethernet: Bridging, Routing (each with configs like "none (fast path)", "25 ip filter rules", "25 simple queues"). IPSec: Single tunnel, 256 tunnels (with AES-128/256 + SHA1/SHA256 combos)
- **Block diagrams:** PNG images on MikroTik CDN (`cdn.mikrotik.com/web-assets/product_files/...`)
- **URL slugs:** Wildly inconsistent — extractor tries 4–6 slug variants per product (lowercase name, product code, ± `plus` for `+`, Unicode superscript transliteration). 15 products have no discoverable page (kits, discontinued, unpredictable slugs)
- **Extraction:** `bun run src/extract-test-results.ts` (or `make extract-test-results`). Requires devices table populated first. Rate-limited HTTP fetches (default: 4 concurrent, 500ms delay). Idempotent.

## Related Projects

See `DESIGN.md` for full cross-references, restraml GitHub Pages tools, and rationale.

- **[tikoci/restraml](https://github.com/tikoci/restraml)** — source of `inspect.json` command tree data. Also publishes [interactive lookup/diff tools](https://tikoci.github.io/restraml/) and raw JSON on GitHub Pages.
- **[tikoci/lsp-routeros-ts](https://github.com/tikoci/lsp-routeros-ts)** — consumer of property/command data from this DB
- **[tikoci/vscode-tikbook](https://github.com/tikoci/vscode-tikbook)** — RouterOS script notebook for VSCode. Potential consumer for Copilot-assisted scripting.
- **[tikoci/netinstall](https://github.com/tikoci/netinstall)** — RouterOS REST API gotchas (HTTP verb mapping, property name differences)
