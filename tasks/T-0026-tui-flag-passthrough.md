---
id: T-0026-tui-flag-passthrough
title: TUI pass-through flag parsing
status: ready
priority: medium
area: tui
depends_on: []
conflicts_with: []
validation:
  - V-tui-mcp-parity
  - V-cli-flag-uniformity
acceptance:
  - "TUI normal commands accept --limit, --version, --breaking and other relevant flags"
  - "Dot-command key=value syntax remains unchanged"
  - "Flags map to the same parameters as the equivalent MCP tool call"
  - "browse tests cover each new flag"
  - "MANUAL.md updated"
trigger: ""
created: 2026-05-02
---

# Body

Dot-commands already accept `key=value`. Normal TUI commands (e.g. `s firewall filter`) currently can't take parameters like `--limit 20` or `--version 7.20..7.22`, even though the underlying query function accepts them. Adding pass-through flags closes the parity gap with MCP without inventing new syntax.
