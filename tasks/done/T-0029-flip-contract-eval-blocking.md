---
id: T-0029-flip-contract-eval-blocking
title: Promote contract test + retrieval eval to blocking in release.yml
status: done
priority: medium
area: ci
depends_on:
  - T-0028-make-verify-target
conflicts_with: []
validation:
  - V-tool-shapes
  - V-tool-budget
  - V-retrieval-floor
acceptance:
  - "Two `continue-on-error: true` lines removed from .github/workflows/release.yml (mcp-contract Block C, retrieval eval)"
  - "VALIDATION.md V-tool-shapes, V-tool-budget, V-retrieval-floor flip from non-blocking to blocking"
  - "Next release run is green or surfaces a real regression that gets fixed in the same window"
trigger: ""
created: 2026-05-02
---

# Body

Workflow comments at lines 191–207 of `.github/workflows/release.yml` already say "flip to blocking after one green run." Once `make verify` (T-0028) lets us run the same checks locally before push, flip them. If red is real signal, fix it — don't paper over it.
