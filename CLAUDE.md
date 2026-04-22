# rosetta

RouterOS documentation as SQLite FTS5 — RAG search + command glossary via MCP.

## Project Documentation

Six doc files, each with a clear role — agents should use these, not create new top-level `.md` files:

| File | What goes in it |
|------|----------------|
| `CLAUDE.md` | Architecture, schema, conventions — what the project **is** and how it works |
| `DESIGN.md` | Decisions, data sources, constraints, cross-references — **why** things are the way they are |
| `BACKLOG.md` | Ideas, considerations, future work — structured parking lot for anything not yet active |
| `CHANGELOG.md` | User-visible changes per release (Keep a Changelog format) — **what** shipped, in which version |
| `README.md` | User-facing quick start — `/app` install, bunx setup, browse TUI, tool overview |
| `MANUAL.md` | Extended reference — binary install, HTTP transport, CLI flags, data sources, troubleshooting, DB schema |

**Rule:** If it's a decision or rationale → `DESIGN.md`. If it's an idea, question, or future work → `BACKLOG.md`. If it's how the project works → `CLAUDE.md`. If it's a behaviour change that shipped → `CHANGELOG.md` (under `[Unreleased]` until a release tags it). User-facing install/usage → `README.md` (concise) or `MANUAL.md` (detailed).

**Changelog discipline (agentic rule).** When you make a change with a user-visible effect — CLI flag, MCP tool shape, DB schema, CI behaviour, install/update flow, documented invariant — add a one-line bullet under `CHANGELOG.md` → `[Unreleased]` → the appropriate section (`Added` / `Changed` / `Fixed` / `Removed` / `Deprecated` / `Security`) in the same commit. Do **not** list every internal commit; one bullet per behaviour change is enough. Pure refactors, test churn, and CI auto-bumps with no external effect are omitted — git history is authoritative for those. The `bump-version` CI job automatically promotes `[Unreleased]` → `[VERSION] — DATE` and prepends a fresh `[Unreleased]` skeleton after every release — no manual version-heading fixup is needed.

## What This Is

MikroTik's help site (Confluence-based) exports both a ~107MB PDF and an HTML archive of all RouterOS documentation (~317 pages). This project extracts the **HTML export** into a searchable SQLite database and exposes it as an MCP server using the **SQL-as-RAG** pattern: SQLite FTS5 as the retrieval layer for retrieval-augmented generation, exposed over MCP so any LLM client can use it.

Three outputs (three surfaces, one core):

