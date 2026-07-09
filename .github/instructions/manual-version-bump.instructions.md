---
description: "Version bumps and CHANGELOG promotion are a manual, human step for every release channel. CI must not reintroduce an auto-bump/auto-commit job."
applyTo: ".github/workflows/release.yml, package.json, CHANGELOG.md, MANUAL.md"
---
# Manual version bump, on every channel

`release.yml` has no job that bumps `package.json`'s version or promotes `CHANGELOG.md`'s `[Unreleased]` heading — the old `bump-version` job (blind `PATCH + 1`, auto-committed to `main`) was removed because it couldn't reason across the `latest`/`alpha`/`beta`/`rc` channels.

- Do not add back a CI step that writes `package.json`'s `version` field or edits `CHANGELOG.md` and commits/pushes the result. Every version bump, on every channel, is a deliberate human edit before dispatching `Release`.
- The workspace-only rewrite in "Determine npm release channel" (appending `$GITHUB_RUN_NUMBER` to a prerelease version) is not an exception to this rule — it is never committed, exists only for the duration of the run, and does not touch `CHANGELOG.md`.
- The backstops for a forgotten bump are the existing npm preflight ("already published" check) and the "Verify CHANGELOG promotion for latest-channel release" step — both fail loudly. Keep failures loud; do not paper over a missing bump by falling back to auto-generating one in CI.
