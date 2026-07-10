---
id: T-0026-tui-flag-passthrough
title: TUI pass-through flag parsing
status: done
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

> **Closed 2026-07-10** — folded into umbrella [#27](https://github.com/tikoci/rosetta/issues/27) as part of the tasks→issues migration ([#18](https://github.com/tikoci/rosetta/issues/18)). A TUI↔MCP parity table comes first so 'what's different' is visible before adding TUI features; TUI work sequences after the MCP surface audit (B-0011).

Dot-commands already accept `key=value`. Normal TUI commands (e.g. `s firewall filter`) currently can't take parameters like `--limit 20` or `--version 7.20..7.22`, even though the underlying query function accepts them. Adding pass-through flags closes the parity gap with MCP without inventing new syntax.
