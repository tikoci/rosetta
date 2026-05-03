---
description: "Tool descriptions should teach agents how to navigate the surface: workflow arrows, empty-result hints, boundaries, and result-budget cues."
applyTo: "src/mcp.ts, src/query.ts, src/mcp-contract.test.ts, README.md"
---
# MCP tool descriptions

Tool descriptions are part of the interface.

- Include knowledge boundaries when they matter (export date, supported versions, v6 caveats).
- Use workflow arrows (`→ next tool`) to guide follow-up calls.
- Return actionable empty-result hints instead of bare empties.
- Preserve the `relatedCaps(limit)` "hunger knob" pattern when expanding `routeros_search`.
