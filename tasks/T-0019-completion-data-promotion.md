---
id: T-0019-completion-data-promotion
title: Promote schema_nodes._attrs.completion to structured columns
status: ready
priority: low
area: extraction
depends_on: []
conflicts_with: []
validation:
  - V-schema-roundtrip
acceptance:
  - "Confirm _attrs.completion shape stable across multiple deep-inspect versions"
  - "Add structured columns (e.g. completion_values, completion_style) to schema_nodes"
  - "Existing _attrs JSON catch-all retained for forward-compat metadata"
  - "Schema-roundtrip tests cover the new columns"
trigger: ""
created: 2026-05-02
---

# Body

`_attrs.completion` shape is known: `{ [value]: { style, preference, desc? } }`. Once it's stable across more versions, promote it into structured columns for SQL filtering and enum suggestions. Serves the `DESIGN.md` "Command validation pipeline — explain / validate / run" direction.
