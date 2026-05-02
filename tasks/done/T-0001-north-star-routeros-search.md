---
id: T-0001-north-star-routeros-search
title: North Star unified routeros_search shipped
status: done
priority: high
area: mcp
depends_on: []
conflicts_with: []
validation:
  - V-tool-registry
  - V-tool-shapes
acceptance:
  - "Unified routeros_search runs classifier + parallel side queries"
  - "Returns pages + related (command_node, properties, devices, callouts, videos, changelogs, skills, glossary) + next_steps"
  - "Standalone callouts/videos tools folded into related block"
  - "DESIGN.md North Star section documents the shape"
trigger: ""
created: 2026-05-02
---

# Body

Back-fill of historical work: the unified `routeros_search` tool, classifier (`src/classify.ts`), `related` buckets, and smart `get_page()` TOC mode. Folded the prior standalone `routeros_search_callouts` and `routeros_search_videos` tools into the `related` block. See `DESIGN.md` "North Star Architecture" for the full rationale.
