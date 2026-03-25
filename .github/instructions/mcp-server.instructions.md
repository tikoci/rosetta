---
description: "Use when working on MCP server tools, query logic, or FTS5 search. Covers BM25 ranking, compound terms, stop words, and tool schema conventions."
applyTo: "src/mcp.ts, src/query.ts, src/search.ts"
---
# MCP Server & Query Engine

## MCP Tool Conventions
- Server name: `"mikrotik-docs"` — never change
- All tool inputs validated with Zod v4 schemas
- Transport: stdio only (`StdioServerTransport`)
- Tools return structured objects, not raw SQL rows
- Tool descriptions should include knowledge boundaries (doc export date, version range)

## 8 Tools
| Tool | Purpose |
|------|---------|
| `routeros_search` | FTS5 across pages, BM25 ranked |
| `routeros_get_page` | Full page by ID or title, includes callouts |
| `routeros_lookup_property` | Exact property name, optional command path filter |
| `routeros_search_properties` | FTS across property names + descriptions |
| `routeros_command_tree` | Browse command hierarchy, optional version param |
| `routeros_search_callouts` | FTS across callout notes/warnings/info, optional type filter |
| `routeros_command_version_check` | Which RouterOS versions include a command path |
| `routeros_stats` | DB health: counts, version range, link coverage |

## FTS5 Query Rules
- BM25 weights: title=3.0, path=2.0, text=1.0, code=0.5
- AND mode first, fallback to OR if zero results
- Stop words list in `query.ts` (~72 words) — do not duplicate elsewhere
- Compound terms (~37 RouterOS pairs) → FTS5 NEAR expressions
- Porter unicode61 tokenizer — stemming is automatic

## Adding a New Tool
1. Add query function in `src/query.ts`
2. Register via `server.registerTool()` in `src/mcp.ts` with Zod input schema
3. Update tool descriptions to include knowledge boundaries and help LLM agents pick the right tool
