# rosetta

MCP server for searching [MikroTik RouterOS documentation](https://help.mikrotik.com/docs/spaces/ROS/overview). Gives your AI assistant searchable access to 317 documentation pages, 4,860 property definitions, 40,000-entry command tree, and 144 hardware product specs — with direct links to help.mikrotik.com.

Tested with **Claude Desktop**, **Claude Code**, **VS Code Copilot** (including Copilot CLI), and **VS Code** on macOS and Linux.

## What is SQL-as-RAG?

Most retrieval-augmented generation (RAG) systems use vector embeddings to search documentation. This project takes a different approach: **SQLite [FTS5](https://www.sqlite.org/fts5.html) full-text search as the retrieval layer** — what we call SQL-as-RAG.

For structured technical documentation like RouterOS, full-text search with [BM25 ranking](https://www.sqlite.org/fts5.html#the_bm25_function) beats vector similarity. Technical terms like "dhcp-snooping" or "/ip/firewall/filter" are exact tokens — [porter stemming](https://www.sqlite.org/fts5.html#porter_tokenizer) and proximity matching handle the rest. No embedding pipeline, no vector database, no API keys. Just a single SQLite file that searches in milliseconds.

The data flows: **HTML docs → SQLite extraction → FTS5 indexes → MCP tools → your AI assistant.** The database is built once from MikroTik's official Confluence documentation export, then the MCP server exposes 10 search tools over stdio transport.

## What's Inside

- **317 documentation pages** from MikroTik's official help site (~515K words)
- **4,860 property definitions** with types, defaults, and descriptions
- **5,114 commands** in the RouterOS command hierarchy (551 directories, 34K arguments)
- **1,034 callout blocks** — warnings, notes, and tips with important caveats
- **144 hardware products** — CPU, RAM, storage, ports, PoE, wireless, license level, pricing
- **46 RouterOS versions tracked** (7.9 through 7.23beta2) for command history
- Direct links to help.mikrotik.com for every page and section

## Quick Start

Download a pre-built binary from [Releases](https://github.com/tikoci/rosetta/releases) — no Bun, Node.js, or other tools required.

### 1. Download

Go to the [latest release](https://github.com/tikoci/rosetta/releases/latest) and download the ZIP for your platform:

| Platform | File |
|----------|------|
| macOS (Apple Silicon) | `rosetta-macos-arm64.zip` |
| macOS (Intel) | `rosetta-macos-x64.zip` |
| Windows | `rosetta-windows-x64.zip` |
| Linux | `rosetta-linux-x64.zip` |

Extract the ZIP to a permanent location (e.g., `~/rosetta` or `C:\rosetta`).

### 2. Run Setup

Open a terminal in the extracted folder and run:

```sh
./rosetta --setup
```

On Windows:
```powershell
.\rosetta.exe --setup
```

This downloads the documentation database (~50 MB compressed, ~230 MB on disk) and prints configuration instructions for your MCP client.

> **macOS Gatekeeper:** If macOS blocks the binary, go to **System Settings → Privacy & Security** and click **Allow Anyway**, then run again. Or from Terminal: `xattr -d com.apple.quarantine ./rosetta`
>
> **Windows SmartScreen:** If Windows warns about an unrecognized app, click **More info → Run anyway**.

### 3. Configure Your MCP Client

The `--setup` command prints the exact config for your platform. Here's what it looks like for each client:

#### Claude Desktop

Edit your Claude Desktop config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add (or merge into existing config):

```json
{
  "mcpServers": {
    "rosetta": {
      "command": "/path/to/rosetta"
    }
  }
}
```

Replace `/path/to/rosetta` with the actual path printed by `--setup`. Then **restart Claude Desktop**.

#### Claude Code

```sh
claude mcp add rosetta /path/to/rosetta
```

#### VS Code Copilot

The simplest way: open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`), choose **"MCP: Add Server…"**, select **"Command (stdio)"**, and enter the full path to the `rosetta` binary.

Or add to your User Settings JSON (`Cmd+Shift+P` → "Preferences: Open User Settings (JSON)"):

```json
"mcp": {
  "servers": {
    "rosetta": {
      "command": "/path/to/rosetta"
    }
  }
}
```

### 4. Try It

Ask your AI assistant questions like:

- *"What are the DHCP server properties in RouterOS?"*
- *"How do I set up a bridge VLAN?"*
- *"Is the /container command available in RouterOS 7.12?"*
- *"What are the firewall filter default chains?"*
- *"Show me warnings about hardware offloading"*
- *"Which MikroTik routers have L3HW offload, and more than 8 ports of 48V PoE? Include cost."*

## MCP Tools

The server provides 10 tools, designed to work together:

| Tool | What it does |
|------|-------------|
| `routeros_search` | **Start here.** Full-text search across all pages with BM25 ranking |
| `routeros_get_page` | Retrieve full page content by ID or title. Section-aware for large pages |
| `routeros_lookup_property` | Look up a property by exact name (type, default, description) |
| `routeros_search_properties` | Search across 4,860 property names and descriptions |
| `routeros_command_tree` | Browse the `/ip/firewall/filter` style command hierarchy |
| `routeros_search_callouts` | Search warnings, notes, and tips across all pages |
| `routeros_command_version_check` | Check which RouterOS versions include a command |
| `routeros_device_lookup` | Hardware specs for 144 MikroTik products — filter by architecture, RAM, storage, PoE, wireless, LTE |
| `routeros_stats` | Database health: page/property/command counts, coverage stats |
| `routeros_current_versions` | Fetch current RouterOS versions from MikroTik (live) |

The AI assistant typically starts with `routeros_search`, then drills into specific pages, properties, or the command tree based on what it finds. Each tool's description includes workflow hints (e.g., "→ use `routeros_get_page` to read full content") and empty-result suggestions so the AI knows how to chain tools together — this is where most of the tuning effort goes.

## Alternative: Run with Bun

If you have [Bun](https://bun.sh/) installed and prefer not to use the pre-built binary — for example, to avoid Gatekeeper/SmartScreen warnings, or to inspect the code you're running — you can run the MCP server directly from source. No HTML export or command tree data is needed; the database is downloaded from GitHub Releases just like the binary option.

### 1. Install Bun

```sh
# macOS / Linux
curl -fsSL https://bun.sh/install | bash
# or: brew install oven-sh/bun/bun

# Windows
powershell -c "irm bun.sh/install.ps1 | iex"
```

### 2. Download and Install

```sh
git clone https://github.com/tikoci/rosetta.git
cd rosetta
bun install
```

Or download the source archive from the [latest release](https://github.com/tikoci/rosetta/releases/latest) ("Source code" ZIP or tarball), extract it, and run `bun install`.

### 3. Run Setup

```sh
bun run src/mcp.ts --setup
```

This downloads the documentation database and prints MCP client configuration. The config uses `bun` as the command with `src/mcp.ts` as the entrypoint:

#### Claude Desktop

```json
{
  "mcpServers": {
    "rosetta": {
      "command": "bun",
      "args": ["run", "src/mcp.ts"],
      "cwd": "/path/to/rosetta"
    }
  }
}
```

#### Claude Code

```sh
claude mcp add rosetta -- bun run src/mcp.ts --cwd /path/to/rosetta
```

#### VS Code Copilot

Open the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`), choose **"MCP: Add Server…"**, select **"Command (stdio)"**, and enter `bun run src/mcp.ts` with the working directory set to the rosetta folder.

Or add to your User Settings JSON:

```json
"mcp": {
  "servers": {
    "rosetta": {
      "command": "bun",
      "args": ["run", "src/mcp.ts"],
      "cwd": "/path/to/rosetta"
    }
  }
}
```

Replace `/path/to/rosetta` with the actual path (printed by `--setup`).

## Building from Source

For contributors or when you have access to the MikroTik HTML documentation export.

### Prerequisites

- [Bun](https://bun.sh/) v1.1+
- RouterOS HTML documentation export (Confluence space export)
- Internet access to [tikoci/restraml GitHub Pages](https://tikoci.github.io/restraml/) for command-tree extraction

`make extract` and `make extract-full` fetch `inspect.json` from restraml GitHub Pages by default. You can still pass a local source explicitly:

```sh
bun run src/extract-commands.ts /path/to/restraml/docs/7.22.1/extra/inspect.json
bun run src/extract-all-versions.ts /path/to/restraml/docs
```

### Build

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

### Development

```sh
bun test             # Run tests (in-memory SQLite, no DB needed)
bun run typecheck    # Type check
make lint            # Biome linter
bun run src/mcp.ts   # Start MCP server in dev mode
```

The repo includes `.vscode/mcp.json` — opening the folder in VS Code automatically configures Copilot to use the dev server.

### Creating a Release

The Makefile handles the full release flow — preflight checks, cross-compile, git tag, push, and GitHub Release upload:

```sh
make release VERSION=v0.1.0
```

This cross-compiles to macOS (arm64 + x64), Windows (x64), and Linux (x64), creates ZIP archives, compresses the database, tags the commit, and creates a GitHub Release with all artifacts.

## Project Structure

```text
src/
├── mcp.ts                  # MCP server (10 tools, stdio) + CLI dispatch
├── setup.ts                # --setup: DB download + MCP client config
├── query.ts                # NL → FTS5 query planner, BM25 ranking
├── db.ts                   # SQLite schema, WAL mode, FTS5 triggers
├── extract-html.ts         # Confluence HTML → pages + callouts
├── extract-properties.ts   # Property table extraction
├── extract-commands.ts     # inspect.json → commands (version-aware)
├── extract-all-versions.ts # Batch extract all 46 versions
├── extract-devices.ts      # Product matrix CSV → devices table
├── link-commands.ts        # Command ↔ page mapping
└── query.test.ts           # Tests (in-memory SQLite fixtures)

scripts/
└── build-release.ts        # Cross-compile + package releases
```

## Data Sources

The database combines three sources of MikroTik data into a single SQLite file with full-text search ([FTS5](https://www.sqlite.org/fts5.html) with [porter stemming](https://www.sqlite.org/fts5.html#porter_tokenizer) and [BM25 ranking](https://www.sqlite.org/fts5.html#the_bm25_function)):

- **HTML Documentation** — Confluence space export from help.mikrotik.com (March 2026). The 317 pages are broken out several ways: by section heading, callout boxes (warnings, tips, notes), and property tables (attribute name/type/default/description). This is the richest source — ~515K words of official documentation with direct links back to help.mikrotik.com.

- **Command Tree** — `inspect.json` files from [tikoci/restraml](https://github.com/tikoci/restraml), which runs `/console/inspect` requests (`child`, `syntax`, `completion`) against RouterOS CHR under QEMU via GitHub Actions for every version since 7.9. This gives the MCP server structured knowledge of whether a command or argument exists in a particular version (46 versions tracked: 7.9–7.23beta2). The blind spot: these come from CHR with all extra-packages on x86, so commands from packages not available on CHR (like `zerotier` and Wi-Fi driver packages) are missing — the HTML docs cover those.

- **Product Matrix** — CSV export from mikrotik.com/products/matrix (144 products, 34 columns). Hardware specs, license levels, and pricing — lets the AI answer questions like *"Which routers have L3HW offload and 8+ ports of 48V PoE?"* The CSV requires manual download (the old POST API was removed when the site was redesigned in late 2025).

Documentation covers RouterOS **v7 only** and aligns with the long-term release (~7.22) at export time. v6 had different syntax and major subsystems — answers for v6 are unreliable.

## Database (Standalone)

The SQLite database is distributed separately from the MCP server code via GitHub Releases:

```text
https://github.com/tikoci/rosetta/releases/latest/download/ros-help.db.gz
```

The MCP server downloads this automatically on first run (or via `--setup`), but the database is usable on its own with any SQLite client:

```sh
sqlite3 ros-help.db "SELECT title, url FROM pages_fts WHERE pages_fts MATCH 'DHCP lease' ORDER BY rank LIMIT 5;"
```

### Tables

| Table | Rows | What's in it |
|-------|------|-------------|
| `pages` | 317 | Documentation pages — title, breadcrumb path, full text, code blocks, help.mikrotik.com URL |
| `sections` | 2,984 | Page chunks split by h1–h3 headings, with anchor IDs for deep linking |
| `callouts` | 1,034 | Warning/Note/Info/Tip boxes extracted from Confluence callout macros |
| `properties` | 4,860 | Command properties — name, type, default value, description (from doc tables) |
| `commands` | 40K+ | RouterOS command hierarchy — dirs, commands, arguments from `/console/inspect` |
| `command_versions` | 1.67M | Junction table: which command paths exist in which RouterOS versions (7.9–7.23beta2) |
| `ros_versions` | 46 | Tracked RouterOS versions with channel (stable/development) |
| `devices` | 144 | MikroTik hardware — CPU, RAM, storage, ports, PoE, wireless, license level, MSRP |

Each content table has a corresponding [FTS5](https://www.sqlite.org/fts5.html) index (e.g., `pages_fts`, `properties_fts`, `devices_fts`) using the [porter](https://www.sqlite.org/fts5.html#porter_tokenizer) stemming tokenizer for natural language search with [BM25 ranking](https://www.sqlite.org/fts5.html#the_bm25_function).

## License

MIT
