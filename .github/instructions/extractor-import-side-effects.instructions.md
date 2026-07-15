---
description: "Every extractor entrypoint must run its side effects only under `import.meta.main`. Extractor tests must not open the real DB at import time either."
applyTo: "src/extract-*.ts, src/extract-*.test.ts"
---
# Extractor import side effects

There are two separate hazards here, and both must be closed for every `src/extract-*.ts`
file (audited 2026-07-14, issue #19):

1. **No unguarded execution at module scope.** Every extractor's side-effecting logic
   (DB writes, file/network reads, subprocess spawns) must live inside a `main()` function
   called only under `if (import.meta.main) { ... }`. Pure helpers, type declarations, and
   argument-shape parsing that has no I/O may stay at module scope. Without this guard,
   merely `import`-ing the file — e.g. a future test reusing a parser helper — runs the
   entire pipeline unconditionally. This was the actual gap found in the 2026-07-14 audit:
   `extract-commands.ts`, `extract-devices.ts`, `extract-properties.ts`, and
   `extract-all-versions.ts` had no `import.meta.main` guard at all. All extractors now
   have one.

2. **Top-level `db.ts` import still opens a connection.** `db.ts` does
   `export const db = new sqlite(DB_PATH)` at module scope, so any extractor that does
   `import { db, initDb } from "./db.ts"` at the top of the file opens a DB connection
   the moment it's imported — even with the `import.meta.main` guard in place, since the
   guard only defers *execution*, not the import itself. Most extractors keep this
   top-level import (it's harmless as long as `DB_PATH` is set correctly before import).
   For tests, that means:
   - Set `process.env.DB_PATH = ':memory:'` before importing the extractor.
   - Use dynamic `await import(...)` so Bun does not hoist the real-DB import before the
     env var assignment.
   - `extract-schema.ts` and `extract-test-results.ts` go further and dynamic-import
     `db.ts` itself lazily inside `main()`, so importing them touches no DB at all — that's
     the strictest form and is preferred for new extractors, but not required retroactively.

`src/query.test.ts` carries a singleton guard (`V-db-wipe-guard` in `VALIDATION.md`) that
fails loudly if any test file leaves the `db` singleton pointed at a non-`:memory:` path —
treat a failure there as a real regression in one of the two patterns above, not test flakiness.
