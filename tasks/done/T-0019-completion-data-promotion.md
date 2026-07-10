---
id: T-0019-completion-data-promotion
title: Promote schema_nodes._attrs.completion to structured columns
status: done
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

> **Closed 2026-07-10** — rolled back into `briefings/B-0015-explain-static-live-trilogy.md` as part of the tasks→issues migration ([#18](https://github.com/tikoci/rosetta/issues/18)). Piecemeal promotion of completion data belongs to the broader cross-project 'explain: static + live' theme (rosetta static analysis vs centrs/lsp-routeros-ts live `/console/inspect`), not a standalone task.

`_attrs.completion` shape is known: `{ [value]: { style, preference, desc? } }`. Once it's stable across more versions, promote it into structured columns for SQL filtering and enum suggestions. Serves the `DESIGN.md` "Command validation pipeline — explain / validate / run" direction.
