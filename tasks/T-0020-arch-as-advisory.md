---
id: T-0020-arch-as-advisory
title: Treat arch as advisory, not exclusion in command-tree tools
status: ready
priority: medium
area: mcp
depends_on: []
conflicts_with: []
validation:
  - V-tool-shapes
acceptance:
  - "routeros_command_tree and routeros_explain_command treat arch as a hint"
  - "Prefer matching-arch data when available"
  - "Avoid empty results for unsupported arches"
  - "Include explicit notes about coverage when fallback applies"
  - "Tests cover both matching-arch and fallback paths"
trigger: ""
created: 2026-05-02
---

# Body

CHR doesn't have Wi-Fi hardware, so wireless driver packages are missing from inspect.json — the HTML docs cover them. Tools should not return empty for unsupported arches; instead, they should prefer matching arch data and fall back with a clear note about what coverage applies. This is more useful to agents than a strict empty-or-correct binary.
