---
id: T-0005-version-gc
title: Version GC for schema_node_presence
status: done
priority: medium
area: extraction
depends_on: []
conflicts_with: []
validation:
  - V-db-min-content
acceptance:
  - "make gc-versions prunes schema_node_presence to active channel heads"
  - "command_versions and changelogs retain full history"
  - "Release pipeline runs gc-versions step"
trigger: ""
created: 2026-05-02
---

# Body

Back-fill: release builds prune `schema_node_presence` to active channel heads (stable, long-term, testing, development) while preserving full `command_versions` and changelog history. `src/gc-versions.ts` provides `--dry-run` and `--verbose` modes plus a conservative no-delete fallback if channel heads cannot be computed.
