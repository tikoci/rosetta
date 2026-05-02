---
id: T-0024-structured-highlights
title: Return structured highlights instead of literal ** markers
status: ready
priority: low
area: mcp
depends_on: []
conflicts_with: []
validation:
  - V-tool-shapes
acceptance:
  - "FTS snippet results carry sibling highlights: [{start, end}] arrays"
  - "Existing ** markers retained in human-facing snippet field for backward compat OR call out the breaking change"
  - "Decision recorded if breaking"
  - "TUI updated to render highlights from the structured field"
trigger: ""
created: 2026-05-02
---

# Body

FTS5 snippets currently encode highlights with literal `**` markers in-band. That works for human display but forces JSON consumers to parse Markdown to find match positions. A sibling `highlights: [{start, end}]` array gives clients the offsets directly and lets them choose their own rendering.
