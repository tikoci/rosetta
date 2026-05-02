---
id: T-0017-extractor-import-side-effects
title: Convert remaining extractor entrypoints to safe import pattern
status: ready
priority: medium
area: extraction
depends_on: []
conflicts_with: []
validation:
  - V-db-wipe-guard
acceptance:
  - "Every src/extract-*.ts uses the safe pattern: helpers exported safely, DB imports inside main(), execution guarded by `if (import.meta.main) await main()`"
  - "Pure-parser tests can import these modules without opening the real DB"
  - ".github/instructions/extraction.instructions.md updated if the pattern changes"
trigger: ""
created: 2026-05-02
---

# Body

Several extractors still import `db.ts` at module evaluation time, which means a future pure-parser test can accidentally open the real DB before `DB_PATH=:memory:` is set. The safe pattern is already in place in `extract-html.ts`, `extract-dude.ts`, `extract-schema.ts`, `extract-test-results.ts`, and `extract-videos.ts` — propagate it to the rest.
