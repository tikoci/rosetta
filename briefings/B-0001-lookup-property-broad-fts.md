---
id: B-0001-lookup-property-broad-fts
topic: Should routeros_lookup_property grow an optional broad FTS query mode?
status: open
related_tasks: []
created: 2026-05-02
last_revisited: 2026-05-02
---

# Question

Should `routeros_lookup_property` grow optional `query=` mode for broad property discovery, or should that stay TUI/internal only?

# What's grounding this

- TUI `props` command already does broad property search via `searchProperties(query, command_path?, limit)` — proven shape.
- Current MCP tool: exact-name lookup only.
- Tool count is 14 today; consolidation is a North Star principle (see `DESIGN.md`).

# Options

1. **Add `query` param** — keep `name` for exact lookup; add `query` for ranked FTS. Same tool, two modes.
2. **Keep MCP narrow, add a second tool** — explicit `routeros_search_properties`. More tools, clearer shape.
3. **Fold into `routeros_search.related.properties`** — broad property discovery already happens here. Don't duplicate the surface.

# Current lean

Option 1 — mirrors TUI behaviour, keeps tool count stable, preserves the exact-lookup contract for the common case.

# Open questions

- Does Option 3 cover enough of the use case that Option 1 is unnecessary? Need real session traces.
- If we ship Option 1, do we want to mark `name` and `query` as mutually exclusive, or is there a useful "narrow then FTS within results" combination?
