---
id: T-0013-drop-or-gate-make-release
title: Drop or gate local `make release`
status: done
priority: high
area: release
depends_on: []
conflicts_with:
  - T-0016-shrink-makefile-to-etl
validation:
  - V-release-structure
acceptance:
  - "Decision recorded: delete local `release` target OR gate behind ALLOW_LOCAL_RELEASE=1"
  - "DESIGN.md, CONTRIBUTING.md, CLAUDE.md updated if behaviour changes"
  - "src/release.test.ts updated for new Makefile expectations"
  - "CHANGELOG [Unreleased] entry added"
trigger: ""
created: 2026-05-02
---

# Body

Preferred published release path is the GitHub Actions `Release` workflow. Local `make release` is a parallel path that risks divergence. Either delete it or gate it behind `ALLOW_LOCAL_RELEASE=1` so it can't be invoked accidentally.

Conflicts with T-0016 because both edit the same Makefile region; sequence one then the other.
