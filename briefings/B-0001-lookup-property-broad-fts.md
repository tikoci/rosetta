---
id: B-0001-lookup-property-broad-fts
topic: Should routeros_lookup_property grow an optional broad FTS query mode?
status: resolved
related_tasks: []
created: 2026-05-02
last_revisited: 2026-07-14
---

> **2026-07-14 — resolved, reframed.** The premise shifted: the live question isn't "should
> `routeros_lookup_property` grow a broad-FTS mode" but "should the tool stay on the MCP/TUI surface at
> all." See Decision below. Retirement planning now lives in
> `briefings/B-0011-tool-surface-review.md`.

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

## Decision (2026-07-14)

No — don't add a `query=` broad-FTS mode. Options 1–3 above are all superseded by a bigger reframing:
`routeros_lookup_property` should likely be **retired from the MCP/TUI surface entirely**, not extended.

`routeros_lookup_property` grew out of a real gap: `/console/inspect` (restraml's command-tree source)
carries no narrative property descriptions, and doc-page property tables were deliberately kept out of
`routeros_get_page` because they can be long. That ETL — extracting property/attribute/"arg" descriptions
from doc pages — **stays important and is unaffected by this decision**. manual.mikrotik.com prose is
still the only source of narrative descriptions for RouterOS properties (MikroTik's own docs are
inconsistent about "property" vs "attribute" vs "arg"/"argument" for the same thing — treat them as
synonyms).

What changes is the *surface*: instead of a dedicated exact-lookup tool, (1) `routeros_get_page` could
return whatever properties the page-extraction already found for that page, and (2) `routeros_command_tree`
could point at related command paths rather than requiring a separate lookup call.

This retirement question now belongs to `briefings/B-0011-tool-surface-review.md`, which already tracks
`routeros_lookup_property` as a consolidation candidate — its "current lean" has been updated to point
here instead of a broad-mode evolution.

## Original open questions (moot under the retirement lean, kept for history)

- Does Option 3 cover enough of the use case that Option 1 is unnecessary? Need real session traces.
- If we ship Option 1, do we want to mark `name` and `query` as mutually exclusive, or is there a useful "narrow then FTS within results" combination?