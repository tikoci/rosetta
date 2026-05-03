---
id: T-0011-tui-mcp-parity-test
title: Enforce TUI ↔ MCP tool parity
status: ready
priority: medium
area: qa
depends_on: []
conflicts_with: []
validation:
  - V-tui-mcp-parity
acceptance:
  - "src/browse-parity.test.ts imports EXPECTED_TOOLS from mcp-contract.test.ts"
  - "Spawns browse REPL with --once .help and parses dot-command list"
  - "Asserts every MCP tool has a corresponding .routeros_<name> dot-command"
  - "(Stretch) For each tool, runs --once .<tool> <minimal-args> and asserts JSON parses"
  - "Wired into .github/workflows/test.yml"
  - "VALIDATION.md V-tui-mcp-parity flips from GAP to blocking"
trigger: ""
created: 2026-05-02
---

# Body

The CLAUDE.md "TUI and MCP share core logic — adapters stay thin" and "PRs that grow MCP-only or TUI-only heuristics are a smell" principles aren't tested. This makes them aspirational. Enforce them.

Adding a tool to `mcp.ts` without wiring its TUI dot-command (or vice versa) should fail CI. Single source of truth: `EXPECTED_TOOLS` in `src/mcp-contract.test.ts` — import it, don't duplicate.
