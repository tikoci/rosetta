---
id: T-0012-cli-flag-uniformity-test
title: CLI flag documentation parity test
status: ready
priority: medium
area: qa
depends_on: []
conflicts_with: []
validation:
  - V-cli-flag-uniformity
acceptance:
  - "src/cli-help.test.ts runs bun src/mcp.ts --help and captures stdout"
  - "Reads CLI Flags table from MANUAL.md"
  - "Asserts each --help flag appears in the table and vice versa"
  - "Allows an INTENTIONAL_OMISSIONS constant for hidden/internal flags"
  - "Wired into .github/workflows/test.yml"
  - "VALIDATION.md V-cli-flag-uniformity flips from GAP to blocking"
trigger: ""
created: 2026-05-02
---

# Body

`MANUAL.md` has a flag table; `mcp.ts` has a `--help` dump. They drift silently. This is the cheapest possible fix for the user's "CLI args are confusing/uneven" complaint — once the diff is enforced, a follow-up task can rationalize the flags themselves knowing the docs and code will stay in sync.
