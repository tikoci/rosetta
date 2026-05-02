---
id: B-0006-device-aliases
topic: Device AKA / alias handling for renamed models
status: open
related_tasks: []
created: 2026-05-02
last_revisited: 2026-05-02
---

# Question

Should rosetta build an alias table for renamed device models (e.g. `hex 2024` → `hEX refresh`), and if so, when?

# What's grounding this

- `routeros_device_lookup` is intentionally heuristic: handles exact name/code, LIKE, FTS, slug-normalized fallback, superscript normalization, disambiguation notes.
- Renamed-model aliases can still miss. This is documented in `CLAUDE.md` as an ongoing concern, not a solved problem.
- The fix shape is straightforward: table of `{alias → canonical_product_name}` consulted before fallback.

# Why not just build it now

- The cost of misses is mostly recoverable (the user retries with another phrasing).
- The maintenance cost of an alias table is real — each new MikroTik product naming change adds rows.
- We don't have telemetry to size the problem.

# Trigger to act

Build the table only when **real false-empty lookups appear**. Each failed lookup gets recorded with: user query, expected product, source evidence (forum post, docs URL, MikroTik product page). Once we have ~5+ documented misses, the alias table earns its keep.

# Open questions

- Where do we record the misses? `tasks/inbox.md` would work; a dedicated `briefings/B-0006-misses.md` appendix is cleaner.
- Should the table live in the DB (new `device_aliases` table) or as a JSON file extracted at build time?
