# rosetta

MCP server for searching [MikroTik RouterOS documentation](https://help.mikrotik.com/docs/spaces/ROS/overview). Gives your AI assistant searchable access to 317 documentation pages, 4,860 property definitions, 40,000-entry command tree, and 144 hardware product specs — with direct links to help.mikrotik.com.

Works with **Claude Desktop**, **Claude Code**, **VS Code Copilot**, and any MCP-compatible client.

## What is SQL-as-RAG?

Most retrieval-augmented generation (RAG) systems use vector embeddings to search documentation. This project takes a different approach: **SQLite FTS5 full-text search as the retrieval layer** — what we call SQL-as-RAG.

For structured technical documentation like RouterOS, full-text search with BM25 ranking beats vector similarity. Technical terms like "dhcp-snooping" or "/ip/firewall/filter" are exact tokens — stemming and proximity matching handle the rest. No embedding pipeline, no vector database, no API keys. Just a single SQLite file that searches in milliseconds.

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

This downloads the documentation database (~50 MB compressed, ~220 MB on disk) and prints configuration instructions for your MCP client.

> **macOS Gatekeeper:** If macOS blocks the binary, go to **System Settings → Privacy & Security** and click **Allow Anyway**, then run again.
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

Add to your User Settings JSON (`Cmd+Shift+P` → "Preferences: Open User Settings (JSON)"):

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

The AI assistant typically starts with `routeros_search`, then drills into specific pages, properties, or the command tree based on what it finds.

## Building from Source

For contributors or when you have access to the MikroTik HTML documentation export.

### Prerequisites

- [Bun](https://bun.sh/) v1.1+
- RouterOS HTML documentation export (Confluence space export)
- *(Optional)* `inspect.json` from [tikoci/restraml](https://github.com/tikoci/restraml) for the command tree

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

Build binaries for all platforms and compress the database:

```sh
make release VERSION=v0.1.0
```

This cross-compiles to macOS (arm64 + x64), Windows (x64), and Linux (x64), creates ZIP archives, and compresses the database. Then publish:

```sh
gh release create v0.1.0 dist/*.zip dist/ros-help.db.gz --title "v0.1.0" --generate-notes
```

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

- **HTML Archive** — Confluence space export from help.mikrotik.com (March 2026, 317 pages, ~515K words)
- **Command Tree** — `inspect.json` from RouterOS `/console/inspect` via [tikoci/restraml](https://github.com/tikoci/restraml) (46 versions: 7.9–7.23beta2)
- **Product Matrix** — CSV export from mikrotik.com/products/matrix (144 products, 34 columns — hardware specs, license levels, pricing)

Documentation covers RouterOS **v7 only** and aligns with the long-term release (~7.22) at export time. v6 had different syntax and major subsystems — answers for v6 are unreliable.

## License

MIT
