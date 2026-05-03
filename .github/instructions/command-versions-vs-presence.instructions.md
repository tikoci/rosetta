---
description: "command_versions keeps the full version history; schema_node_presence is the release-pruned active-head view."
applyTo: "src/extract-all-versions.ts, src/extract-schema.ts, src/gc-versions.ts, src/query.ts, src/db.ts, DESIGN.md, MANUAL.md"
---
# `command_versions` vs `schema_node_presence`

These tables serve different purposes:

- `command_versions` keeps the full extracted command history across all versions.
- `schema_node_presence` is the enriched-schema presence table that release GC prunes to active channel heads only.

Do not collapse them into one concept in code or docs. Full history and release retention are both intentional.
