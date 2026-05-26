---
id: T-0030-self-supervised-eval-release-ci
title: Wire self-supervised retrieval eval into release CI
status: done
priority: medium
area: qa
depends_on: []
conflicts_with:
  # Merge-coordination conflict: both tasks edit release.yml CI gating semantics in the same area
  # (this task introduces a new self-supervised step as non-blocking while T-0029 flips blocking behavior).
  - T-0029-flip-contract-eval-blocking
validation:
  - V-retrieval-self
acceptance:
  - "release.yml runs `bun run src/eval/self-supervised.ts` against the freshly built full DB (all 46 versions)"
  - "The result is surfaced in the workflow summary and starts non-blocking on first landing"
  - "VALIDATION.md V-retrieval-self flips from GAP to non-blocking with the exact proving step"
trigger: ""
created: 2026-05-02
---

# Body

The validation matrix currently claims the self-supervised retrieval eval is exercised in release CI, but the workflow only runs the hand-curated Phase 0 eval. This task closes that documentation/reality gap by wiring the Phase 1 eval into the post-extraction release checks and updating the matrix to match the real proving step.
