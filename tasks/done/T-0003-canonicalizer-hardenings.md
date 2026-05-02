---
id: T-0003-canonicalizer-hardenings
title: Canonicalizer hardenings H4/H6/H7/H8 shipped
status: done
priority: medium
area: mcp
depends_on: []
conflicts_with: []
validation:
  - V-canonicalize
acceptance:
  - "H4/H6/H7/H8 anchor tests in src/canonicalize.fuzz.test.ts pass"
  - "Pluggable isVerb resolver via CanonicalizeOptions"
  - "extractMentions() exported for navigation-only path references"
trigger: ""
created: 2026-05-02
---

# Body

Back-fill of historical work: hardened the pure RouterOS CLI canonicalizer (`src/canonicalize.ts`) per issue #5 H4/H6/H7/H8 anchor tests. H1/H2/H3/H5 remain tracked through the command validation/enrichment work (see briefings).
