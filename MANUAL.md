# Rosetta User Manual

Extended reference for install options, configuration, release/re-extraction operations, and database details beyond the [README](README.md). For rationale, source provenance, and cross-project tradeoffs, see [DESIGN.md](DESIGN.md).

## Install from Binary

Download a compiled binary from [Releases](https://github.com/tikoci/rosetta/releases) — no Bun, Node.js, or other runtime needed.

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `rosetta-macos-arm64.zip` |
| macOS (Intel) | `rosetta-macos-x64.zip` |
| Windows | `rosetta-windows-x64.zip` |
| Linux | `rosetta-linux-x64.zip` |

```sh
./rosetta --setup    # downloads DB + prints MCP client config
```

> **macOS Gatekeeper:** `xattr -d com.apple.quarantine ./rosetta` or System Settings → Privacy & Security → Allow Anyway.
> **Windows SmartScreen:** Click **More info → Run anyway**.

## CLI Flags

| Flag | Purpose |
|------|---------|
| `browse` | Interactive terminal browser (REPL) |
| `browse <cmd> [args]` | Run any TUI command once, then open REPL (e.g. `browse changelog 7.20..7.22`) |
| `browse --once <cmd>` | Execute any TUI command and exit — no REPL (for piping) |
| `--setup` | Download DB + print MCP config |
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

## HTTP Transport

The [MikroTik /app install](README.md#install-on-mikrotik-app) is the easiest way to get an HTTP endpoint. For other setups, rosetta supports the [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) via `--http`:

```sh
rosetta --http                    # http://localhost:8080/mcp
rosetta --http --port 9090        # custom port
rosetta --http --host 0.0.0.0    # accessible from LAN
```

Then point your MCP client at the URL:

```json
{ "url": "http://localhost:8080/mcp" }
```

- **Read-only** — queries a local SQLite database, stores nothing.
- **No authentication** — designed for local/trusted-network use. Use a reverse proxy for public exposure.
- **TLS built-in** — `--tls-cert cert.pem --tls-key key.pem` for direct HTTPS without a proxy.
- **Defaults to localhost** — LAN binding (`--host 0.0.0.0`) requires an explicit flag.

HTTP/TLS env vars: `PORT`, `HOST` (lower precedence than CLI flags), `TLS_CERT_PATH`, `TLS_KEY_PATH` (lower precedence than `--tls-cert`/`--tls-key`).

## Container Images

Multi-arch OCI images (linux/amd64 + linux/arm64) are published with each release:

- `ghcr.io/tikoci/rosetta` (GitHub Container Registry)
- `ammo74/rosetta` (Docker Hub)

```sh
docker run --rm -p 8080:8080 ghcr.io/tikoci/rosetta:latest
```

These are the same images used by the [MikroTik /app install](README.md#install-on-mikrotik-app). Tags: `latest`, version (e.g., `v0.2.1`), and `sha-<commit>`.

## MCP Resources

If your MCP client supports resources, rosetta exposes datasets and supplemental content:

| Resource | Purpose |
|----------|---------|
| `rosetta://datasets/device-test-results.csv` | Full joined benchmark dataset as CSV |
| `rosetta://datasets/devices.csv` | Full device catalog with normalized fields and URLs |
| `rosetta://schema.sql` | Live SQLite DDL from `sqlite_master` |
| `rosetta://schema-guide.md` | Schema relationships, FTS5 query guidance, and join gotchas |
| `rosetta://skills` | Listing of all agent skill guides with names and descriptions |
| `rosetta://skills/{name}` | Full skill guide content with provenance header (community content) |

In VS Code Copilot, attach them via **Add Context > MCP Resources** or **MCP: Browse Resources**. Use tools for normal search and drill-down; use resources when you explicitly want the whole dataset as CSV or agent skill guides.

**Agent Skills** are community-created, human-reviewed guides from [tikoci/routeros-skills](https://github.com/tikoci/routeros-skills) — practical RouterOS domain knowledge written specifically for AI agents. Every skill response includes a provenance header noting that content is NOT official MikroTik documentation and may contain errors. Agents should verify claims using rosetta's official doc tools (`routeros_search`, `routeros_get_page`).

## Data Sources

The database combines multiple MikroTik data sources into a single SQLite file with [FTS5](https://www.sqlite.org/fts5.html) full-text search, [porter stemming](https://www.sqlite.org/fts5.html#porter_tokenizer), and [BM25 ranking](https://www.sqlite.org/fts5.html#the_bm25_function):

- **Docusaurus Documentation** — `/docs` prose from MikroTik's current manual at <https://manual.mikrotik.com>, discovered via `sitemap.xml` and fetched as raw Markdown (`{page}.md` / `{category}/index.md`). Populates `pages`, `sections`, `properties`, and `callouts` the same way the legacy Confluence extractor did, plus a `rosetta_id` identity column (see [DESIGN.md](DESIGN.md#docusaurus-manual-current-primary-prose-corpus)). CLI Reference (`/docs/cli-reference/*`) and the standalone `/hardware` section are out of scope for this extractor — see B-0012's proposed follow-up tasks.

- **Legacy HTML Documentation** — Confluence space export from help.mikrotik.com (March 2026, frozen). 317 pages broken into sections, callouts, and property tables (~515K words). Kept only for rebuilding historical pre-migration release DBs — see "Re-extracting a Local Database" below.

- **Command Tree** — `inspect.json` / `deep-inspect.json` from [tikoci/restraml](https://github.com/tikoci/restraml), generated by running `/console/inspect` against RouterOS CHR under QEMU for every version since 7.9 (46 versions tracked: 7.9–7.23beta2). `command_versions` keeps full version history; `schema_node_presence` is release-pruned to active channel heads (stable, long-term, testing, development) to bound DB growth.

- **Product Matrix** — CSV export from mikrotik.com/products/matrix (156 products, 34 columns). Hardware specs, license levels, and pricing.

- **Device Benchmarks** — Ethernet bridging/routing and IPSec throughput test results scraped from individual product pages on mikrotik.com (2,874 measurements across 125 devices; 64/512/1518-byte packets, multiple configurations). Also captures block diagram image URLs for 110 devices.

- **YouTube Transcripts** — Auto-generated English transcripts from the official [MikroTik YouTube channel](https://www.youtube.com/@MikroTik/videos) (538 videos, ~1,870 non-empty transcript segments). Split by chapter when available, with timestamps for deep linking. Extracted via yt-dlp, cached as NDJSON in the repo for reproducible CI builds.

- **Archived Dude Wiki** — Wayback Machine snapshots cached in `dude/pages/`, exposed through separate Dude tools because the retired GUI docs are not part of current RouterOS v7 help.

- **Agent Skills** — Community-created agent guides from [tikoci/routeros-skills](https://github.com/tikoci/routeros-skills) (8 skills, ~30K words). NOT official MikroTik documentation — AI-generated, human-reviewed, served with provenance attribution. Practical domain knowledge for topics like containers, QEMU CHR, netinstall, and RouterOS fundamentals.

Documentation covers RouterOS **v7 only**. v6 had different syntax and major subsystems — answers for v6 are unreliable. Prose is now sourced live from <https://manual.mikrotik.com>, which also has a CLI Reference with `/console/inspect`-derived command menus and argument types (not yet ingested — see B-0012's proposed follow-up tasks).

## Re-extracting a Local Database

`make extract` and `make extract-full` fetch `/docs` prose live from manual.mikrotik.com and rebuild the versioned command tree, devices, changelogs, Dude cache, and skills:

```sh
make clean
make extract
make extract-full
make gc-versions EXTRA_FLAGS=--verbose
```

- `make extract` runs the single-version ETL chain: Docusaurus `/docs` prose → commands → devices → test results → changelogs → Dude cache → skills → link.
- `make extract-full` keeps the same pipeline but uses all tracked RouterOS versions for command/schema extraction.
- `make gc-versions` is the release-retention step that prunes `schema_node_presence` down to active channel heads; local full extracts intentionally keep the full presence history until you run it.
- `make extract-docusaurus` runs the Docusaurus step alone, live-fetching every in-scope `/docs` page and caching each page's raw Markdown to `manual/pages/` (gitignored — not committed). `make extract-docusaurus-from-cache` re-runs from that cache with no network dependency, for fast local iteration. `make extract-docusaurus-check-counts` compares the extracted page count against `llms.txt`'s scoped entry count (B-0012 H8, `V-docusaurus-docs-count`) — non-blocking, prints MATCH/MISMATCH.

### Rebuilding a historical (pre-migration) Confluence release DB

The Confluence export is frozen (last shipped March 2026) and no longer the default pipeline, but the extractor is kept for rebuilding historical release DBs:

```sh
# Place the Confluence export in box/ and update the box/latest symlink.
make extract-legacy-confluence   # runs extract-html + extract-properties only
```

`extract-legacy-confluence` populates the same `pages`/`sections`/`properties`/`callouts` tables as `extract-docusaurus` — the two are not meant to run against the same DB in sequence; pick one prose source per build. See [DESIGN.md](DESIGN.md#docusaurus-manual-current-primary-prose-corpus) and [B-0012](briefings/B-0012-docusaurus-manual-migration.md) for the migration history and rationale.

### Video transcript refresh

`extract-videos` is intentionally outside the default extract chain because it requires `yt-dlp` and can take 30–60 minutes:

```sh
make extract-videos
make save-videos-cache
git add transcripts/
git commit -m "refresh transcript cache YYYY-MM-DD"
```

Release CI consumes committed NDJSON via `make extract-videos-from-cache`; it does not run a live YouTube scrape.

### Local-only source refreshes

Before cutting a corpus release, check these inputs separately from CI:

| Source | CI behavior | Local action when freshness matters |
| --- | --- | --- |
| YouTube transcripts | Imports the latest committed `transcripts/YYYY-MM-DD/videos.ndjson` cache. | Run `make extract-videos` for the live scrape, then `make save-videos-cache` (or `bun run src/extract-videos.ts --save-cache`) to write the committed cache. |
| Product matrix | Parses the committed matrix CSV path used by `src/extract-devices.ts`. | Export **All** from <https://mikrotik.com/products/matrix>, save `matrix/YYYY-MM-DD/matrix.csv`, and update the extractor default if the release should consume it. |
| Dude wiki | Imports committed `dude/pages/` HTML with `--skip-images`. | Rerun `make extract-dude` only when intentionally curating archived Wayback snapshots. It is not a routine current-source refresh. |
| Changelog patch probing | Runs the normal live changelog extractor. | `make extract-changelogs-extended` is exploratory unless the release workflow is changed to use it. |
| RouterOS versions, product tests, skills | Fetched live in release CI. | No local cache refresh is required for normal release prep. |

## Release Workflow

Published artifacts come from the GitHub Actions `Release` workflow (`workflow_dispatch`), not from local ad hoc release commands.

- **Inputs:** `version` (optional override), `docs_date`, `full_versions`, and `republish_assets`.
- **`republish_assets`:** reuploads GitHub Release assets and OCI tags for an existing version. It does **not** republish npm because npm versions are immutable.
- **Traceable pipeline:** early quality gate → live Docusaurus extraction (`extract-docusaurus.ts --check-counts --strict`, proving `V-docusaurus-docs-count` on every run) → extraction chain → transcript/Dude cache imports → skill extraction → command linking → `schema_node_presence` GC → DB-wipe guard → contract/eval steps → `db_meta` stamping → minimum-content validation → build/publish release assets and OCI images.
- **Provenance:** release notes include DB stats, and the stamped `db_meta` keys (`release_tag`, `built_at`, `source_commit`, `schema_version`) let runtime surfaces report exactly what shipped.

The legacy Confluence pipeline (`extract-html.ts`/`extract-properties.ts`, `html_url` input) has been retired from `release.yml` (T-0036) — it survives only as the local-only `make extract-legacy-confluence` target for rebuilding historical pre-migration DBs; see "Rebuilding a historical (pre-migration) Confluence release DB" above.

## Database (Standalone)

The SQLite database is downloadable on its own from [GitHub Releases](https://github.com/tikoci/rosetta/releases):

```text
https://github.com/tikoci/rosetta/releases/latest/download/ros-help.db.gz
```

Each tagged release also publishes the same asset under its own version, so you can pin a specific snapshot:

```text
https://github.com/tikoci/rosetta/releases/download/v0.7.3/ros-help.db.gz
```

The version-pinned URL is what `bunx @tikoci/rosetta` uses internally — see [How Updates Work](#how-updates-work) below.

Use it with any SQLite client:

```sh
sqlite3 ros-help.db "SELECT title, url FROM pages_fts WHERE pages_fts MATCH 'DHCP lease' ORDER BY rank LIMIT 5;"
```

### Tables

| Table | Rows | What's in it |
|-------|------|-------------|
| `pages` | 317 | Legacy documentation pages — title, breadcrumb path, full text, code blocks, help.mikrotik.com URL |
| `sections` | 2,984 | Page chunks split by h1–h3 headings, with anchor IDs for deep linking |
| `callouts` | 1,034 | Warning/Note/Info/Tip boxes extracted from Confluence callout macros |
| `properties` | 4,860 | Command properties — name, type, default value, description (from doc tables) |
| `commands` | 40K+ | RouterOS command hierarchy — dirs, commands, arguments from `/console/inspect` |
| `command_versions` | 1.67M | Junction table: which command paths exist in which RouterOS versions (7.9–7.23beta2) |
| `schema_nodes` | 40K+ | Rich command-tree nodes from `deep-inspect.json` — arch tags, parsed descriptions, completion metadata |
| `schema_node_presence` | active heads only | Junction table: which `schema_nodes` exist in active channel-head versions; pruned during release builds |
| `ros_versions` | 46 | Tracked RouterOS versions with channel (stable/development) |
| `devices` | 156 | MikroTik hardware — CPU, RAM, storage, ports, PoE, wireless, license level, MSRP |
| `device_test_results` | 2,874 | Ethernet and IPSec throughput benchmarks for 125 devices — packet sizes, modes, Mbps/Kpps |
| `changelogs` | varies | Parsed changelog entries per RouterOS version — category, description, breaking flag |
| `videos` | 538 | MikroTik YouTube video metadata — title, description, duration, chapters |
| `video_segments` | ~1,870 non-empty | Chapter-level transcript segments with timestamps for deep linking |
| `dude_pages` | varies | Archived Dude wiki pages from Wayback/cache |
| `dude_images` | varies | Screenshot metadata for Dude wiki pages |
| `skills` | 8 | Agent skill guides from tikoci/routeros-skills with provenance |
| `skill_references` | varies | Reference documents bundled with skills |
| `glossary` | varies | RouterOS terms, aliases, definitions, and search hints |
| `db_meta` | varies | Release provenance and schema/update metadata |

Each content table has a corresponding FTS5 index (e.g., `pages_fts`, `properties_fts`, `devices_fts`, `video_segments_fts`).

### Logical schema reference

The live authoritative DDL is available from the `rosetta://schema.sql` MCP resource or `sqlite_master`. This block mirrors the logical table layout and relationship model used throughout the codebase:

```sql
-- Pages (Docusaurus /docs prose since T-0035; legacy Confluence rows had no
-- rosetta_id and used a Confluence-numbered `id` — both shapes coexist in the
-- schema, but a single build populates one or the other, never both)
pages (
    id INTEGER PRIMARY KEY,  -- synthetic rowid for Docusaurus-sourced rows;
                              -- literal Confluence page ID for legacy rows
    rosetta_id,               -- TEXT, unique-when-not-null. URL-path-derived
                              -- (e.g. 'docs/network-management/dhcp'); NULL on
                              -- legacy Confluence rows. See DESIGN.md H7 / B-0012.
    slug, title, path,       -- path = 'docs > network-management > dhcp'
    depth, parent_id,
    url,                     -- https://manual.mikrotik.com/{rosetta_id}
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
    _arch TEXT,               -- NULL=both arches, 'x86'/'arm64'=platform-specific
    _package TEXT,            -- future: package that provides this node
    _attrs TEXT,              -- JSON catch-all (completion data, future metadata)
    page_id INTEGER REFERENCES pages(id),
    UNIQUE(path, type)
)

-- schema_nodes version presence (flat junction — no arch column, arch is on schema_nodes)
schema_node_presence (
    node_id INTEGER NOT NULL REFERENCES schema_nodes(id),
    version TEXT NOT NULL,
    PRIMARY KEY (node_id, version)
)
-- Release DBs prune schema_node_presence to active channel heads
-- (stable, long-term, testing, development); command_versions keeps
-- the full extracted version history.

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
    description TEXT,                -- from YAML frontmatter
    content TEXT NOT NULL,           -- full SKILL.md markdown (frontmatter stripped)
    source_repo TEXT NOT NULL DEFAULT 'tikoci/routeros-skills',
    source_sha TEXT,                 -- git commit SHA at extraction time
    source_url TEXT,                 -- GitHub URL to SKILL.md
    word_count INTEGER,
    extracted_at TEXT                -- ISO 8601
)

-- Reference docs for each skill
skill_references (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id INTEGER NOT NULL REFERENCES skills(id),
    path TEXT NOT NULL,              -- 'references/rest-api-patterns.md'
    filename TEXT NOT NULL,          -- 'rest-api-patterns.md'
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

## How Updates Work

Once configured as an MCP server, rosetta should keep itself up to date without manual intervention. Here's the model:

1. **Package updates (`bunx`).** `bunx @tikoci/rosetta` re-resolves the npm `latest` dist-tag on each MCP-client launch and downloads the new package version automatically. No manual cache cleanup is needed in normal operation. If you see consistently stale behavior, run `bunx @tikoci/rosetta@latest --refresh` once and relaunch your MCP client.

2. **Database updates (auto on first launch after a package update).** The DB download URL is **pinned to the running package version** — `releases/download/v<VERSION>/ros-help.db.gz` — with `releases/latest/` as a fallback. When a new package version arrives that ships a new schema, the auto-download fetches the matching DB on first launch.

3. **Atomic, validated download.** Downloads go to `<dbPath>.tmp.<pid>` first. The file is checked for SQLite magic bytes, minimum size (~50 MB), expected `PRAGMA user_version`, and minimum row counts before being atomically renamed into place. Stale `.tmp.*`, `.db-wal`, and `.db-shm` artifacts are removed automatically when no active rosetta download lock exists. A Ctrl+C, network failure, or schema mismatch will not corrupt your installed DB — the existing one is left untouched and an error is printed.

4. **Provenance.** Every released DB carries a `db_meta` table (`release_tag`, `built_at`, `source_commit`, `schema_version`). Rosetta logs a one-line provenance banner at startup: `rosetta v0.7.3 ready (DB schema v5, 317 pages, release v0.7.3).`

5. **Schema mismatch is a hard error, not a warning.** If a download still doesn't match the expected schema after the auto-recovery attempt, the server exits with an actionable message instead of silently booting on incompatible data. The fix is `bunx @tikoci/rosetta@latest --refresh`, which refreshes both the package resolution and the DB.

6. **Manual refresh.** `bunx @tikoci/rosetta@latest --refresh` triggers a fresh download + validation with no other side effects (no MCP-config printing). Use it after a known DB-only release or to recover from a previously failed download.

7. **`~/.rosetta/` is the canonical DB location** for `bunx` / global installs. Compiled binaries store the DB next to the executable; dev checkouts use `<repo>/ros-help.db`.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| **First launch is slow** | One-time database download (~50 MB). Subsequent starts are instant. |
| **`npx @tikoci/rosetta` fails** | This package requires Bun, not Node.js. Use `bunx` instead of `npx`. |
| **`npm install -g` then `rosetta` fails** | Global npm install works if Bun is on PATH — it delegates to `bun` at runtime. But prefer `bunx` — it's simpler and auto-updates. |
| **ChatGPT Apps can't connect** | ChatGPT Apps require a remote HTTPS MCP endpoint. Use the [MikroTik /app install](README.md#install-on-mikrotik-app) for a hosted endpoint, or Codex CLI for local stdio. |
| **Claude Desktop can't find `bunx`** | Claude Desktop on macOS may not inherit shell PATH. Use the full path to bunx (run `which bunx` to find it, typically `~/.bun/bin/bunx`). `bunx @tikoci/rosetta --setup` prints the full-path config. |
| **macOS Gatekeeper blocks binary** | Use `bunx` install (no Gatekeeper issues), or: `xattr -d com.apple.quarantine ./rosetta` |
| **Windows SmartScreen warning** | Use `bunx` install (no SmartScreen issues), or click **More info → Run anyway** |
| **How to update** | `bunx` always uses the latest published version. The DB is version-pinned to the package and auto-downloads on first launch after a package update — see [How Updates Work](#how-updates-work). For binaries, re-download from [Releases](https://github.com/tikoci/rosetta/releases/latest). MikroTik /app with `auto-update: true` pulls the latest image on each boot. |
| **`bunx` is using a stale package** | Run `bunx @tikoci/rosetta@latest --refresh`, then relaunch your MCP client. |
| **"DB schema mismatch" or "Still incompatible after re-download"** | Your cached `bunx` package is older than the published DB. Run `bunx @tikoci/rosetta@latest --refresh`. |
