---
id: T-0016-shrink-makefile-to-etl
title: Shrink Makefile toward ETL only
status: ready
priority: low
area: release
depends_on: []
conflicts_with: []
validation:
  - V-release-structure
acceptance:
  - "Pure `bun` delegations removed if local release path is gone"
  - "Extraction/check orchestration kept where make adds value"
  - "CONTRIBUTING.md, CLAUDE.md updated in same change"
  - "src/release.test.ts still passes"
trigger: ""
created: 2026-05-02
---

# Body

T-0013 already removed `make release`, `make build-release`, and `make bump-version`. The Makefile is now ETL + dev checks only. Remaining scope (if any): trim additional pure `bun` passthroughs that add no orchestration value. Low priority — the current state is already clean.
