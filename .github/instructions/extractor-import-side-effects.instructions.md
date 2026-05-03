---
description: "Extractor tests must not open the real DB at import time. Use the safe DB_PATH + dynamic-import pattern for at-risk entrypoints."
applyTo: "src/extract-*.ts, src/extract-*.test.ts"
---
# Extractor import side effects

Some extractor entrypoints still import `db.ts` at module evaluation time. For those files:

- In tests, set `process.env.DB_PATH = ':memory:'` before importing the extractor.
- Use dynamic `await import(...)` so Bun does not hoist the real-DB import before the env var assignment.
- Prefer moving new extractors toward the safe pattern where importing the module does not touch the DB until `main()` runs.