1. **SQL-as-RAG MCP Server** (`src/mcp.ts`) — 13 tools plus 2 CSV resources for LLM agents. Unified `routeros_search` runs a regex classifier (`src/classify.ts`), executes side queries in parallel, and returns pages + a `related` block (command_node, properties, devices, callouts, videos, changelogs, skills) + `next_steps` hints. Consolidation from 15 tools achieved by folding `routeros_search_callouts` and `routeros_search_videos` into that `related` block; see `DESIGN.md` "North Star".
2. **Browse TUI** (`src/browse.ts`) — interactive terminal browser with keyword-driven NL-like input. **First-class path into the data, not a test harness that happens to be usable.** Every MCP tool has a TUI command that mirrors its shape (`s <query>` ≈ `routeros_search`, `page <id>` ≈ `routeros_get_page`, etc.).
3. **RouterOS Glossary** — command-tree → documentation mapping, feeding [lsp-routeros-ts](https://github.com/tikoci/lsp-routeros-ts) (hover help) and future Copilot integration.

### TUI and MCP share core logic — adapters stay thin

Both the MCP tool layer and the TUI are thin adapters over query functions in `src/query.ts`. When you add a feature, the question to ask is "does this belong in core?" — the answer is usually yes. The MCP side renders results as structured objects for LLM consumption; the TUI side renders them as ANSI-colored text for humans. Both take the same short, keyword-driven input and lead the user through the same discovery chain: **search → drill-down → related content.**

This is a deliberate design, not a happy accident. The TUI's dual use (human tool + MCP behavior test harness) is the feature. Gaps visible in `browse` almost always point to gaps in the MCP tool surface. Any PR that grows TUI-only or MCP-only heuristics is a smell — the heuristic probably belongs in `query.ts` so both surfaces inherit it.

The TUI is a **superset** of MCP — paged ANSI rendering, Markdown→ANSI for skill/page content, context-aware drill-down — but every MCP tool is also reachable verbatim through a **dot-command** (`.routeros_search query=foo limit=12`, `.routeros_get_page 28282`, `.routeros_stats`, …). Dot-commands invoke the same query function the MCP server uses and dump raw JSON, so a human can always see exactly what an agent would receive. `.help` lists the 13 dot-commands. This is the contract: TUI may be richer, but the agent-facing surface stays directly observable.

## Current State

- **317 pages** from Confluence HTML export (March 2026), with breadcrumb paths, page IDs, help.mikrotik.com URLs
- **515K words**, **14K code lines** (identified by `brush: ros` code blocks)
- **1,034 callouts** extracted (Note/Warning/Info/Tip) from Confluence callout macros
- **2,984 sections** extracted from h1–h3 headings across 275 pages, with anchor IDs for deep linking
- **4,860 properties** extracted from confluenceTable rows (name, type, default, description)
- **40K command tree entries** from `inspect.json` / `deep-inspect.json` (551 dirs, 5114 cmds, 34K args), primary version: 7.22 (latest stable)
- **Multi-arch schema** via `schema_nodes` table — dual-arch deep-inspect files track x86/arm64 differences, completion data (11K+ args with valid values), and desc decomposition (enum, range, type parsing)
- **46 RouterOS versions tracked** (7.9 through 7.23beta2) — 1.67M command_versions entries
- **92% of dirs linked** to documentation pages via automated code-block + heuristic matching
- **144 devices** from MikroTik product matrix CSV (hardware specs, license levels, pricing)
- **2,874 device test results** from mikrotik.com product pages (ethernet + IPSec throughput benchmarks at 64/512/1518 byte packets) for 125 devices, with block diagrams for 110
- **Changelogs** parsed per-entry from MikroTik download server (category, breaking flag, version metadata)
- **8 agent skills** from tikoci/routeros-skills (community-created, human-reviewed guides with provenance attribution)
- **FTS5 indexes** with `porter unicode61` tokenizer (pages, properties, callouts, changelogs, skills) and `unicode61` without porter (devices), BM25-weighted ranking
- **MCP server** with 13 tools and 8+ resources: search, get_page, lookup_property, command_tree, search_changelogs, command_version_check, command_diff, device_lookup, search_tests, dude_search, dude_get_page, stats, current_versions; callouts and videos surface inside `routeros_search`'s `related` block (no longer standalone tools). Resources: `rosetta://datasets/device-test-results.csv`, `rosetta://datasets/devices.csv`, `rosetta://schema.sql`, `rosetta://schema-guide.md`, `rosetta://skills` (listing), `rosetta://skills/{name}` (per-skill)

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

-- RouterOS command tree (from inspect.json / deep-inspect.json)
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
    extracted_at,
    api_transport,       -- from deep-inspect _meta (e.g., 'rest')
    enrichment_duration_ms, -- deep-inspect enrichment time
    crash_paths_safe     -- deep-inspect crash safety metadata
)

command_versions (
    command_path, ros_version,
    PRIMARY KEY (command_path, ros_version)
)

-- Multi-arch schema nodes (from deep-inspect.json — richer than commands table)
schema_nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,       -- 'dir' | 'cmd' | 'arg'
    parent_id INTEGER REFERENCES schema_nodes(id),
    parent_path TEXT,
    dir_role TEXT,            -- 'list' | 'namespace' | 'hybrid' (dirs only)
    desc_raw TEXT,            -- raw description from inspect.json
    data_type TEXT,           -- parsed: 'string' | 'integer' | 'time' | 'enum' | 'script' | 'range'
    enum_values TEXT,         -- JSON array of enum values
    enum_multi INTEGER,       -- 1 if multi-select enum (e.g., "ftp|read[,Permission*]")
    type_tag TEXT,            -- type tag from multi-select (e.g., "Permission")
    range_min TEXT,           -- lower bound for ranged types
    range_max TEXT,           -- upper bound for ranged types
    max_length INTEGER,       -- max string length
    _arch TEXT,              -- NULL=both arches, 'x86'/'arm64'=platform-specific
    _package TEXT,           -- future: package that provides this node
    _attrs TEXT,             -- JSON catch-all (completion data, future metadata)
    page_id INTEGER REFERENCES pages(id),
    UNIQUE(path, type)
)

