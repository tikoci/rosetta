---
id: T-0017-extractor-import-side-effects
title: Convert remaining extractor entrypoints to safe import pattern
status: done
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

> **Closed 2026-07-10** — migrated to [#19](https://github.com/tikoci/rosetta/issues/19) as part of the tasks→issues migration ([#18](https://github.com/tikoci/rosetta/issues/18)). Note: this file's list of already-safe extractors was found inaccurate on 2026-07-10 (top-level db imports exist in files listed as safe, including the new `extract-docusaurus.ts`) — the issue starts with a re-audit.

Several extractors still import `db.ts` at module evaluation time, which means a future pure-parser test can accidentally open the real DB before `DB_PATH=:memory:` is set. The safe pattern is already in place in `extract-html.ts`, `extract-dude.ts`, `extract-schema.ts`, `extract-test-results.ts`, and `extract-videos.ts` — propagate it to the rest.
