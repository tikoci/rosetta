# mikrotik-pdf

RouterOS documentation extracted from the help.mikrotik.com PDF export into SQLite with FTS5 for LLM retrieval.

## What This Is

The MikroTik help site (Confluence-based) exports a single ~104MB PDF of all RouterOS documentation (~1900 pages). This project extracts that PDF into a searchable SQLite database — the same **SQL-as-RAG** pattern used in `~/Lab/mcp-discourse` (see its `DESIGN.md` for the full architectural rationale: tokenization, BM25, FTS5 query syntax, snippet excerpts, etc.).

### Why PDF, Not Scraping

The PDF is a known-good snapshot from MikroTik — one file, complete, versioned by export date. Scraping help.mikrotik.com is the alternative (cleaner HTML structure) but the PDF was already in hand and the extraction quality turned out to be sufficient for text search. Either source could populate the same SQLite schema.

## Current State

- **305 sections** extracted from the PDF's built-in TOC (bookmark tree), mapped to page ranges
- **549K words**, **20K code lines** (identified by Courier font = RouterOS CLI examples)
- **FTS5 index** with `porter unicode61` tokenizer over title, path, text, and code columns
- The extraction is **repeatable** — get a fresh PDF export, re-run `ros-pdf-to-sqlite.py`

## Schema

```sql
sections (
    id, title, path,        -- path = breadcrumb like 'RouterOS > Firewall > Filter'
    depth,                   -- TOC depth: 1=root, 2=chapter, 3=section, 4+=subsection
    page_start, page_end, page_count,
    text,                    -- full extracted text (ArialUnicodeMS spans)
    code,                    -- just Courier spans (RouterOS CLI commands/examples)
    word_count, code_lines
)

sections_fts USING fts5(title, path, text, code,
    content=sections, content_rowid=id,
    tokenize='porter unicode61'
)
```

## Usage

Quick search from Bun:

```js
import { Database } from "bun:sqlite";
const db = new Database("ros-help.db", { readonly: true });
const results = db.query(`
  SELECT s.id, s.title, s.path, s.word_count,
         snippet(sections_fts, 2, '>>>', '<<<', '...', 30) as excerpt
  FROM sections_fts fts
  JOIN sections s ON s.id = fts.rowid
  WHERE sections_fts MATCH ?
  ORDER BY rank LIMIT 5
`).all("firewall filter");
```

From Python or CLI:

```sh
sqlite3 ros-help.db "SELECT title, path FROM sections_fts WHERE sections_fts MATCH 'DHCP lease' ORDER BY rank LIMIT 5;"
```

## Files

| File | Purpose |
|------|---------|
| `ros-pdf-to-sqlite.py` | Main extraction: PDF → SQLite with FTS5. Repeatable. |
| `ros-pdf-assess.py` | Initial assessment script (font analysis, structure stats) |
| `ros-help.db` | The SQLite database (6.5 MB, WAL mode) |
| `ros-toc.json` | Extracted TOC as JSON (305 entries with page ranges) |

## Re-extraction

When a new PDF export is available:

```sh
# Place new PDF in this directory or ~/Downloads, update path in script
python3 ros-pdf-to-sqlite.py
```

The script drops and recreates tables — no migration needed. The PDF filename encodes the export date (e.g., `ROS-260625-1140-2328.pdf` = 2025-06-26).

## Future Direction

This is step one. The intended evolution:

1. **Command-tree mapping** — Add a `commands` table linking RouterOS menu paths (`/ip/firewall/filter`, `/routing/ospf`, etc.) to section IDs. The command tree is already known from `~/lsp-routeros-ts` and `~/restraml`.

2. **Attribute-level help** — MikroTik documents ~40K attributes across all commands. Parse the property tables from section text into a `properties` table (`command_path`, `name`, `type`, `description`, `default`). This would give per-attribute lookup — what the LSP ultimately needs.

3. **MCP tool** — Expose as an MCP server (like `~/Lab/mcp-discourse`) so LLM agents can query RouterOS docs directly. The search tool pattern from mcp-discourse (NL → FTS5 MATCH, BM25 ranking, snippet excerpts) ports directly.

4. **Cross-reference with forum** — Join with `~/Lab/mcp-discourse` data to find community discussion relevant to a given doc section.

## Cross-References

| Project | Relationship |
|---------|-------------|
| `~/Lab/mcp-discourse` | Same SQL-as-RAG pattern. Its `DESIGN.md` documents FTS5 tokenization, BM25 weights, query planner, and MCP tool design in detail — all applicable here. |
| `~/restraml` | RouterOS REST API structure, endpoint tree, RAML schema. Source for command-tree mapping. |
| `~/lsp-routeros-ts` | RouterOS language server — consumer of per-command/attribute help data. |
| `~/netinstall` | RouterOS REST API gotchas (HTTP verb mapping, property name differences). |

## PDF Source Details

- **Producer:** OpenPDF 1.0.0 (Confluence export)
- **Fonts:** ArialUnicodeMS (body text), Courier (code examples) — all embedded subsets
- **Structure:** Valid PDF 1.5, 306 bookmarks (TOC entries), no internal links/annotations
- **Not tagged** — no semantic PDF markup, but text extraction is clean
- **Font-based code detection** works well: Courier spans reliably identify RouterOS CLI examples
