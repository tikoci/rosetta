---
id: T-0024-structured-highlights
title: Return structured highlights instead of literal ** markers
status: done
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

> **Closed 2026-07-10** — migrated to [#24](https://github.com/tikoci/rosetta/issues/24) as part of the tasks→issues migration ([#18](https://github.com/tikoci/rosetta/issues/18)). The Docusaurus corpus made this worse and user-visible: page text is now raw Markdown with native `**bold**`, so FTS `**` snippet markers collide (`****hAP****` seen in the TUI). The spec is being reworked on the issue.

FTS5 snippets currently encode highlights with literal `**` markers in-band. That works for human display but forces JSON consumers to parse Markdown to find match positions. A sibling `highlights: [{start, end}]` array gives clients the offsets directly and lets them choose their own rendering.
