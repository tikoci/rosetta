---
description: "Every extractor entrypoint must run its side effects only under `import.meta.main`. Top-level `db.ts` imports still open a real DB connection, so tests must import extractors safely."
applyTo: "src/extract-*.ts, src/extract-*.test.ts"
---
# Extractor import side effects

There are two separate hazards here. Hazard 1 must be closed for every `src/extract-*.ts`
file — and now is (audited 2026-07-14, issue #19). Hazard 2 is not closed for most
extractors and isn't required to be; it's mitigated in tests by the import pattern
described below.

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
   top-level import; it opens the real on-disk DB unless the importer set `DB_PATH` first.
   That's correct for normal CLI use (a real DB is exactly what you want), but it's a trap
   for any test or script that imports the module without first setting `DB_PATH`. This is
   not itself a bug to fix — it's the reason the test-import discipline below exists.
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

That runtime guard only fires on the *unlucky file order* where the offending file loads
`db.ts` first, so a static db.ts-reaching import can sit latent through many green runs and
present as a CI flake (#98). `src/source-hygiene.test.ts` (`V-test-db-import-static-guard`)
closes that gap **structurally**: it scans every `*.test.ts` that sets `process.env.DB_PATH`
and fails if any statically (value-)imports a module transitively reaching `db.ts`, regardless
of run order. Statement-level `import type … from` is erased by the transpiler and stays
allowed (e.g. `extract-hardware-catalog.test.ts`); only value imports load `db.ts`. So the
dynamic-import discipline above is now enforced, not merely documented — add a new
`DB_PATH`-setting test the wrong way and this test rejects it at author time.
