---
id: B-0011-tool-surface-review
topic: Audit the 14-tool MCP surface for consolidation candidates
status: open
related_tasks: ["#131", "#132", "B-0001", "B-0024"]
created: 2026-05-02
last_revisited: 2026-07-31
---

# Question

Are any of the current 14 MCP tools redundant, under-used, or candidates for consolidation into the unified `routeros_search` or `routeros_explain_command` surface?

# What's grounding this

- 14 tools today: `routeros_search`, `_get_page`, `_lookup_property`, `_explain_command`, `_command_tree`, `_search_changelogs`, `_command_version_check`, `_command_diff`, `_device_lookup`, `_search_tests`, `_dude_search`, `_dude_get_page`, `_stats`, `_current_versions`.
- North Star principle: prefer one tool with a `related` block over many narrow tools.
- Already consolidated: `routeros_search_callouts` and `routeros_search_videos` were folded into `routeros_search.related` (see T-0001).
- Frozen by `EXPECTED_TOOLS` in `src/mcp-contract.test.ts` — adds/removes are intentional.

# Candidates worth examining (initial list, not conclusions)

- **`routeros_command_version_check` vs `routeros_command_diff`** — both are version-aware; could one be an option on the other?
- **`routeros_dude_search` + `_dude_get_page`** — separate surface for a separate (small) data source. Right call, or worth folding? Per `B-0005`'s 2026-07-14 lean, the direction is fold-after-audit: merge Dude results into `routeros_search` behind an opt-in arg once a Dude-extraction accuracy audit confirms it's safe, then retire these two tools.
- **`routeros_stats` vs `routeros_current_versions`** — both are health/metadata; could become one `routeros_about` tool?
- **`routeros_lookup_property`** — per `B-0001`'s 2026-07-14 decision, the lean is **retirement** from
  the MCP/TUI surface, not a broad-mode addition: fold exact lookup into `routeros_get_page` (surface
  page-extracted properties) and `routeros_command_tree` (point at related paths). The extraction ETL
  behind it stays — manual.mikrotik.com prose is still the only source of narrative property
  descriptions. This audit should turn that lean into a concrete fold/deprecation plan.

  **Precondition added 2026-07-31 — do not schedule this fold yet.** The #131/#132 triage measured
  `lookupProperty` and found its `high | medium | low` signal miscalibrated in both directions (`high`
  on column-shifted Apps/VETH rows, `low` on correct bridge rows). Both fold targets sit on the *wrong
  side* of the broken `commands.page_id` join — `get_page` is page-scoped and assumes the page is right;
  `command_tree` reads that same fuzzy link — and neither can express the uncertainty the tool currently
  reports. Folding now would launder it. Order of operations: **fix the join, recalibrate confidence,
  then decide the surface.** See `briefings/B-0024-command-prose-join.md` and B-0001's revisit trigger.
  This does not change the lean; it blocks acting on it until B-0024 step 3 has data.

# Method for the audit

1. For each of the 14 tools, write 2–3 lines: what it does uniquely, what overlaps with `routeros_search.related`, frequency of expected use.
2. For each pair flagged above, sketch what consolidation would look like (param shape, deprecation path).
3. Conclude: tools to keep, tools to fold, no-change tools. Each fold spawns a `T-*.md`.

# Why this is a briefing, not a task

This is a "double-check on current think" — the answer might be "all 14 are right." Promoting it to T-*.md upfront would commit to changes before we know which (if any) are warranted. The audit briefing is the work product if no consolidation is recommended.

# Open questions

- What signal do we have about real-session tool usage frequency? Today: none. Worth opt-in logging (see B-0010 → "opt-in TUI/usage logs") to inform this kind of audit?
