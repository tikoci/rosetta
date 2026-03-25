# Project Guidelines

## Overview

RouterOS documentation as SQLite FTS5 — an MCP server providing RAG search + command glossary over MikroTik's official docs. Built with **Bun** + **TypeScript**.

See [CLAUDE.md](../CLAUDE.md) for full architecture, schema, and source details.

## Build and Test

```sh
bun install              # Install dependencies
make extract             # Full pipeline: HTML → DB → link commands (single version)
make extract-full        # Full pipeline with all 46 RouterOS versions
make serve               # Start MCP server (stdio transport)
make search query="DHCP" # CLI search
bun run typecheck        # Type checking (no emit)
make lint                # Biome linter
make clean               # Remove DB files
```

Individual extraction steps: `make extract-html`, `make extract-commands`, `make extract-all-versions`, `make link`.

## Architecture

| Component | File | Purpose |
|-----------|------|---------|
| MCP Server | `src/mcp.ts` | 8 tools via stdio transport using `@modelcontextprotocol/sdk` |
| Query Engine | `src/query.ts` | NL → FTS5 query planner, BM25 ranking, compound term recognition |
| Database | `src/db.ts` | Schema init, WAL mode, FTS5 triggers, singleton pattern |
| Extractors | `src/extract-*.ts` | HTML/JSON → SQLite (each drops and recreates its tables) |
| Linker | `src/link-commands.ts` | Command tree ↔ page matching (code paths + heuristics) |
| CLI Search | `src/search.ts` | Quick search from terminal |

**Database:** `ros-help.db` (SQLite WAL mode). Main tables: `pages`, `callouts`, `properties`, `commands`, `ros_versions`, `command_versions` with FTS5 indexes on pages, callouts, and properties.

**Data sources:**
- HTML export from Confluence in `box/documents-export-2026-3-25/ROS/` (317 pages)
- `inspect.json` from `~/restraml/` for the command tree (40K entries, 46 versions: 7.9–7.23beta2)

## Code Style

- **Runtime:** Bun (use `bun:sqlite` for DB, not better-sqlite3)
- **Modules:** ESM with `.ts` extensions in imports (`import { foo } from './bar.ts'`)
- **Validation:** Zod v4 for MCP tool input schemas
- **DOM parsing:** linkedom (not jsdom)
- **Linter:** Biome (formatter disabled — only linting rules apply)
- **No emit:** TypeScript is type-checked only (`noEmit: true`), Bun runs `.ts` directly

## Conventions

- Extractors are idempotent — they `DROP TABLE IF EXISTS` and rebuild
- FTS5 indexes use `porter unicode61` tokenizer with content-sync triggers
- BM25 weights: title=3.0, path=2.0, text=1.0, code=0.5
- The MCP server name is `"mikrotik-docs"` — keep consistent across configs
- Stop words are hardcoded in `query.ts` (~72 words)
- Compound terms (~37 RouterOS pairs like firewall+filter) use FTS5 NEAR expressions
