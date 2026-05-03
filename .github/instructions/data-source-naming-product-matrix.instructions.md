---
description: "Product names differ across the matrix CSV, product codes, slugs, and docs. Matching stays heuristic and alias coverage is iterative."
applyTo: "src/extract-devices.ts, src/extract-test-results.ts, src/query.ts, DESIGN.md, MANUAL.md, README.md"
---
# Product naming across sources

Do not assume MikroTik product identity is canonically named in one place.

- Matrix CSV names, product codes, page slugs, and doc references all vary.
- The search cascade (exact → LIKE → FTS/prefix → heuristics) is intentional.
- A false-empty lookup is often an alias gap, not proof the device is absent.
- Record stubborn misses in the device-alias briefing/task flow rather than hard-coding ad hoc guesses everywhere.