-- schema_nodes version presence (flat junction — no arch column, arch is on schema_nodes)
schema_node_presence (
    node_id INTEGER NOT NULL REFERENCES schema_nodes(id),
    version TEXT NOT NULL,
    PRIMARY KEY (node_id, version)
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

-- The Dude wiki documentation (archived from wiki.mikrotik.com via Wayback Machine)
dude_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,   -- 'Probes', 'Device_discovery'
    title, path,                 -- path = 'The Dude > v6 > Probes'
    version TEXT NOT NULL DEFAULT 'v6',  -- 'v6' or 'v3'
    url,                         -- original wiki.mikrotik.com URL
    wayback_url,                 -- web.archive.org snapshot URL used
    text, code,
    last_edited,
    word_count
)

-- Dude page screenshots (downloaded from Wayback Machine)
dude_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id INTEGER NOT NULL REFERENCES dude_pages(id),
    filename, alt_text, caption,
    local_path,                  -- 'dude/images/Dude-probes-all.JPG'
    original_url, wayback_url,
    sort_order
)

-- FTS5 over dude pages
dude_pages_fts USING fts5(title, path, text, code,
    content=dude_pages, content_rowid=id,
    tokenize='porter unicode61'
)

-- Agent skill guides (from tikoci/routeros-skills — community content, not official MikroTik docs)
skills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,       -- 'routeros-fundamentals'
    description TEXT,                 -- from YAML frontmatter
    content TEXT NOT NULL,            -- full SKILL.md markdown (frontmatter stripped)
    source_repo TEXT NOT NULL DEFAULT 'tikoci/routeros-skills',
    source_sha TEXT,                  -- git commit SHA at extraction time
    source_url TEXT,                  -- GitHub URL to SKILL.md
    word_count INTEGER,
    extracted_at TEXT                  -- ISO 8601
)

-- Reference docs for each skill
skill_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL REFERENCES skills(id),
    path TEXT NOT NULL,               -- 'references/rest-api-patterns.md'
    filename TEXT NOT NULL,           -- 'rest-api-patterns.md'
    content TEXT NOT NULL,
    word_count INTEGER,
    UNIQUE(skill_id, path)
)

-- FTS5 over skills
skills_fts USING fts5(name, description, content,
    content=skills, content_rowid=id,
    tokenize='porter unicode61'
)

-- Glossary of RouterOS terms and abbreviations (seeded at DB init)
glossary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL UNIQUE,   -- canonical lowercase term
    definition TEXT NOT NULL,
    category TEXT NOT NULL,      -- 'product' | 'protocol' | 'subsystem' | 'concept'
    aliases TEXT,                -- comma-separated alternate names
    search_hint TEXT,            -- suggested search query for routeros_search
    UNIQUE(term)
)

-- DB provenance and update metadata (key/value to avoid schema churn).
-- Stamped by scripts/stamp-db-meta.ts in CI; read by mcp.ts startup banner
-- and the bunx auto-update flow. Standard keys: release_tag, built_at,
-- source_commit, schema_version. Added in SCHEMA_VERSION 5.
db_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
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
| `routeros_search` | Unified RouterOS search — regex classifier (command path, version, device, topics) + BM25 FTS + parallel side queries. Returns `{query, classified, pages, related: {command_node, properties, devices, callouts, videos, changelogs, skills}, next_steps}` |
| `routeros_get_page` | Full page text by ID or title. Section-aware: `max_length` defaults to 16000; large pages return TOC with **top properties + related videos + callout summary** surfaced up front; `section` param retrieves specific sections |
| `routeros_lookup_property` | Property by exact name, optionally filtered by command path |
| `routeros_command_tree` | Browse command hierarchy at a given path |
| `routeros_search_changelogs` | FTS across parsed changelog entries, version range + category + breaking-only filters |
| `routeros_command_version_check` | Version range for a command path, boundary notes |
| `routeros_command_diff` | Structural diff between two RouterOS versions — added/removed commands at a path prefix |
| `routeros_device_lookup` | Hardware specs by product name/code, FTS search with structured filters (architecture, RAM, license, PoE, wireless) |
| `routeros_search_tests` | Cross-device performance benchmarks — filter by test_type, mode, configuration, packet_size; one call replaces 125+ individual lookups |
| `routeros_dude_search` | FTS across archived Dude wiki docs — separate from main RouterOS search |
| `routeros_dude_get_page` | Full Dude wiki page by ID or title, with screenshot metadata |
| `routeros_stats` | DB health: page/property/command/device counts, link coverage |
| `routeros_current_versions` | Live-fetch current RouterOS versions per channel |

