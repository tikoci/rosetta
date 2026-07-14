---
id: B-0005-dude-followups
topic: Dude wiki extraction — outstanding follow-ups
status: open
related_tasks: []
created: 2026-05-02
last_revisited: 2026-07-14
---

# Open items

These are wait-and-see; the Dude pipeline is shipped and stable. If user-visible misses appear, they get promoted to GitHub issues individually.

- **Wayback recovery for missing pages.** `The_Dude`, `v3_Device_map`, `v3_Device_list` did not extract cleanly. Worth a one-off check whether recoverable snapshots exist.
- **/dude command linking.** The command-tree has `/dude` paths; they're not linked to `dude_pages` today. Low priority — the surfaces are separate (`routeros_dude_search` vs `routeros_search`).
- **dude.db schema documentation.** Worth doing once a safe sample DB is available. Coordinate with the `donny` project.
- **Image return formats.** Dude pages have screenshots; serving them via MCP is awkward until multimodal MCP is more practical. Revisit when the spec/clients catch up.

# What's grounding this

- Dude pages live in their own table, separate FTS, separate MCP tools — minimal blast radius if any of this changes.
- `MANUAL.md` documents the current Dude tables in the schema reference.
- See `donny` project for `dude.db` itself.

## Current lean (2026-07-14)

Direction shifted from "leave the separate Dude surface alone" to a two-phase plan:

1. **Audit first.** Re-confirm the Dude extraction is accurate — check for extraction errors, not just
   the already-known missing pages (`The_Dude`, `v3_Device_map`, `v3_Device_list`). It's fine for the
   Dude wiki to stay cached in-repo (it's a frozen archive, not a moving target), but a bad scrape
   shouldn't be promoted into default search results.
2. **If the audit comes back clean, merge Dude into `routeros_search`** behind an opt-in arg
   (`include_dude_docs=true` or similar), and retire the dedicated `routeros_dude_search` /
   `routeros_dude_get_page` tools once the merge lands — that's a fold worth flagging to
   `briefings/B-0011-tool-surface-review.md` too, since it removes 2 of the current tool-surface count.

This briefing stays `open` rather than `resolved` — the audit hasn't happened yet, so the merge isn't a
committed decision. Next concrete step: open a GitHub issue scoped to the audit (step 1) when someone
picks this up; the merge (step 2) is downstream of that audit's result, not agent-ready yet.