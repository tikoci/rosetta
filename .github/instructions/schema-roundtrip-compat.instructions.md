---
description: "extract-schema.ts regenerates commands and command_versions from schema_nodes so existing consumers keep working."
applyTo: "src/extract-schema.ts, src/schema-roundtrip.test.ts, src/query.ts, src/browse.ts, src/link-commands.ts"
---
# Schema round-trip compatibility

`schema_nodes` is the richer source of truth, but existing callers still read `commands` and `command_versions`.

- Keep `extract-schema.ts` regenerating those legacy tables from the enriched schema.
- Favor zero-downstream-churn migrations unless there is a strong reason to break consumers.
- If the regenerated shape changes, update `src/schema-roundtrip.test.ts` and every downstream caller in the same change.