**Folded into `routeros_search.related`** (no longer standalone tools): callouts (FTS match surfaced in `related.callouts`), videos (FTS match surfaced in `related.videos`), glossary (term/alias match in `related.glossary`). `searchCallouts`, `searchVideos`, and `lookupGlossary` remain in `query.ts` as internal helpers used by `searchAll()`.

**`limit` as a hunger knob.** `routeros_search`'s `limit` parameter scales caps in the `related` block proportionally via `relatedCaps(limit)` — higher `limit` = more callouts/videos surfaced. Lets agents express how much context they want through one knob instead of forcing many narrow tool calls. (Inspired by David Parra's MCP talk: <https://youtu.be/v3Fr2JR47KA>.)

Tool descriptions include workflow arrows (→ next tool) and empty-result hints to guide LLM agents between tools.

Device lookup matching is intentionally heuristic, not perfect canonical identity resolution. `routeros_device_lookup` handles many user forms (exact name/code, LIKE, FTS, slug-normalized fallback, superscript normalization, and disambiguation notes), but renamed-model aliases can still miss and should be treated as ongoing work rather than a solved problem.

### MCP Resources

| Resource | Purpose |
|----------|---------|
| `rosetta://datasets/device-test-results.csv` | Full joined benchmark dataset as CSV for reporting, charts, and bulk export |
| `rosetta://datasets/devices.csv` | Full device catalog as CSV with normalized fields and URLs |
| `rosetta://schema.sql` | Live DDL from sqlite_master — all CREATE TABLE/VIRTUAL TABLE/TRIGGER/INDEX statements |
| `rosetta://schema-guide.md` | Table relationships, FTS5 tokenizer differences, BM25 weights, join patterns, and gotchas |
| `rosetta://skills` | Listing of all agent skill guides with names, descriptions, and word counts |
| `rosetta://skills/{name}` | Full skill content with provenance header — one resource per skill (community content from tikoci/routeros-skills) |

