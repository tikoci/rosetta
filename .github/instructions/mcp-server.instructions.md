---
description: "Routing file for MCP/query/TUI work. The actual rules live in the narrow instruction files listed here."
applyTo: "src/mcp.ts, src/query.ts, src/query.test.ts, src/search.ts, src/browse.ts, src/db.ts, src/classify.ts, src/classify.test.ts, src/canonicalize.ts, src/canonicalize-resolver.ts, src/canonicalize.test.ts, src/canonicalize.fuzz.test.ts, src/mcp-contract.test.ts, src/mcp-http.test.ts"
---
# MCP/query/TUI instruction map

This file intentionally stays thin. When you touch this surface, also read the canonical rule files that match the change:

- `query-core-not-adapter.instructions.md`
- `tui-mcp-parity.instructions.md`
- `mcp-tool-descriptions.instructions.md`
- `tool-surface-change.instructions.md`
- `canonicalize-vendored.instructions.md`
- `bun-not-node.instructions.md`

Do not re-expand this file with rule prose. Put new MCP/query/TUI rules in the narrow file that owns them.
