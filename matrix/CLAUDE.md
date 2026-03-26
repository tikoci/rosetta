# MikroTik Product Matrix

Per-device hardware specs from mikrotik.com/products/matrix. Date-stamped snapshots stored in git.

See main [CLAUDE.md](../CLAUDE.md) → "Product Matrix (CSV)" under Source Details for full schema, download instructions, and column documentation.

Extraction: `bun run src/extract-devices.ts` (or `make extract-devices`). Idempotent — deletes and re-inserts all rows.