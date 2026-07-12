# Contributing to Rosetta

Development guide for building, testing, and releasing.

## Prerequisites

- [Bun](https://bun.sh/) v1.1+
- RouterOS legacy HTML documentation export (Confluence space export) — placed in `box/`
- For future documentation refreshes, MikroTik's official manual is now Docusaurus at <https://manual.mikrotik.com>; see `DESIGN.md` and `briefings/B-0012-docusaurus-manual-migration.md` before changing extraction, MCP, or TUI behavior.
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

Place the legacy Confluence HTML export in `box/documents-export-<date>/ROS/` and symlink `box/latest` to it:

```sh
ln -s documents-export-<date> box/latest
```

Then:

```sh
make extract       # HTML → properties → commands → devices → tests → changelogs → Dude cache → skills → link
# or
make extract-full  # Same, but command data uses all 46 RouterOS versions
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
bun run lint         # Biome linter
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
| `src/classify.test.ts` | Classifier detectors for command paths, versions, topics, devices, properties |
| `src/canonicalize.test.ts`, `src/canonicalize.fuzz.test.ts` | RouterOS CLI canonicalizer behavior and issue #5 hardening anchors |
| `src/mcp-contract.test.ts` | Frozen tool registry, workflow-arrow convention, token budgets, response-shape invariants |
| `src/mcp-http.test.ts` | HTTP transport: session lifecycle, multi-client, errors (live server) |
| `src/release.test.ts` | File consistency, build constants, structural pattern checks, container setup |
| `src/schema-roundtrip.test.ts`, `src/extract-*.test.ts`, `src/gc-versions.test.ts` | Extraction/schema/retention behavior and importer isolation |

Run `bun test` and `bun run lint` before any commit.

## Work tracking

Active work is tracked in [GitHub Issues](https://github.com/tikoci/rosetta/issues).
An issue starts as discussion; the `agent-ready` label means acceptance criteria are
settled and it can be picked up now. `umbrella` marks a theme-tracking issue (work
happens in its child issues); `blocked` marks issues waiting on a named event.

Two PR rules (details in `.github/instructions/issue-pr-linking.instructions.md`):

1. A PR that implements an issue says `Closes #N` in its **body**, so merging closes
   the issue automatically.
2. If a PR delivers only part of an issue, open follow-up issues for the remainder
   *before* merging and reference them from the PR.

Research and decision notes live in `briefings/B-*.md`; loose ideas and wait-on-event
triggers in `BACKLOG.md`. The old file-based queue under `tasks/` is a frozen archive
(see `tasks/README.md`).

Build tooling note: `package.json` scripts cover the JS/TS lifecycle (`bun run` /
`bun test`); the `Makefile` exists for ETL orchestration and multi-step checks
(`make verify`). That split is deliberate — don't fold one into the other.

## Changelog discipline

Any change with a user-visible effect (CLI flag, MCP tool shape, DB schema,
CI behaviour, install/update flow, documented invariant) gets a one-line
bullet under `CHANGELOG.md` → `[Unreleased]` → one of
`Added` / `Changed` / `Fixed` / `Removed` / `Deprecated` / `Security`, in the
same commit.

Don't list every internal commit — one bullet per behaviour change.
Pure refactors, test churn, and CI auto-bumps with no external effect are
omitted (git history is authoritative). Details and rationale go in
`DESIGN.md`; future work goes in `BACKLOG.md`.

Version bumps and CHANGELOG promotion are **manual** (the old `bump-version`
CI auto-promotion was removed by T-0037): before a latest-channel release, a
human edits `package.json` and promotes `[Unreleased]` to `[VERSION] — DATE`
by hand; a release-workflow preflight gate fails the run if the heading is
missing. Agents and developers only ever write to the current `[Unreleased]`
section. Prerelease (alpha/beta/rc) runs don't promote `[Unreleased]` at all.

## Creating a Release

The preferred published release path is the GitHub Actions `Release`
workflow (`workflow_dispatch`), because it ties the generated DB, assets, OCI
images, npm publish, and version bump to one CI log. Its `republish_assets`
input reuploads GitHub Release assets and OCI tags for an existing version, but
does **not** re-publish npm; bump `package.json` for a new npm package.

Release CI publishes multi-arch OCI images (linux/amd64 + linux/arm64) to
Docker Hub (`ammo74/rosetta`) and GHCR (`ghcr.io/tikoci/rosetta`) via
`docker buildx build --push` using `Dockerfile.release`. See DESIGN.md
"OCI image build: Dockerfile + docker buildx" for why crane was rejected.

### Release Commands

```sh
make preflight                       # Pre-commit: clean tree + DB + typecheck + lint + test
make verify                          # CI parity: like preflight but no clean-tree, adds contract tests + Phase 0 eval (requires populated DB)
```

## Project Structure

```text
src/
├── mcp.ts                  # MCP server (14 tools, stdio + HTTP) + CLI dispatch
├── setup.ts                # --setup: DB download + MCP client config
├── browse.ts               # Interactive terminal browser (REPL)
├── query.ts                # NL → FTS5 query planner, BM25 ranking
├── db.ts                   # SQLite schema, WAL mode, FTS5 triggers
├── extract-html.ts         # Legacy Confluence HTML → pages + callouts
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
make extract-videos-from-cache # Import committed transcript NDJSON (CI path)
make extract-dude-from-cache   # Import cached Dude wiki HTML
make extract-skills            # Fetch/import tikoci/routeros-skills
make link                  # Command ↔ page matching
make gc-versions           # Release retention: prune schema_node_presence to active channel heads
```

## Data Sources

The database combines multiple sources of MikroTik data:

- **HTML Documentation** — legacy Confluence space export from help.mikrotik.com. Pages are broken into sections, callout boxes, and property tables (~515K words). Future official docs are on <https://manual.mikrotik.com> and require the Docusaurus migration path.

- **Command Tree** — `inspect.json` from [tikoci/restraml](https://github.com/tikoci/restraml), which runs `/console/inspect` against RouterOS CHR under QEMU for every version since 7.9 (46 versions tracked).

- **Product Matrix** — CSV export from mikrotik.com/products/matrix (144 products, 34 columns).

- **Test Results** — Ethernet and IPSec throughput benchmarks scraped from mikrotik.com product pages.

- **Changelogs** — Parsed per-entry from MikroTik download server.

- **YouTube Transcripts** — Auto-generated English transcripts from the official MikroTik YouTube channel (518 videos, ~1,890 transcript segments). Extracted via `yt-dlp`, cached as NDJSON in `transcripts/` for reproducible CI builds. See `make extract-videos` / `make extract-videos-from-cache`.

- **Archived Dude Wiki** — Cached Wayback HTML under `dude/pages/`, imported with `make extract-dude-from-cache` for release builds.

- **Agent Skills** — Community-created guides from [tikoci/routeros-skills](https://github.com/tikoci/routeros-skills), fetched by CI and cached under `skills/` for offline extraction.

Documentation covers RouterOS **v7 only** and aligns with the long-term release (~7.22) at the March 2026 Confluence-export time.
