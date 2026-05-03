---
description: "Shared behavior belongs in query.ts so MCP and browse inherit it. Adapter-only heuristics are a smell."
applyTo: "src/query.ts, src/mcp.ts, src/browse.ts, src/search.ts, src/classify.ts"
---
# Query core, not adapter

Default to landing behavior in shared query logic.

- If a heuristic can help both MCP and browse, put it in `src/query.ts` (or a shared pure helper), not only in `mcp.ts` or `browse.ts`.
- Treat MCP-only or TUI-only heuristics as a smell unless the surface truly has unique needs.
- Keep adapters thin: formatting, transport wiring, and UI affordances belong there; retrieval logic usually does not.
