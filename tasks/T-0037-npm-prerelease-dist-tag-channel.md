---
id: T-0037-npm-prerelease-dist-tag-channel
title: npm prerelease/dist-tag channel (alpha/beta/rc/next) with aligned OCI tags + coverage reporting
status: in-progress
priority: high
area: release
depends_on:
  - T-0036-release-yml-docusaurus-cutover
conflicts_with:
  - T-0036-release-yml-docusaurus-cutover
validation:
  - V-db-meta
  - V-bunx-macos
  - V-bunx-linux
  - V-bunx-windows
  - V-npm-channel-tags
  - V-oci-latest-guard
  - V-changelog-gate
  - V-coverage-reported
acceptance:
  - "package.json's version is the single source of truth for channel: a prerelease identifier (e.g. 0.11.0-alpha) means non-latest; a bare version (0.11.0) means latest. No CI-side flag duplicates this."
  - "A new early release.yml step parses package.json's committed version for a -<stage> suffix and sets NPM_TAG; if present, rewrites package.json's version in-place (uncommitted, workspace-only) to MAJOR.MINOR.PATCH-<stage>.${GITHUB_RUN_NUMBER} before any preflight/publish step reads it, so repeated dispatches never collide on an already-published version without needing a git commit"
  - "inputs.version's interaction with the above is resolved and documented: since the true published version for tagged runs is computed by CI (unpredictable ahead of dispatch), inputs.version's equality check either doesn't apply to tagged runs or is repurposed — pick one and update the 'Verify npm publish access' step's logic accordingly"
  - "npm publish --tag <stage> for prerelease runs (stage parsed from the identifier: alpha/beta/rc); immediately followed by npm dist-tag add @tikoci/rosetta@<version> next so @next always resolves to the newest prerelease of any stage. Bare npm publish (no --tag, defaults to latest) unchanged for latest-channel runs."
  - "OCI image tags aligned with the npm scheme: $VERSION and sha-$SHORT_SHA always push (as today); a floating per-stage tag (:alpha/:beta/:rc) and a floating :next push for prerelease runs; the bare :latest OCI tag pushes only on non-prerelease (latest-channel) runs — this is the fix for the OCI-latest-clobber risk found in briefings/B-0014-ci-testing-qa-cleanup.md's 2026-07-08 follow-up. If this proves more complexity than it's worth, skipping Docker/GHCR entirely for prerelease runs is an accepted fallback (confirmed with the user) — full pipeline is the default plan, not a hard requirement."
  - "GitHub Release created for prerelease runs too, via gh release create --prerelease, tagged with the full run-number-suffixed version"
  - "bunx-smoke job plumbing updated to consume the actual computed (run-number-suffixed) version via a build-and-release job output, not an assumption that it equals package.json's committed value"
  - "The bump-version job's auto PATCH+1-and-commit logic is removed entirely. package.json version bumps (for every channel, including latest) become a manual/human step going forward. A new latest-only preflight gate fails the run if CHANGELOG.md lacks a '## [<pkg-version>]' heading for a bare (no-prerelease) package.json version, so a latest release can't ship without CHANGELOG promotion having happened by hand first."
  - "bun test --coverage added to release.yml, uploaded as a workflow artifact and summarized in $GITHUB_STEP_SUMMARY (numbers, not just pass/fail) — folded into this task since it's the same release.yml touch-point rather than a separate pass"
  - "README.md (install/quick-start: how to opt into @next/@alpha/@beta/@rc), MANUAL.md (release procedure rewritten for the new manual-version-bump + tag scheme), and CHANGELOG.md's 'Agentic rule' header (note prerelease runs don't promote [Unreleased]) updated"
  - "VALIDATION.md reviewed for any new blocking rows this introduces (e.g. an invariant that :latest OCI never moves on a prerelease run) and updated"
  - "Stage identifiers are validated, not accepted as arbitrary strings: package.json versions of the form MAJOR.MINOR.PATCH-<stage> or MAJOR.MINOR.PATCH-<stage>.N are accepted; <stage> is normalized/checked against the allowlist {alpha, beta, rc}; anything else (typo'd stage, unexpected prerelease shape) fails the workflow with a clear error instead of silently becoming an npm dist-tag and an OCI tag"
  - "republish_assets: true has explicit, documented semantics for prerelease versions: inputs.version must be supplied as the exact already-published version (including its run-number suffix, e.g. 0.11.0-alpha.42 — CI cannot recompute a past run's GITHUB_RUN_NUMBER); package.json is NOT rewritten in this mode; no npm dist-tag add calls happen (npm publish is already fully skipped in this mode, per the existing 'does NOT re-publish npm' input description — dist-tags follow the same rule); no floating OCI tags (:latest, :alpha/:beta/:rc, :next) are moved — only the exact-version and sha-* image tags are re-pushed, so a republish of an older run can never regress what a floating tag currently points testers at"
trigger: ""
created: 2026-07-08
---

# Body

Follow-up to a direct strawman review with the user (see
`briefings/B-0014-ci-testing-qa-cleanup.md`, "2026-07-08 follow-up" section
— read that first, it has the full reasoning and the decisions below were
made there, not re-derived here). Motivation, in the user's own words: manual
testing of rosetta *from other projects' live agent sessions* is their real
feedback loop today (benchmarking is underdeveloped and costly), but pointing
those projects at a local `~/GitHub/rosetta` checkout only tests
"working-state" code, not what `bunx @tikoci/rosetta` actually resolves to
for everyone else. They want to publish the new Docusaurus-sourced DB under
a non-default npm channel so testers can opt in via `bunx
@tikoci/rosetta@alpha` (etc.) without moving the `latest` dist-tag — which
today always gets moved, since `npm publish` in `release.yml` has no `--tag`
flag at all.

