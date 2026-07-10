---
id: T-0027-tui-pattern-search
title: TUI vi-style /pattern search within result set
status: done
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

> **Closed 2026-07-10** — folded into umbrella [#27](https://github.com/tikoci/rosetta/issues/27) as part of the tasks→issues migration ([#18](https://github.com/tikoci/rosetta/issues/18)), same sequencing as T-0026: parity table and MCP surface audit first.

Once a search returns 20+ pages it's tedious to re-formulate the FTS query just to find a sub-string. vi-style `/pattern` is the lightest possible affordance that solves it, and matches keyboard expectations for terminal users.
