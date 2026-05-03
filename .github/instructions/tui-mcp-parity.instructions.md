---
description: "MCP and browse are paired surfaces. Every MCP tool must remain reachable from the TUI, and dot-commands are the raw parity contract."
applyTo: "src/mcp.ts, src/browse.ts, src/query.ts, src/browse-parity.test.ts, src/mcp-contract.test.ts, README.md, CLAUDE.md"
---
# TUI/MCP parity

The browse TUI is a first-class surface, not a test harness.

- Every MCP tool needs a corresponding browse path; dot-commands (`.routeros_*`) are the raw 1:1 contract.
- The TUI may be richer, but it must not become a subset of the MCP surface.
- When a tool, filter, or default changes on one side, check the other side and the parity tests.
