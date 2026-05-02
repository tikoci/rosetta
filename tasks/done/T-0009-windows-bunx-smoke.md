---
id: T-0009-windows-bunx-smoke
title: Add windows-latest to bunx-smoke matrix
status: done
priority: high
area: ci
depends_on: []
conflicts_with:
  - T-0018-bunx-freshness-check
validation:
  - V-bunx-windows
acceptance:
  - "bunx-smoke job in .github/workflows/release.yml includes windows-latest"
  - "Existing steps work cross-platform (mktemp → runner.temp; bash on Windows runner is Git Bash, fine for seq/kill -0)"
  - "First release after merge runs green on macOS, Linux, AND Windows"
  - "VALIDATION.md V-bunx-windows row flips from GAP to blocking"
trigger: ""
created: 2026-05-02
---

# Body

The user-visible v0.8.x bug class (EBUSY in replaceDbFile, readonly-WAL, temp-file pile-up at startup) hit Windows first. The existing `bunx-smoke` job — which `bunx @tikoci/rosetta@VERSION --refresh` then `--http` smoke-tests — is exactly the path those bugs traverse. The matrix just doesn't run on Windows yet.

Cross-platform tweaks needed:
- Replace any `mktemp` with `${{ runner.temp }}` or Bun-side temp creation.
- `seq 1 30` works under Git Bash on `windows-latest`.
- `kill -0`-style trap is already portable.

Conflicts with T-0018 because both edit the install path startup logic; sequence T-0009 first so Windows coverage is in place before the freshness-check work changes startup.
