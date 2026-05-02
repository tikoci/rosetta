---
id: T-0016-shrink-makefile-to-etl
title: Shrink Makefile toward ETL only
status: ready
priority: medium
area: release
depends_on:
  - T-0013-drop-or-gate-make-release
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

Once T-0013 lands, the Makefile no longer needs to host the local release path. Trim pure `bun` passthroughs that don't add value; keep targets that orchestrate multi-step extraction and checks.
