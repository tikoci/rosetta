---
id: T-0015-promote-changelog-into-release-notes
title: Promote CHANGELOG.md into release notes
status: done
priority: medium
area: release
depends_on: []
conflicts_with: []
validation:
  - V-release-structure
acceptance:
  - "Release workflow uses CHANGELOG.md [Unreleased] block as GitHub Release body"
  - "[Unreleased] is promoted to a dated VERSION heading and committed in the same bump-version path"
  - "Skipped in republish_assets mode (npm version is immutable)"
  - "Test coverage added for the promotion logic"
trigger: ""
created: 2026-05-02
---

# Body

> **Closed 2026-07-10** — migrated to [#22](https://github.com/tikoci/rosetta/issues/22) as part of the tasks→issues migration ([#18](https://github.com/tikoci/rosetta/issues/18)). The goal survives but this spec predates `T-0037`'s removal of CI-driven CHANGELOG promotion — the spec is being reworked on the issue.

Today the `bump-version` job auto-promotes `[Unreleased]` → `[VERSION] — DATE` and prepends a fresh `[Unreleased]` skeleton. But the release body itself is still hand-written. Lift the `[Unreleased]` block into the GitHub Release body so the changelog is the single source of truth for what shipped.
