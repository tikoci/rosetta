---
id: T-0021-list-format-properties
title: List-format properties extraction
status: done
priority: medium
area: extraction
depends_on: []
conflicts_with: []
validation:
  - V-db-min-content
acceptance:
  - "extract-properties.ts parses <ul><li><strong>name</strong>...</li></ul> property lists"
  - "Coverage gain measured: ~496 properties across ~73 pages (Queues, Hotspot, RADIUS, etc.)"
  - "properties_fts re-indexes correctly"
  - "VALIDATION row updated with new minimum count if applicable"
trigger: ""
created: 2026-05-02
---

# Body

> **Closed 2026-07-10** — closed as part of the tasks→issues migration ([#18](https://github.com/tikoci/rosetta/issues/18)). The Confluence `<ul><li><strong>` shape this targeted is gone since `T-0035`/`T-0036`, but the same gap re-appeared in Markdown form — 32 Docusaurus pages use bullet-list properties the table-only parser misses. Successor: [#20](https://github.com/tikoci/rosetta/issues/20).

Pages such as Queues, Hotspot, and RADIUS publish properties as `<ul><li><strong>name</strong>` lists rather than `confluenceTable` rows. Today's extractor misses them. Estimated gain: ~496 properties across 73 pages.
