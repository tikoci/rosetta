---
id: B-0005-dude-followups
topic: Dude wiki extraction — outstanding follow-ups
status: open
related_tasks: []
created: 2026-05-02
last_revisited: 2026-05-02
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
