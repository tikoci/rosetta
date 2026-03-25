# mikrotik-docs

MCP server for searching [MikroTik RouterOS documentation](https://help.mikrotik.com/docs/spaces/ROS/overview). Extracts the official Confluence HTML export into a searchable SQLite database with FTS5 full-text search, then exposes it as 8 MCP tools for AI coding assistants.

**What you get:** Ask your AI assistant about RouterOS configuration and it can search 317 documentation pages, 4,860 property definitions, and a 40K-entry command tree — with direct links back to help.mikrotik.com.

## Quick Start

### Prerequisites

- [Bun](https://bun.sh/) v1.1+
- A MikroTik RouterOS HTML documentation export (Confluence space export)
- *(Optional)* `inspect.json` from RouterOS `/console/inspect` for the command tree

### Setup

```sh
git clone https://github.com/TIKOCI/mikrotik-docs.git
cd mikrotik-docs
bun install
```

### Build the Database

Place your Confluence HTML export in `box/documents-export-<date>/ROS/`, then:

```sh
make extract
```

This runs the full pipeline: parse HTML → extract properties → load command tree → link commands to pages.

### Use with VS Code (Copilot)

The repo includes `.vscode/mcp.json` — just open the folder in VS Code. Copilot Chat will automatically have access to the RouterOS documentation tools.

The MCP server provides 8 tools:

| Tool | What it does |
| ---- | ------------ |
| `routeros_search` | Full-text search with BM25 ranking and snippets |
| `routeros_get_page` | Retrieve a full documentation page by ID or title |
| `routeros_lookup_property` | Look up a property by exact name |
| `routeros_search_properties` | Search across property names and descriptions |
| `routeros_command_tree` | Browse the RouterOS command hierarchy |
| `routeros_search_callouts` | Search note/warning/info callouts across all pages |
| `routeros_command_version_check` | Check which RouterOS versions include a command |
| `routeros_stats` | Database health and coverage stats |

### Use with Claude Code

Add to your Claude Code MCP settings (or use the included `.mcp.json`):

```json
{
  "mcpServers": {
    "mikrotik-docs": {
      "command": "bun",
      "args": ["run", "src/mcp.ts"],
      "cwd": "/path/to/mikrotik-docs"
    }
  }
}
```

### CLI Search

```sh
bun run src/search.ts "DHCP server"
```

## How It Works

1. **Extract** — Parses Confluence HTML files into SQLite tables (pages, properties, commands)
2. **Index** — FTS5 full-text indexes with porter stemming and BM25 ranking
3. **Link** — Maps the RouterOS command tree (`/ip/firewall/filter`) to documentation pages
4. **Serve** — Exposes everything as MCP tools over stdio transport

The database is ~15MB and searches return in milliseconds.

## Project Structure

```text
src/
├── mcp.ts                  # MCP server (8 tools, stdio transport)
├── query.ts                # NL → FTS5 query planner, BM25 ranking
├── db.ts                   # SQLite schema, WAL mode, FTS5 triggers
├── extract-html.ts         # Confluence HTML → pages + callouts tables
├── extract-properties.ts   # Property table extraction from HTML
├── extract-commands.ts     # inspect.json → commands table (version-aware)
├── extract-all-versions.ts # Batch extract all 46 RouterOS versions
├── link-commands.ts        # Command ↔ page mapping
├── assess-html.ts          # HTML archive assessment (run once)
└── search.ts               # CLI search tool
```

## Development

```sh
bun run typecheck    # Type check (no emit — Bun runs .ts directly)
make lint            # Biome linter
make clean           # Remove database files
make extract         # Rebuild from source HTML
```

## Data Sources

- **HTML Archive** — Confluence space export from help.mikrotik.com (317 pages, ~515K words)
- **Command Tree** — `inspect.json` from RouterOS `/console/inspect` (549 dirs, 5,090 commands, 34K args)

> **Note:** The HTML export and `inspect.json` are not included in this repo. You need your own copy of the MikroTik documentation export.

## License

MIT
