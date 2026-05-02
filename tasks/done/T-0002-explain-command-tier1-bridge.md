---
id: T-0002-explain-command-tier1-bridge
title: routeros_explain_command shipped as tier-1 read-only bridge
status: done
priority: high
area: mcp
depends_on: []
conflicts_with: []
validation:
  - V-tool-registry
  - V-canonicalize
acceptance:
  - "routeros_explain_command tool exposes canonical path/verb, key=value annotations, warnings, docs, changelogs, version check"
  - "Read-only — never executes against a router"
  - "DESIGN.md command validation pipeline section describes the explain → validate → run flow"
trigger: ""
created: 2026-05-02
---

# Body

Back-fill of historical work: shipped `routeros_explain_command` as the read-only tier-1 bridge for write-shaped CLI questions. See `DESIGN.md` "Command validation pipeline".
