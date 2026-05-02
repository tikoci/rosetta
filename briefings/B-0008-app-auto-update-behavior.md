---
id: B-0008-app-auto-update-behavior
topic: Does RouterOS /app pull `:latest` fresh on each boot, or cache by digest?
status: open
related_tasks: []
created: 2026-05-02
last_revisited: 2026-05-02
---

# Question

When rosetta is installed via `/app/add` on RouterOS 7.22+ and the OCI image is tagged `:latest`, does the router pull a new image on every boot, or does it cache by digest and skip?

# What's grounding this

- `/app` documentation in the routeros-app-yaml skill.
- Behaviour matters because: if it caches by digest, users get stale rosetta DBs until they manually refresh; if it pulls fresh, every reboot eats bandwidth.
- We currently document that auto-update is enabled — but the actual mechanism is unverified for our case.

# Experiment

1. Install rosetta via `/app/add` with `:latest` tag.
2. Reboot the router.
3. Inspect logs / image cache to see whether the pull happened.
4. Repeat after pushing a new `:latest` to confirm the inverse.

Needs a CHR test rig — pair with quickchr.

# Open questions

- If digest-caching, do we want to switch the documented install command from `:latest` to `:vMAJOR.MINOR` (semver pinning)?
- If pull-on-boot, do we want a separate "stable channel" tag that updates less often?
