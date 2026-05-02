---
id: B-0003-direct-sql-tool-out-of-scope
topic: Why rosetta does not ship a `run_sql` MCP tool
status: resolved
related_tasks: []
created: 2026-05-02
last_revisited: 2026-05-02
---

# Decision

**No `run_sql` MCP tool.** Schema resources plus targeted tools are sufficient.

# What's grounding this

- 14 typed tools each return shapes the LLM can reason about.
- `rosetta://schema.sql` and `rosetta://schema-guide.md` resources let agents inspect the schema if they need to construct a custom query offline.
- A general-purpose SQL tool widens the surface dramatically — every query becomes "is this safe, fast, and bounded."

# Why not

- Token cost of a verbose result row blows the budget that `relatedCaps(limit)` tunes.
- The retrieval eval can't measure quality on free-form SQL outputs.
- Most "I need a custom query" cases collapse into either an existing tool's missing parameter or a missing tool — both are addressable inside the typed-tool model.

# Trigger to revisit

If `routeros_search` and the targeted drill-down tools prove insufficient in real sessions repeatedly, with concrete examples that aren't covered by adding parameters to existing tools, reconsider.
