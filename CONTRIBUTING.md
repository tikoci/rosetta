# Contributing to Rosetta

Development guide for building, testing, and releasing.

## Prerequisites

- [Bun](https://bun.sh/) v1.1+
- RouterOS HTML documentation export (Confluence space export) — placed in `box/`
- Internet access to [tikoci/restraml GitHub Pages](https://tikoci.github.io/restraml/) for command-tree extraction

### Optional system dependencies

- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** — required only for `make extract-videos` (YouTube transcript extraction). Install with:
  ```sh
  brew install yt-dlp          # macOS
  apt install yt-dlp           # Debian/Ubuntu
  pip install -U yt-dlp        # any platform (pip)
  ```

## Build

```sh
git clone https://github.com/tikoci/rosetta.git
cd rosetta
bun install
```

Place the Confluence HTML export in `box/documents-export-<date>/ROS/` and symlink `box/latest` to it:

```sh
ln -s documents-export-<date> box/latest
```

Then:

```sh
make extract       # HTML → properties → commands (single version) → link
# or
make extract-full  # Same but with all 46 RouterOS versions
```

`make extract` and `make extract-full` fetch `inspect.json` from restraml GitHub Pages by default. You can also pass a local source:

```sh
bun run src/extract-commands.ts /path/to/restraml/docs/7.22.1/extra/inspect.json
bun run src/extract-all-versions.ts /path/to/restraml/docs
```

## Development

```sh
bun test             # Run tests (in-memory SQLite, no DB needed)
bun run typecheck    # Type check
make lint            # Biome linter
make preflight       # All checks: clean tree, DB, typecheck, test, lint
bun run src/mcp.ts   # Start MCP server in dev mode
```

The repo includes `.vscode/mcp.json` — opening the folder in VS Code automatically configures Copilot to use the dev server.

### Interactive browsing

The `browse` command provides a keyboard-driven REPL for exploring all extracted data without needing an MCP client:

```sh
bun run src/mcp.ts browse                    # Interactive REPL
bun run src/mcp.ts browse "firewall filter"  # Open with initial search
bun run src/mcp.ts browse --once "dhcp"      # One-shot search (for piping)
make browse                                  # Makefile shortcut
make browse query="firewall filter"          # With initial query
```

Type `help` in the REPL for all commands. Bare text searches pages; results are numbered for selection. Navigation keys: `b` (back), `q` (quit). Supports paged output, OSC 8 clickable URLs, and context-scoped commands (e.g., `p` after viewing a page lists its properties).

### Testing MCP tools interactively

Three ways to exercise MCP tools during development:

1. **Browse REPL** — `bun run src/mcp.ts browse` (no MCP client needed, uses query.ts directly)
2. **MCP Inspector** — `npx @modelcontextprotocol/inspector bun src/mcp.ts` (web UI for calling individual tools)
3. **CLI search** — `bun run src/search.ts "query"` (quick one-shot FTS search)

## Testing

**Hard rule: any behavioral change must have a corresponding test before shipping.**

| Test file | What it covers |
|-----------|---------------|
| `src/query.test.ts` | Query planner (pure functions), DB integration (in-memory SQLite), schema health |
| `src/release.test.ts` | File consistency, build constants, structural pattern checks, container setup |
| `src/mcp-http.test.ts` | HTTP transport: session lifecycle, multi-client, errors (live server) |

Run `bun test` and `make lint` before any commit.

## Creating a Release

The Makefile handles the full release flow — preflight checks, cross-compile, git tag, push, and GitHub Release upload:

```sh
make release VERSION=v0.1.0          # New release
make release VERSION=v0.1.0 FORCE=1  # Update existing release
```

This cross-compiles to macOS (arm64 + x64), Windows (x64), and Linux (x64), creates ZIP archives, compresses the database, tags the commit, and creates a GitHub Release with all artifacts.

Release CI also publishes OCI images to Docker Hub (`ammo74/rosetta`) and GHCR (`ghcr.io/tikoci/rosetta`) using crane (no Docker daemon required in CI).

### Release Commands

```sh
make build-release VERSION=v0.1.0   # Build artifacts only (no git, no upload)
make release VERSION=v0.1.0         # Full flow: preflight → build → tag → push → create release
make release VERSION=v0.1.0 FORCE=1 # Update existing: force-move tag → upload --clobber
```

## Project Structure

```text
src/
├── mcp.ts                  # MCP server (13 tools, stdio + HTTP) + CLI dispatch
├── setup.ts                # --setup: DB download + MCP client config
├── browse.ts               # Interactive terminal browser (REPL)
├── query.ts                # NL → FTS5 query planner, BM25 ranking
├── db.ts                   # SQLite schema, WAL mode, FTS5 triggers
├── extract-html.ts         # Confluence HTML → pages + callouts
├── extract-properties.ts   # Property table extraction
├── extract-commands.ts     # inspect.json → commands (version-aware)
├── extract-all-versions.ts # Batch extract all 46 versions
├── extract-devices.ts      # Product matrix CSV → devices table
├── extract-test-results.ts # Product page test results + block diagrams
├── extract-changelogs.ts   # Changelog entries from MikroTik download server
├── extract-videos.ts       # MikroTik YouTube channel transcripts → videos + video_segments (incremental, requires yt-dlp)
├── link-commands.ts        # Command ↔ page mapping
├── query.test.ts           # Tests — query planner + DB integration + schema
├── extract-videos.test.ts  # Tests — yt-dlp mock tests + cache function tests
├── release.test.ts         # Tests — file consistency, build constants, container
├── mcp-http.test.ts        # Tests — HTTP transport integration
└── search.ts               # CLI search tool

scripts/
├── build-release.ts        # Cross-compile + package releases
└── container-entrypoint.sh # OCI image runtime entrypoint (HTTP default)
```

## Extraction Pipeline

Each extractor is idempotent — it `DELETE`s existing data and rebuilds. Individual steps:

```sh
make extract-html          # HTML → pages + callouts + sections
make extract-properties    # Property tables from HTML
make extract-commands      # inspect.json → commands (single version)
make extract-all-versions  # All 46 RouterOS versions
make extract-devices       # Product matrix CSV → devices
make extract-test-results  # Product page benchmarks + block diagrams
make extract-changelogs    # Changelog entries from download server
make link                  # Command ↔ page matching
```

## Data Sources

The database combines multiple sources of MikroTik data:

- **HTML Documentation** — Confluence space export from help.mikrotik.com. Pages are broken into sections, callout boxes, and property tables (~515K words).

- **Command Tree** — `inspect.json` from [tikoci/restraml](https://github.com/tikoci/restraml), which runs `/console/inspect` against RouterOS CHR under QEMU for every version since 7.9 (46 versions tracked).

- **Product Matrix** — CSV export from mikrotik.com/products/matrix (144 products, 34 columns).

- **Test Results** — Ethernet and IPSec throughput benchmarks scraped from mikrotik.com product pages.

- **Changelogs** — Parsed per-entry from MikroTik download server.

- **YouTube Transcripts** — Auto-generated English transcripts from the official MikroTik YouTube channel (518 videos, ~1,890 transcript segments). Extracted via `yt-dlp`, cached as NDJSON in `transcripts/` for reproducible CI builds. See `make extract-videos` / `make extract-videos-from-cache`.

Documentation covers RouterOS **v7 only** and aligns with the long-term release (~7.22) at export time.