Resources are for explicit context attachment in MCP clients that support them (for example, VS Code's Add Context > MCP Resources). They complement the tools rather than replacing them.

**Skills resources** are supplemental, community-created agent guides — not official MikroTik documentation. Every skill response includes a provenance header warning that content is AI-generated, human-reviewed, and may contain errors. Agents should verify claims using `routeros_search` and `routeros_get_page`.

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
|------|---------|| `browse` | Interactive terminal browser (REPL) |
| `browse <cmd> [args]` | Run any TUI command, then enter REPL (e.g. `browse changelog 7.20..7.22`) |
| `browse --once <cmd>` | Execute any TUI command and exit — no REPL (for piping) || `--setup` | Download DB + print MCP config |
| `--setup --force` | Re-download DB |
| `--refresh` | Shortcut for `--setup --force` (refresh DB) |
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
| `src/classify.ts` | Pre-search regex classifier — detects command path, version, topics, device model, command fragment, property-name candidate. Pure module, no DB |
| `src/query.ts` | NL → FTS5 query planner, BM25 ranking, OR fallback, version sorting |
| `src/db.ts` | Schema init, singleton DB, WAL mode |
| `src/extract-html.ts` | HTML → pages + callouts + sections tables (repeatable) |
| `src/canonicalize.ts` | Pure RouterOS CLI path canonicalizer — maps any input form to `{ path, verb, args }` tuples |
| `src/extract-properties.ts` | Property table parsing from HTML |
| `src/restraml.ts` | Shared helpers for fetching from tikoci/restraml (GitHub API + Pages) |
| `src/extract-commands.ts` | inspect.json → commands table (version-aware, legacy fallback for pre-deep-inspect versions) |
| `src/extract-schema.ts` | deep-inspect.json → schema_nodes + schema_node_presence tables (dual-arch, completion data, desc parsing). Also regenerates `commands` + `command_versions` for backward compat |
| `src/extract-all-versions.ts` | Batch extract all RouterOS versions from restraml (prefers deep-inspect files, falls back to inspect.json) |
| `src/extract-devices.ts` | Product matrix CSV → devices table (idempotent) |
| `src/extract-test-results.ts` | mikrotik.com product pages → device_test_results + block diagram URLs (idempotent) |
| `src/extract-changelogs.ts` | MikroTik download server changelogs → changelogs table (idempotent) |
| `src/extract-videos.ts` | MikroTik YouTube channel transcripts → videos + video_segments tables (incremental; requires yt-dlp). Cache functions: `saveCache`/`importCache`/`loadKnownBad`/`findLatestCache` for CI-friendly NDJSON cache. |
| `src/extract-dude.ts` | Wayback Machine → dude_pages + dude_images tables (one-time, caches HTML to `dude/pages/`) |
| `src/extract-skills.ts` | tikoci/routeros-skills → skills + skill_references tables (GitHub API fetch, local path, or --from-cache modes) |
| `src/link-commands.ts` | Command ↔ page mapping |
| `src/assess-html.ts` | HTML archive assessment (run once) |
| `src/search.ts` | CLI search tool |
| `src/browse.ts` | Interactive terminal browser — REPL with paging, OSC 8 links, context-scoped navigation |
| `src/query.test.ts` | Bun tests — query planner + DB integration + schema health (in-memory SQLite) |
| `src/classify.test.ts` | Bun tests — 42 table-driven cases covering every detector + overlap cases from DESIGN.md |
| `src/canonicalize.test.ts` | Bun tests — CLI path canonicalization: 61 tests for path forms, subshells, blocks, navigation |
| `src/extract-videos.test.ts` | yt-dlp mock tests + cache function tests (saveCache/importCache/loadKnownBad/findLatestCache) |
| `src/schema-roundtrip.test.ts` | Bun tests — schema importer round-trip: fixture walk/merge, arch diffs, desc parsing, completion, legacy compat |
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
| `matrix/YYYY-MM-DD/matrix.csv` | Product matrix CSV snapshots (manually downloaded from mikrotik.com) |
| `transcripts/known-bad.json` | Manually maintained `{videoId: reason}` skip list for `extract-videos` |
| `transcripts/YYYY-MM-DD/videos.ndjson` | Committed transcript cache — one `VideoCacheEntry` per line. Used by `make extract-videos-from-cache` (CI path). |
| `skills/` | Cache of extracted skill files from tikoci/routeros-skills (metadata.json + per-skill SKILL.md + references). Used by `--from-cache` mode. |
| `CONTRIBUTING.md` | Build, test, development setup, release process |
| `MANUAL.md` | Extended user reference — binary install, HTTP transport, CLI flags, data sources, troubleshooting, DB schema |

## Re-extraction

When a new HTML/PDF export is available:

```sh
# Place new export in box/ and update symlink
# ln -s documents-export-<date> box/latest
make clean
make extract       # runs extract-html, extract-properties, extract-commands, extract-devices, extract-skills, link
make extract-full  # runs extract-html, extract-properties, extract-all-versions, extract-devices, extract-skills, link
```

The Makefile orchestrates the full pipeline. Each script drops and recreates its tables.

### Video transcript refresh (local-only, requires yt-dlp)

`extract-videos` is NOT in the `extract` / `extract-full` chains — it requires `yt-dlp` installed.

```sh
make extract-videos             # full channel fetch (~30–60 min)
make save-videos-cache          # export DB → transcripts/YYYY-MM-DD/videos.ndjson
git add transcripts/ && git commit -m "refresh transcript cache YYYY-MM-DD"
# CI uses: make extract-videos-from-cache  (reads committed NDJSON, no yt-dlp)
```

Non-English videos (~27 known) are stored as metadata-only rows (no transcript). `transcripts/known-bad.json` lists video IDs to skip during yt-dlp runs (non-English, private, broken). Keys starting with `_` are treated as comments and ignored.

## CI Release Workflow

The `release.yml` workflow (`workflow_dispatch`) builds the database from a remote HTML export URL and creates a GitHub Release — same pipeline as local, but traceable to a specific commit and CI log.

**Inputs:** `html_url` (required — direct download URL to `.zip`, pre-populated with the current known MikroTik export link), `version` (optional override — defaults to `v` + `package.json` version), `docs_date` (optional — export date for traceability), `full_versions` (default: true — all 46 RouterOS versions), `force` (default: false — overwrite existing release).

**Steps:** download + validate zip → extract HTML → run full extraction pipeline → quality gate (typecheck + test + lint) → build release artifacts + OCI image tars → publish OCI images to Docker Hub/GHCR → smoke-test pulled `sha-*` images on `/mcp` → create GitHub Release with DB stats in release notes.

For Seafile links (box.mikrotik.com), append `&dl=1` for direct download. Product matrix CSV uses the committed copy in `matrix/`.

## Source Details

### HTML Archive (Primary)

- **Export:** Confluence space export, March 2026
- **Format:** 317 HTML files + attachments in `box/latest/ROS/` (symlink → `box/documents-export-2026-3-25`)
- **Structure:** Consistent Confluence classes (`confluenceTable`, `confluenceTh`, `syntaxhighlighter-pre`)
- **Property tables:** 605 tables with "Property | Description" headers across 147 pages
- **Code blocks:** `data-syntaxhighlighter-params="brush: ros"` for RouterOS CLI

### Command Tree (inspect.json / deep-inspect.json)

- **Source:** `inspect.json` and `deep-inspect.{x86,arm64}.json` files from [tikoci/restraml](https://github.com/tikoci/restraml) — 46 versions extracted
- **Access path:** version discovery via GitHub API (1 call to `api.github.com/repos/tikoci/restraml/contents/docs`), files fetched from GitHub Pages (`https://tikoci.github.io/restraml/<version>/extra/...`) — no rate limit on the actual data. Optional local path override for offline extraction. Deep-inspect files preferred when available; falls back to inspect.json for older versions.
- **Generation:** GitHub Actions run RouterOS CHR under QEMU, daily version checks. Two builds per version: base (`routeros.npk` only) and extra (all extra-packages available on CHR). We use the `extra/` variant.
- **Content:** Full RouterOS API from `/console/inspect` — 551 dirs, 5114 cmds, 34K args (primary: 7.22). Deep-inspect adds `_completion` data (11K+ args with valid values and style hints) and per-arch coverage (x86/arm64).
- **Versions:** 7.9 through 7.23beta2 (stable + development channels). New versions appear weekly; the latest stable is auto-detected as primary.
- **Primary version:** latest stable from inspect.json (currently 7.22.1) — used for the `commands` table and linking. Note: this is newer than the HTML docs export (pinned to 7.22) since HTML exports are manual/monthly while inspect.json versions are automated/daily.
- **Version tracking:** 1.67M entries in `command_versions` junction table; `schema_node_presence` mirrors this with FK to `schema_nodes`
- **Multi-arch:** deep-inspect files carry separate x86 and arm64 trees. ~97% of paths are shared; ~1.3K arm64-only (wifi-qcom, ethernet/switch), ~36 x86-only (system/check-disk, console/screen). Arch differences tracked via `schema_nodes._arch` (NULL=both, value=platform-specific).
- **Coverage gap:** CHR doesn't have Wi-Fi hardware, so wireless driver packages (`wifi-qcom`, etc.) are missing from inspect.json. Some packages like `zerotier` are also absent. The HTML docs cover these — deep-inspect arm64 files include wifi-qcom paths that inspect.json lacks.

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

### Agent Skills (tikoci/routeros-skills)

- **Source:** [tikoci/routeros-skills](https://github.com/tikoci/routeros-skills) — community-created, human-reviewed agent guides
- **Content:** 8 skills (~87KB SKILL.md files + ~135KB reference documents, ~30K words total)
- **Skills:** routeros-fundamentals, routeros-container, routeros-app-yaml, routeros-command-tree, routeros-qemu-chr, routeros-netinstall, routeros-mndp, routeros-sniffer
- **Format:** YAML frontmatter (name, description) + markdown body. Reference files in `references/` subdirectories
- **Attribution boundary:** NOT official MikroTik documentation. Every response includes a provenance header. AI-generated, human-reviewed, may contain errors
- **Extraction:** `bun run src/extract-skills.ts` (GitHub API fetch). Supports `--local <path>` for dev and `--from-cache` for offline. CI uses GitHub API fetch directly
- **Cache:** `skills/` directory stores fetched files + `metadata.json` with source SHA

## Related Projects

See `DESIGN.md` for full cross-references, restraml GitHub Pages tools, and rationale.

- **[tikoci/restraml](https://github.com/tikoci/restraml)** — source of `inspect.json` command tree data. Also publishes [interactive lookup/diff tools](https://tikoci.github.io/restraml/) and raw JSON on GitHub Pages.
- **[tikoci/routeros-skills](https://github.com/tikoci/routeros-skills)** — source of agent skill guides. Community-created RouterOS domain knowledge for AI agents, embedded in the rosetta DB via `extract-skills.ts`.
- **[tikoci/lsp-routeros-ts](https://github.com/tikoci/lsp-routeros-ts)** — consumer of property/command data from this DB
- **[tikoci/vscode-tikbook](https://github.com/tikoci/vscode-tikbook)** — RouterOS script notebook for VSCode. Potential consumer for Copilot-assisted scripting.
- **[tikoci/netinstall](https://github.com/tikoci/netinstall)** — RouterOS REST API gotchas (HTTP verb mapping, property name differences)
