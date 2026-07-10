---
id: T-0025-current-versions-enrichment
title: routeros_current_versions enrichment with download URLs
status: done
priority: low
area: mcp
depends_on: []
conflicts_with: []
validation:
  - V-tool-shapes
acceptance:
  - "routeros_current_versions accepts optional additional_data=true"
  - "Returns MikroTik download URLs and tikoci/restraml refs when set"
  - "Community-sourced data clearly marked vs official"
  - "Tool description updated"
trigger: ""
created: 2026-05-02
---

# Body

> **Closed 2026-07-10** — folded into the `briefings/B-0011` tool-surface audit and umbrella [#27](https://github.com/tikoci/rosetta/issues/27) as part of the tasks→issues migration ([#18](https://github.com/tikoci/rosetta/issues/18)). Enriching one tool piecemeal pre-empts the surface-wide consolidation review; resurfaces as its own issue if the audit says so.

The current tool just returns version strings per channel. Adding download URLs and restraml refs as an opt-in `additional_data=true` field gives agents a single place to find both "what's current" and "where to get it" without making the default response heavier.
