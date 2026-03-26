# mikrotik-docs

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

1. **SQL-as-RAG MCP Server** — 9 tools for LLM agents to search docs, look up properties, browse the command tree, check version history, and fetch current versions
2. **RouterOS Glossary** — command-tree → documentation mapping, feeding [lsp-routeros-ts](https://github.com/tikoci/lsp-routeros-ts) (hover help) and future Copilot integration

## Current State

- **317 pages** from Confluence HTML export (March 2026), with breadcrumb paths, page IDs, help.mikrotik.com URLs
- **515K words**, **14K code lines** (identified by `brush: ros` code blocks)
- **1,034 callouts** extracted (Note/Warning/Info/Tip) from Confluence callout macros
- **~5,000 properties** extracted from confluenceTable rows (name, type, default, description)
- **40K command tree entries** from `inspect.json` (551 dirs, 5114 cmds, 34K args), primary version: 7.22 (latest stable)
- **46 RouterOS versions tracked** (7.9 through 7.23beta2) — 1.67M command_versions entries
- **92% of dirs linked** to documentation pages via automated code-block + heuristic matching
- **FTS5 indexes** with `porter unicode61` tokenizer, BM25-weighted ranking
- **MCP server** with 9 tools: search, get_page, lookup_property, search_properties, command_tree, search_callouts, command_version_check, stats, current_versions

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
```

## Usage

### MCP Server

```sh
bun run src/mcp.ts   # stdio transport
```

Register in `.vscode/mcp.json` or Claude Code settings:

```json
{
  "servers": {
    "mikrotik-docs": {
      "command": "bun",
      "args": ["run", "src/mcp.ts"],
      "cwd": "/Users/amm0/Lab/mikrotik-docs"
    }
  }
}
```

### MCP Tools

| Tool | Purpose |
|------|---------|
| `routeros_search` | FTS5 search across pages. BM25 ranked, AND→OR fallback |
| `routeros_get_page` | Full page text by ID or title, optional `max_length` truncation |
| `routeros_lookup_property` | Property by exact name, optionally filtered by command path |
| `routeros_search_properties` | FTS across property names + descriptions, AND→OR fallback |
| `routeros_command_tree` | Browse command hierarchy at a given path |
| `routeros_search_callouts` | FTS across callouts, type-only browse, AND→OR fallback |
| `routeros_command_version_check` | Version range for a command path, boundary notes |
| `routeros_stats` | DB health: page/property/command counts, link coverage |
| `routeros_current_versions` | Live-fetch current RouterOS versions per channel |

Tool descriptions include workflow arrows (→ next tool) and empty-result hints to guide LLM agents between tools.

### CLI Search

```sh
bun run src/search.ts "DHCP server"
```

### Direct SQL

```sh
sqlite3 ros-help.db "SELECT title, url FROM pages_fts WHERE pages_fts MATCH 'DHCP lease' ORDER BY rank LIMIT 5;"
```

## Files

| File | Purpose |
|------|---------|
| `src/mcp.ts` | MCP server — 9 tools, stdio transport |
| `src/query.ts` | NL → FTS5 query planner, BM25 ranking, OR fallback, version sorting |
| `src/db.ts` | Schema init, singleton DB, WAL mode |
| `src/extract-html.ts` | HTML → pages + callouts tables (repeatable) |
| `src/extract-properties.ts` | Property table parsing from HTML |
| `src/extract-commands.ts` | inspect.json → commands table (version-aware) |
| `src/extract-all-versions.ts` | Batch extract all RouterOS versions from restraml |
| `src/link-commands.ts` | Command ↔ page mapping |
| `src/assess-html.ts` | HTML archive assessment (run once) |
| `src/search.ts` | CLI search tool |
| `src/query.test.ts` | Bun tests — query planner + DB integration (in-memory SQLite) |
| `ros-help.db` | The SQLite database (WAL mode) |
| `ros-pdf-to-sqlite.py` | Original PDF extraction (archival) |
| `ros-pdf-assess.py` | Original PDF assessment (archival) |

## Re-extraction

When a new HTML/PDF export is available:

```sh
# Place new export in box/ directory
make clean
make extract       # runs extract-html, extract-properties, extract-commands, link (single version)
make extract-full  # runs extract-html, extract-properties, extract-all-versions, link (all versions)
```

The Makefile orchestrates the full pipeline. Each script drops and recreates its tables.

## Source Details

### HTML Archive (Primary)

- **Export:** Confluence space export, March 2026
- **Format:** 317 HTML files + attachments in `box/documents-export-2026-3-25/ROS/`
- **Structure:** Consistent Confluence classes (`confluenceTable`, `confluenceTh`, `syntaxhighlighter-pre`)
- **Property tables:** 605 tables with "Property | Description" headers across 147 pages
- **Code blocks:** `data-syntaxhighlighter-params="brush: ros"` for RouterOS CLI

### Command Tree (inspect.json)

- **Source:** `inspect.json` files from [tikoci/restraml](https://github.com/tikoci/restraml) — 46 versions extracted
- **Generation:** GitHub Actions run RouterOS CHR under QEMU, daily version checks. Two builds per version: base (`routeros.npk` only) and extra (all extra-packages available on CHR). We use the `extra/` variant.
- **Content:** Full RouterOS API from `/console/inspect` — 551 dirs, 5114 cmds, 34K args (primary: 7.22)
- **Versions:** 7.9 through 7.23beta2 (stable + development channels)
- **Primary version:** 7.22 (latest stable) — used for the `commands` table and linking
- **Version tracking:** 1.67M entries in `command_versions` junction table
- **Coverage gap:** CHR doesn't have Wi-Fi hardware, so wireless driver packages (`wifi-qcom`, etc.) are missing from inspect.json. Some packages like `zerotier` are also absent. The HTML docs cover these — inspect.json doesn't.

## Related Projects

See `DESIGN.md` for full cross-references, restraml GitHub Pages tools, and rationale.

- **[tikoci/restraml](https://github.com/tikoci/restraml)** — source of `inspect.json` command tree data. Also publishes [interactive lookup/diff tools](https://tikoci.github.io/restraml/) on GitHub Pages. Local path configurable via `RESTRAML` in Makefile.
- **[tikoci/lsp-routeros-ts](https://github.com/tikoci/lsp-routeros-ts)** — consumer of property/command data from this DB
- **[tikoci/vscode-tikbook](https://github.com/tikoci/vscode-tikbook)** — RouterOS script notebook for VSCode. Potential consumer for Copilot-assisted scripting.
- **[tikoci/netinstall](https://github.com/tikoci/netinstall)** — RouterOS REST API gotchas (HTTP verb mapping, property name differences)
