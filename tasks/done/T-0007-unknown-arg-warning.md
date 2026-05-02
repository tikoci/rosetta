---
id: T-0007-unknown-arg-warning
title: "Looks like a command, but args not found" warning
status: done
priority: medium
area: mcp
depends_on: []
conflicts_with: []
validation:
  - V-tool-shapes
acceptance:
  - "routeros_explain_command emits unknown-arg warning when path exists but argument is unknown"
  - "Response no longer claims wrong command — emits typed warning instead"
trigger: ""
created: 2026-05-02
---

# Body

Back-fill: shipped via `routeros_explain_command`'s `unknown-arg` warning in `src/query.ts`. The path-exists-but-arg-unknown response is now a typed warning instead of a wrong-command claim.
