---
id: T-0004-db-wipe-guard
title: DB-wipe guard and extractor test isolation
status: done
priority: high
area: qa
depends_on: []
conflicts_with: []
validation:
  - V-db-wipe-guard
  - V-db-min-content
acceptance:
  - "query.test.ts guards DB_PATH=:memory: at module load"
  - "Release CI validates minimum DB content before publishing"
  - "Safe extractor import patterns documented in .github/instructions/extraction.instructions.md"
trigger: ""
created: 2026-05-02
---

# Body

Back-fill: shipped after the v0.7.6 bad DB release. `query.test.ts` guards the in-memory DB path, release CI validates minimum DB content (≥200 pages, ≥1000 commands, ≥100 devices, ≥1000 properties), and safe extractor import patterns are documented for future extractors.
