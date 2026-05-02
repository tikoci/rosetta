---
id: T-0027-tui-pattern-search
title: TUI vi-style /pattern search within result set
status: ready
priority: low
area: tui
depends_on: []
conflicts_with: []
validation: []
acceptance:
  - "/<pattern> searches the current result set"
  - "n / N navigate forward / backward through matches"
  - "Match highlighted in current pager view"
  - "Browse tests cover pattern, n, N"
trigger: ""
created: 2026-05-02
---

# Body

Once a search returns 20+ pages it's tedious to re-formulate the FTS query just to find a sub-string. vi-style `/pattern` is the lightest possible affordance that solves it, and matches keyboard expectations for terminal users.
