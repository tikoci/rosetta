---
id: T-0016-shrink-makefile-to-etl
title: Shrink Makefile toward ETL only
status: done
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

> **Closed 2026-07-10** — won't-fix, as part of the tasks→issues migration ([#18](https://github.com/tikoci/rosetta/issues/18)). The bun-scripts-for-JS-lifecycle / Makefile-for-ETL-orchestration split is deliberate and learnable; further shrinking buys nothing. The split rule is documented in `CONTRIBUTING.md`.

T-0013 already removed `make release`, `make build-release`, and `make bump-version`. The Makefile is now ETL + dev checks only. Remaining scope (if any): trim additional pure `bun` passthroughs that add no orchestration value. Low priority — the current state is already clean.