**Depends on `T-0036` landing first** — publishing any dist-tag of a DB that
was actually built by the legacy `extract-html.ts` Confluence pipeline would
defeat the entire point (testers would get the old corpus under a new label).
`conflicts_with: [T-0036]` because both change the same `release.yml` job
body; rebase this on top of `T-0036`, don't land them in the same PR unless
review is genuinely easier that way.

## Design decisions already made (2026-07-08, don't re-litigate)

- **Full pipeline runs on every dispatch, tagged or not.** Docker/GHCR
  multi-arch push, GitHub Release, and the 3-OS `bunx-smoke` matrix all run
  for alpha/beta/rc the same as for `latest`. Only the *tag selection*
  changes (see OCI acceptance bullet above). The user's own fallback if this
  proves too heavy in practice: skip Docker/GHCR for prerelease runs
  entirely — that's an acceptable later simplification, not a blocker for
  landing this task.
- **Both dist-tag shapes, not one.** Per-stage tags (`alpha`/`beta`/`rc`)
  each pin to their own stage's latest; `next` always rolls forward across
  all three. `bunx @tikoci/rosetta@next` is the "just give me whatever's
  newest in prerelease" invocation; `@alpha`/`@beta`/`@rc` are for testers
  who specifically want to stay on one maturity level.
- **`^0.11.0-alpha`-style semver ranges are not the mechanism** — confirmed
  during review that npm's caret-with-prerelease matching only spans
  prereleases sharing the exact `[major,minor,patch]` tuple as the range, so
  a semver range stops tracking new prereleases the moment a patch/minor
  bump happens. Dist-tags are the actual "follow forever" primitive; document
  this distinction explicitly wherever the channel is explained to users, so
  the README doesn't accidentally recommend the range form as if it were
  equivalent to a dist-tag.
- **No more CI-driven version bumps, for any channel.** The existing
  `bump-version` job's blind `PATCH + 1` can't reason across three
  channels and was already going to need a rewrite; simplest coherent choice
  is removing the auto-commit entirely and making every version bump
  (`latest` included) a deliberate human edit to `package.json` +
  `CHANGELOG.md`, backstopped by the new CHANGELOG-presence preflight gate
  and the existing "already published" npm preflight check (loud failure,
  not silent, if someone forgets).

## Open items intentionally left for implementation time, not resolved here

- Whether `concurrency: group: release` should stay a single global group or
  split so prerelease iteration doesn't serialize behind/block a `latest`
  cut — wasn't asked directly in the 2026-07-08 review; default to keeping
  the single group (it protects shared npm-collaborator-check state) unless
  it becomes real friction.

## 2026-07-09 — first live dispatch caught a real bug

The user bumped `package.json` to `0.11.0-alpha.0` and dispatched `Release`
via the GitHub web UI with default inputs — exactly the validation this
task was left `in-progress` waiting for. It failed at "Run tests
(fast-fail)" (run
[28987919958](https://github.com/tikoci/rosetta/actions/runs/28987919958))
despite `649 pass / 0 fail`. Root cause: `bunfig.toml` had a dormant
`[test].coverageThreshold = { lines: 0.70, functions: 0.80 }` (present since
April 2026) that had never actually been exercised in CI — `test.yml` never
ran `bun test --coverage`, so nothing tripped it until this task's own new
coverage step did, for the first time, in a real release run. Real coverage
(55.64% lines / 62.78% functions) was below the dormant threshold, so `bun
test --coverage` exited nonzero even though every test passed — directly
contradicting this task's own acceptance bullet and `VALIDATION.md`'s
`V-coverage-reported` row ("informational only, not a gate").

Fixed: removed the threshold from `bunfig.toml` (documented with a comment
explaining why, so it isn't silently reintroduced). Also hardened the
"Run tests (fast-fail)", "MCP contract tests (real DB)", and "MCP retrieval
eval (Phase 0)" steps to emit an explicit `::error::` annotation on failure
instead of relying on GitHub's generic "Process completed with exit code 1"
— the original failure gave no clue it was a coverage threshold and not an
actual test regression. See `CHANGELOG.md` `[Unreleased]` "Fixed" for the
user-facing entry.

The channel-detection, CHANGELOG-gate, and npm-publish-access preflight
steps all passed correctly in that same run before hitting this bug —
`0.11.0-alpha.0` was correctly detected as the `prerelease`/`alpha` channel.
One harmless observation: the manual `.0` suffix the user added is silently
discarded — `release.yml` always rewrites the version to
`<base>-<stage>.${GITHUB_RUN_NUMBER}` regardless of any trailing `.N` already
in the committed version, so `0.11.0-alpha` (no `.0`) would have worked
identically. Not a bug, just unnecessary — `MANUAL.md` already recommends
the no-suffix form.

Still not yet proven by a real dispatch: the extraction pipeline onward
(Docusaurus extraction, DB validation, OCI build/push, npm publish,
`bunx-smoke`) — the run never got that far. Re-dispatch after this fix to
continue validating; this task stays `in-progress` until a full green run
happens.
