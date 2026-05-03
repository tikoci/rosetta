---
description: "Canonical rule for MCP tool adds, removals, and renames: update the runtime registry, the frozen test list, and the changelog together."
applyTo: "src/mcp.ts, src/mcp-contract.test.ts, CHANGELOG.md"
---
# MCP tool-surface changes

The MCP tool registry is frozen in two places:

- `src/mcp.ts` via `server.registerTool(...)`
- `src/mcp-contract.test.ts` via `EXPECTED_TOOLS`

Adding, removing, or renaming a tool requires updating both files and adding a `CHANGELOG.md` bullet. Description-only edits that keep the tool name, schema keys, and behavior intact do not need a changelog entry.
