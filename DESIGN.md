# Design — mikrotik-docs

> **Audience:** LLM agents working on this codebase. Explains *why* things are the way they are.
> For *what* the project is and how it works, see `CLAUDE.md`.
> For ideas and future work, see `BACKLOG.md`.

## SQL-as-RAG Pattern

SQLite FTS5 as the retrieval layer for retrieval-augmented generation, exposed over MCP so any LLM client can use it. FTS5 with porter stemming hits ~90% of embedding quality for domain-specific technical corpora where users and content share precise terminology. No vector DB, no embedding pipeline, sub-millisecond queries.

This pattern is used across several `tikoci` projects (forum archives, documentation, device specs). The key insight: for corpora under ~500K documents where users and content share precise jargon, lexical matching with BM25 ranking is the practical middle ground between "just grep it" and deploying a vector database.

## Data Sources

| Source | Location | Format | Coverage |
|--------|----------|--------|----------|
| Confluence HTML | `box/documents-export-2026-3-25/ROS/` | 317 HTML files | March 2026 export |
| inspect.json | [tikoci/restraml](https://github.com/tikoci/restraml) `docs/*/extra/inspect.json` | JSON tree per version | 46 versions (7.9–7.23beta2) |
| Product matrix | `matrix/2026-03-25/matrix.csv` | CSV, 34 columns | 144 products, March 2026 |

**restraml dependency:** The extraction scripts read `inspect.json` files from a local clone of tikoci/restraml. The path is configured via the `RESTRAML` variable in the Makefile (defaults to `$(HOME)/restraml/docs`).

## Key Decisions

### v6 is out of scope
No inspect.json data exists for RouterOS v6. Document as unknown territory in tool descriptions. Oldest version with data is 7.9.

### Junction table for version tracking
`command_versions` is a (command_path, ros_version) junction table — not per-version columns or per-version rows in `commands`. This scales to hundreds of versions without schema changes. The `commands` table holds only the primary version (latest stable, currently 7.22).

### Primary version = latest stable
The `commands` table is populated from the latest stable version. All other versions go into `command_versions` only (via `--accumulate` flag). This means `browseCommands()` always shows current-stable, while `browseCommandsAtVersion()` can show any tracked version.

### All versions extracted, filter at query time
46 versions including betas and RCs. Prefer more data over less. The `channel` column in `ros_versions` allows filtering to stable-only if needed.

### FTS5 for text, SQL WHERE for structured queries
Pages, callouts, and properties use FTS5 for natural language search. Device specs (when built) will need both: FTS for name search, SQL WHERE for structured filters like "ARM 64bit AND ports >= 8".

### Callout FK ordering
Callouts have FK to pages. On re-extraction, delete callouts before pages. `extract-html.ts` handles this.

### `_completion` data deferred
[tikoci/restraml PR #35](https://github.com/tikoci/restraml/pull/35) adds `deep-inspect.json` with argument completion values (enum choices, etc.). Schema stub TBD when that ships. This would enrich the `commands` table significantly.

### CSV requires manual download
The old `curl -X POST -d "ax=matrix"` API is dead (late 2025). MikroTik's product matrix is now a Laravel Livewire/PowerGrid table. Export via browser: visit `mikrotik.com/products/matrix`, click export, choose "All". See `matrix/CLAUDE.md` for column schema.

### HTML doc versioning is simple
Don't overengineer until there's a second HTML export to compare against. When that arrives, hash-based page diffing is sufficient. See BACKLOG.md for details.

## Cross-References

| Project | Relationship |
|---------|-------------|
| [tikoci/restraml](https://github.com/tikoci/restraml) | Source of `inspect.json` command tree + RAML schema. PR #35 adds deep-inspect. |
| [tikoci/lsp-routeros-ts](https://github.com/tikoci/lsp-routeros-ts) | Consumer: hover help, property docs, command path → URL mapping. |
| [tikoci/netinstall](https://github.com/tikoci/netinstall) | RouterOS REST API gotchas (HTTP verb mapping, property name differences). |

## History

What was built, in rough order (March 2026):

1. **PDF extraction** (archival) — `ros-pdf-to-sqlite.py`, `ros-pdf-assess.py`. Proved the concept but PDF parsing was lossy. Superseded by HTML extraction.
2. **HTML extraction** — `extract-html.ts`, `extract-properties.ts`. 317 pages, 4,860 properties, 1,034 callouts.
3. **Command tree** — `extract-commands.ts`. Single-version first, then multi-version with `extract-all-versions.ts` (46 versions, 1.67M junction entries).
4. **Command linking** — `link-commands.ts`. Automated heuristic matching: code block paths + `<strong>`/`<code>` tag patterns. ~92% dir coverage.
5. **MCP server** — `mcp.ts` + `query.ts`. 8 tools with compound term recognition, BM25 ranking, AND→OR fallback.
6. **Knowledge boundaries** — Tool descriptions document data currency (March 2026 export, 7.9–7.23beta2 versions, no v6).
