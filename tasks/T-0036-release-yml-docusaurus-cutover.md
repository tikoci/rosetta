---
id: T-0036-release-yml-docusaurus-cutover
title: Cut release.yml over to extract-docusaurus.ts, retire html_url
status: ready
priority: high
area: release
depends_on: []
conflicts_with:
  - T-0037-npm-prerelease-dist-tag-channel
  - T-0014-html-url-supplied-or-discovered
validation:
  - V-db-min-content
  - V-docusaurus-docs-count
acceptance:
  - "release.yml no longer has an html_url input; the 'Download HTML export', 'Extract HTML and locate ROS directory', 'Extract HTML pages', and 'Extract properties' steps are removed"
  - "A new step runs the live Docusaurus extractor (bun run src/extract-docusaurus.ts, same live-network risk class as today's Confluence download) in their place, populating pages/sections/properties/callouts"
  - "That step passes --check-counts (and --strict, per T-0035's own live smoke-test invocation) so V-docusaurus-docs-count is proven on every release run, not just manually — VALIDATION.md's row updated from 'non-blocking (manual/local run only)' with its stale 'Tracked by: T-0035' pointer replaced by this task"
  - "extract-commands/extract-all-versions, extract-devices, extract-test-results, extract-changelogs, extract-dude-from-cache, extract-skills, link-commands steps are unchanged (they already don't depend on html_url)"
  - "The 'Validate DB has expected content' floors (pages>=200, commands>=1000, devices>=100, properties>=1000) are reviewed against real Docusaurus-corpus numbers (T-0035 measured 360 pages / 4,501 properties / 938 callouts at full scale) and adjusted if a floor no longer makes sense for the new source"
  - "extract-legacy-confluence remains a local-only Makefile target for historical-DB rebuilds; nothing in release.yml references it"
  - "src/release.test.ts updated for the new pipeline shape — specifically: 'has required inputs' (currently asserts html_url: is present, ~line 409) now asserts it is absent; 'tolerates Confluence zip with absolute path root entry' (~line 415) is removed (that unzip-exit-2 tolerance no longer applies to release.yml — it's exercised only via the local extract-legacy-confluence path, which isn't covered by this workflow test file); 'runs extraction pipeline' (~line 421) asserts extract-docusaurus.ts instead of extract-html.ts/extract-properties.ts; 'runs early quality gate before downloading HTML export' (~line 457) and 'preflights npm publish access before release side effects' (~line 471) both re-anchor off the new extraction step's name instead of the removed 'Download HTML export' step. A new test asserts the release.yml extraction step passes --check-counts --strict."
  - "MANUAL.md's release procedure, DESIGN.md, and CHANGELOG.md updated to describe the new extraction step and the dropped html_url input"
  - "Validated via a real workflow_dispatch run (can be the same run that ships the first 0.11.0 build under T-0037, or an earlier standalone dispatch) — not just local make extract, since CI's environment (network egress, sqlite3 CLI, secrets) differs from a laptop"
trigger: ""
created: 2026-07-08
---

# Body

`T-0035` (Docusaurus `/docs` prose extractor) shipped 2026-07-07 and
deliberately left `release.yml` untouched — its own closing note: "flipping
the actual release pipeline stays a separate, later decision, not bundled
into this task." `briefings/B-0012-docusaurus-manual-migration.md` "Next
steps" makes the same call explicit: "No new rosetta release ships until
something solid on the Docusaurus migration lands; that's a deliberate
choice, not a stalled step." The Docusaurus extractor is now solid (360/360
pages live-verified, zero fetch errors, exact `llms.txt` count match,
`PRAGMA foreign_key_check` clean) — this task is that deferred flip.

Today `release.yml` (`.github/workflows/release.yml` lines 186–189) still
calls `bun run src/extract-html.ts "$ROS_DIR"` and
`bun run src/extract-properties.ts "$ROS_DIR"` against a live-downloaded
Confluence HTML export (`inputs.html_url`). `Makefile`'s `extract`/
`extract-full` targets, `DESIGN.md`, and `CHANGELOG.md [Unreleased]` already
treat `extract-docusaurus.ts` as the default prose+properties+callouts
source, with the HTML pair demoted to a manual-only `extract-legacy-
confluence` path for rebuilding historical pre-migration DBs. `release.yml`
is the one place that never got the memo — meaning any release cut today,
under any dist-tag, would still ship the old Confluence-sourced content.

Discovered and scoped in `briefings/B-0014-ci-testing-qa-cleanup.md`
("2026-07-08 follow-up") while reviewing a strawman for an npm prerelease
channel (`T-0037`) — that work is pointless until this lands, since there'd
be no CI path that builds a Docusaurus-sourced DB to publish. `npm view
@tikoci/rosetta dist-tags` confirms `latest` is still `0.10.0`, the
deliberate "final Confluence corpus" release (commit `65fc229`); `0.11.0`
sits unreleased in `package.json`, staged for exactly this cutover.

## Notes for whoever picks this up

- `extract-docusaurus.ts --check-counts --strict` was already exercised live
  in `T-0035`'s own smoke test — reuse that exact invocation shape in the
  new release.yml step rather than inventing a new flag combination.
- Mind the "Resolve release version" step and the "Extract HTML and locate
  ROS directory" step's `steps.locate.outputs.ros_dir` output — nothing else
  in the workflow reads `ros_dir` outside the two steps being removed, but
  double-check before deleting.
- `docs_date` input (used only in the GitHub Release notes body) has no
  extraction-pipeline purpose either way; leave it as-is unless `T-0037`'s
  release-notes rework changes that.
- This task is listed `conflicts_with: [T-0037]` because both touch
  `release.yml`'s job body — land this one first, then rebase `T-0037` on
  top, per B-0014's agreed sequencing.
