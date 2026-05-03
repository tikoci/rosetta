# MikroTik Product Matrix

Per-device hardware specs from mikrotik.com/products/matrix. Date-stamped snapshots stored in git.

See [DESIGN.md](../DESIGN.md) for product-matrix provenance and naming caveats, and [MANUAL.md](../MANUAL.md) for the re-extraction workflow.

Extraction: `bun run src/extract-devices.ts` (or `make extract-devices`). Idempotent — deletes and re-inserts all rows.
