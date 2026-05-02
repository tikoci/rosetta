---
id: T-0010-mcp-stdio-client-test
title: Real-client MCP stdio integration test
status: ready
priority: high
area: qa
depends_on: []
conflicts_with: []
validation:
  - V-stdio-handshake
acceptance:
  - "src/mcp-stdio-client.test.ts spawns bun src/mcp.ts as a subprocess"
  - "Uses @modelcontextprotocol/sdk/client + StdioClientTransport"
  - "Asserts tools/list returns 14 tools"
  - "Asserts tools/call routeros_search returns shape with pages + related"
  - "Asserts resources/list returns the fixed-resource set"
  - "Closes cleanly; catches stdout pollution (any console.log breaks the framing)"
  - "Wired into .github/workflows/test.yml"
  - "VALIDATION.md V-stdio-handshake flips from GAP to blocking"
trigger: ""
created: 2026-05-02
---

# Body

Today `mcp-http.test.ts` covers the HTTP transport, but **stdio** — what every primary MCP client (Claude Desktop, Claude Code, VS Code Copilot stdio mode, Codex) actually uses — is not exercised end-to-end. The user explicitly called this out as a real concern: "vscode with copilot with the stdio path" foretells problems for tikbook and standalone-vscode-client work.

Cheapest catch for: stdio framing bugs, stdout pollution from `console.log` (subtle real failure mode in MCP servers — anything written to stdout outside the JSON-RPC framing breaks the client handshake), startup delays, schema mismatches.

Reuses the in-process `createServer()` factory pattern already in `mcp.ts`. No new MCP server logic. Copy the spawn/teardown shape from `src/mcp-http.test.ts`.
