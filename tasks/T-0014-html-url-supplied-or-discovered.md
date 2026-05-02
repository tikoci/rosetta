---
id: T-0014-html-url-supplied-or-discovered
title: Make `html_url` intentionally supplied or auto-discovered
status: ready
priority: medium
area: release
depends_on: []
conflicts_with: []
validation: []
acceptance:
  - "Decision recorded: remove default html_url (force dispatcher to supply) OR implement latest-export discovery"
  - "release.yml workflow updated"
  - "If discovery path: a durable index source identified and documented"
trigger: ""
created: 2026-05-02
---

# Body

The default Seafile direct link in `release.yml` can rotate. Either:
1. Remove the default so dispatchers must supply the export URL each run, or
2. Implement latest-export discovery from a durable index.

Option 1 is simpler and recoverable; option 2 is friendlier but needs a stable upstream signal.
