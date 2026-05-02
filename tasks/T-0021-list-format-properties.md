---
id: T-0021-list-format-properties
title: List-format properties extraction
status: ready
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

Pages such as Queues, Hotspot, and RADIUS publish properties as `<ul><li><strong>name</strong>` lists rather than `confluenceTable` rows. Today's extractor misses them. Estimated gain: ~496 properties across 73 pages.
