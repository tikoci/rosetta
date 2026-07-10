---
id: T-0018-bunx-freshness-check
title: bunx freshness check + ROSETTA_OFFLINE
status: done
priority: medium
area: install
depends_on:
  - T-0009-windows-bunx-smoke
conflicts_with:
  - T-0009-windows-bunx-smoke
validation:
  - V-cross-version-bunx
acceptance:
  - "After first install, periodic freshness check probes for newer DB releases"
  - "Cache check timestamp in db_meta.last_check_at"
  - "Honors ROSETTA_OFFLINE=1 environment variable"
  - "User-visible prompt to run --refresh when stale (DB-only releases)"
  - "MANUAL.md documents the new behaviour"
trigger: ""
created: 2026-05-02
---

# Body

> **Closed 2026-07-10** — migrated to [#23](https://github.com/tikoci/rosetta/issues/23) as part of the tasks→issues migration ([#18](https://github.com/tikoci/rosetta/issues/18)). This spec predates npm dist-tag channels (`T-0037`); the freshness check must become channel-aware, so the issue is blocked until T-0037 reaches a full green run.

Sidecar-lock and validated-download path are in place. Remaining gap: nothing nudges users to refresh after DB-only releases — the package version may be unchanged but the DB on disk goes stale silently.

Sequenced after T-0009 because both touch the install path startup logic; doing Windows smoke first means the freshness change lands with cross-platform coverage already in place.
