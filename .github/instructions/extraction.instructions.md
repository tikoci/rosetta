---
description: "Routing file for extraction/data work. Follow the narrow instruction files listed here instead of growing this file again."
applyTo: "src/extract-*.ts, src/extract-*.test.ts, src/link-commands.ts"
---
# Extraction instruction map

The extraction surface now uses narrow rule files. Read the ones that match your change:

- `extractor-idempotent.instructions.md`
- `extractor-import-side-effects.instructions.md`
- `command-versions-vs-presence.instructions.md`
- `schema-roundtrip-compat.instructions.md`
- `data-source-naming-product-matrix.instructions.md`
- `skill-attribution-boundary.instructions.md`
- `github-api-auth.instructions.md`

Keep this file as a router only. Put new extraction rules in the narrow file that actually owns them.
