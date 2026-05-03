---
description: "Extraction scripts rebuild their tables deterministically. Delete or drop first; do not mutate incremental state in place."
applyTo: "src/extract-*.ts, src/link-commands.ts, MANUAL.md, .github/workflows/release.yml"
---
# Extractors are idempotent

Each extractor should be safe to rerun:

1. Delete existing rows (or drop/recreate tables) in the correct FK order.
2. Rebuild from the current source inputs.
3. Let the DB-defined FTS triggers repopulate search indexes.

Do not depend on local-only repair scripts or hand-edited incremental state.
