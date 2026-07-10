---
id: B-0014-ci-testing-qa-cleanup
topic: CI is release-workflow-locked, not PR/main-gated — QA cleanup plan before scaling B-0012 testing
status: open
related_tasks: []
created: 2026-07-07
last_revisited: 2026-07-07
---

# Question

Can we test PR-sized changes — starting with #13's Docusaurus prose extractor —
with real confidence using GitHub Actions, without running an actual Release
(live Confluence HTML download, multi-arch Docker build/push, immutable npm
publish)? And more broadly: is rosetta's CI actually proving everything
`VALIDATION.md` claims it proves, on every push/PR, or only once in a while
during a release?

Session note: this briefing's investigation also surfaced that local `main`
had 2 unpushed commits (`bf6916a`, `6c26323`) that were a stale
pre-reconciliation snapshot of exactly what PR #13 later shipped (verified via
full diff — zero unique content lost, confirmed against PR #13's own review
history where the same version-bump conflict was resolved in-branch). Reset
local `main` to `origin/main` (`c63f423`) before starting this review. Not a
CI topic, noted here only for provenance.

## What's grounding this

- `.github/workflows/test.yml` and `.github/workflows/release.yml` (full read).
- `VALIDATION.md` (full read) — the existing, honest blocking/non-blocking/GAP
  inventory. This briefing doesn't replace it; it explains *why* so many rows
  say "release.yml" in the `Proven by` column.
- `src/eval/retrieval.ts` and `src/eval/self-supervised.ts` source — confirmed
  exact regression-detection and exit-code mechanics.
- Local `bun test`: **637 pass, 15 skip, 5 todo, 0 fail**, 21 files, 6.24s.
- `Makefile` (`verify`, `eval`, `eval-self`, `extract-docusaurus-from-cache`,
  `extract-docusaurus-check-counts` targets).
- `src/paths.ts` dev-mode DB resolution.
- PR #13 review thread (`gh pr view 13`) — confirms all CodeRabbit/Copilot/
  CodeQL findings were verified and fixed in-branch (`1a0fda2`, `0f4beb6`),
  and a concurrent `main` 0.10.0 release conflict was caught and resolved
  correctly before merge.
- `gh api repos/tikoci/rosetta/branches/main/protection` → 404, confirmed
  `main` has no branch protection configured today.
- `briefings/B-0010-mcp-eval-phases-3plus.md` — adjacent but different axis
  (eval *sophistication*, not CI *wiring*).

## Current state: two workflows, one structural gap

### `test.yml` — the actual PR/push gate

Triggers: `push` to `main`, `pull_request` to `main`, bare `workflow_dispatch`
(zero inputs — reruns the identical fixed job, can't target a file, a DB
variant, or a test class).

Runs: MCP registry metadata validation → typecheck → download the **latest
published** `ros-help.db` → stdio MCP integration test against that published
DB → `bun test` (fixture-only, in-memory DB per file) → lint → an AI-findings
probe that is a documented no-op today.

`main` has no required status checks configured (confirmed via API), so even
this gate is advisory, not enforced — noted for completeness, not proposing
to change it given your explicit "don't want to mess with gates/branch
protection" note.

### `release.yml` — `workflow_dispatch`-only, Confluence-HTML-specific inputs

Everything else lives here, entangled with a single heavyweight, partly
irreversible pipeline: live HTML download → 9-step extraction → Docker
buildx multi-arch push to two registries → GitHub Release → **immutable**
npm publish → auto version-bump commit pushed straight to `main`. Per
`VALIDATION.md`, proven *only* inside this pipeline:

| Invariant | Status per VALIDATION.md | Only runs in |
|---|---|---|
| V-tool-shapes / V-tool-budget (MCP contract Blocks B/C, real DB) | blocking | release.yml post-extraction |
| V-retrieval-floor (Phase 0 golden-set eval) | blocking | release.yml |
| V-retrieval-self (Phase 1 self-supervised eval) | **non-blocking** | release.yml |
| V-db-min-content (page/command/device/property floors) | blocking | release.yml |
| V-db-meta (provenance stamping) | blocking | release.yml |
| V-bunx-macos/linux/windows | blocking | release.yml (`bunx-smoke` matrix) |
| V-docusaurus-docs-count (new in #13) | **"non-blocking (manual/local run only)... not run in bun test/CI yet"** — VALIDATION.md's own words | nowhere in CI |

That last row is the direct B-0012 testing gap: the one new invariant PR #13
itself introduced for the Docusaurus extractor is explicitly not wired into
any CI path yet.

The practical effect: roughly 7 of the ~26 `VALIDATION.md` rows are provable
only by running a pipeline that downloads a live Confluence export, publishes
packages, and pushes container images. There is no lightweight way to ask
"would release.yml's quality gates pass on this PR" without doing all of
that — which is exactly why nobody runs them for a normal PR, and why they
only get exercised (and only get *noticed*) during a real release.

## The regression case study, mechanically

`src/eval/self-supervised.ts` really does call `process.exit(1)` when a
per-strategy `hit@10` (or overall metric) regresses beyond its 5pp tolerance
— this is a real, working gate at the script level. But the `release.yml`
step wraps it in `continue-on-error: true` and re-exits the captured status,
so GitHub Actions shows a yellow warning instead of a red failure, and the
job — and the release — proceeds regardless. So "FAIL regression: property
hit@10 regressed -10.0pp (was 88.3%, now 78.3%)" was real, internally
detected, and then deliberately suppressed at the workflow level, on the last
0.10.x (pre-Docusaurus) release. That non-blocking choice was a reasonable
original call ("first landing, earn trust before promoting" — both the code
comment and `VALIDATION.md` say this explicitly), but there's no owner or
cadence for revisiting the promotion, and no persisted trend — each run's
numbers live only in that run's ephemeral `$GITHUB_STEP_SUMMARY`.

## Test suite health check (the "too many skips" instinct — checked, not assumed)

637 pass / 15 skip / 5 todo / 0 fail, 21 files, ~6s locally. Breaking that
down instead of trusting the gut feeling:

- All 15 skips are `describe.skipIf(...)` gated on **real-DB presence** — 3
  call sites total (`mcp-stdio-client.test.ts`, `browse-parity.test.ts`,
  `mcp-contract.test.ts`), each with a printed skip reason. This is an
  intentional opt-in-for-real-DB pattern, not silently-disabled tests.
- All 5 todos live in `canonicalize.fuzz.test.ts`, explicitly commented as
  "known-bad behaviour the audit recommended fixing" — a real, visible
  backlog, not a mystery skip.

Conclusion: the suite itself is disciplined. The actual gap isn't "too many
skips" — it's "too much of what `VALIDATION.md` calls blocking only blocks
inside a workflow nobody runs except for an actual release." Coverage data
(next section) is still worth collecting before any skip-focused review, per
your instinct, but go in expecting the skip count itself to be mostly fine.

## No coverage reporting today

`bun test --coverage` / `--coverage-reporter=lcov` is a native Bun flag
(confirmed via `bun test --help`); zero references to "coverage" exist in any
workflow or doc in this repo. This is the cheapest, lowest-risk first move —
it produces the data that should drive any future "are we under-testing
X" review, without touching workflow structure or gating.

## Options considered

**A. Rich `workflow_dispatch` on `test.yml`.** Add inputs like
`test_scope: unit|contract|eval-golden|eval-self|docusaurus-count|all` and
`db_source: fixture|published|local-build`, maybe a `test_file` passthrough.
Matches the "single point of contact for any class of test" shape you
described wanting (you cited centrs/quickchr as having richer dispatch
matrices — not independently verified this session, worth a quick look at
those two workflow files before copying a pattern). Cons: `db_source:
local-build` needs an extraction step at dispatch time (network + minutes);
since there's no branch protection today, a dispatch-only addition is
low-risk either way.

**B. Split release.yml's test-only steps into a reusable `workflow_call`
target.** A `qa.yml` (or an extended `test.yml`) that `release.yml` calls,
so the exact same checks run from (a) push/PR, (b) manual dispatch against
any ref or PR branch, (c) release pre-flight — one definition, three
triggers. This is the most direct answer to "how do I test PR #13 the way
release.yml would, without releasing."

**C. Decouple "build a DB to test against" from "publish a release."** The
Docusaurus extractor already has `--from-cache` (no live network, reads
`manual/pages/`) and `--check-counts`. Wiring a cached or fixture-derived DB
build into CI/dispatch — separate from the Confluence-HTML release pipeline
— lets contract/eval/docusaurus-count checks run without touching npm or
Docker at all.

**D. Coverage reporting.** Add `bun test --coverage` to `test.yml`, surface
it as a step-summary table or artifact. Cheapest option; do this first
regardless of what else gets picked.

**E. NPM prerelease channel.** Investigated properly, not guessed:

- `npm publish` in `release.yml` has **no `--tag` flag** → every publish
  goes to the `latest` dist-tag. Every release, including the current 0.10.x
  Confluence line, becomes the default `bunx @tikoci/rosetta` resolution the
  moment it publishes.
- To ship `0.11.0` as a non-default prerelease: `package.json` would need a
  real prerelease semver (`0.11.0-beta.0`), and the publish step would need
  `npm publish --tag next` (or similar) so `latest` stays pinned at 0.10.x
  while `bunx @tikoci/rosetta@next` (or the explicit version) opts in.
- The auto `bump-version` job's `PATCH + 1` integer-increment logic
  (`release.yml` ~line 641) assumes a plain 3-part version and has no branch
  for prerelease identifiers today — this needs real workflow changes, not a
  config flag.
- Separately, and available today with **zero CI changes**: `src/paths.ts`
  dev-mode already resolves `ros-help.db` to the project root whenever `.git`
  exists, so `bun run src/mcp.ts` / `make serve` / `make browse` inside this
  checkout run against whatever DB you've locally built with `make extract`
  — no npm/bunx involved. That solves testing *inside* the rosetta repo
  right now. It does **not** solve testing rosetta *from another project's*
  agent session, since those go through `bunx @tikoci/rosetta` /
  published npm — that's specifically what a real prerelease channel (E)
  would unlock, and it's genuine new scope, not a rediscovery of something
  that already works.

## Current lean

1. **Coverage reporting (D) first.** Cheapest, non-invasive, and the data it
   produces should inform everything downstream rather than guessing.
2. **Reusable-workflow split (B) is the structurally correct fix** for
   "release-only tests." Bigger lift, touches both workflow files, deserves
   its own task and its own review pass rather than folding into this one.
3. **Richer `workflow_dispatch` (A) matters most once (B) exists** — dispatch
   inputs are only as useful as the menu of decoupled jobs behind them.
4. **NPM prerelease channel (E)** is real but separate scope, and isn't
   blocking B-0012 testing today since in-repo dev-mode already covers
   testing changes made directly in this checkout. **Superseded 2026-07-08**
   — user chose to pursue E next after all; see "2026-07-08 follow-up" below.
5. **Most direct lever for "more confidence in #13" specifically:** promote
   `V-docusaurus-docs-count` from GAP/manual-only to at least
   non-blocking-in-CI using `extract-docusaurus.ts --from-cache` — doesn't
   require any of 1–4 first, and directly closes the one gap
   `VALIDATION.md` already names by itself. **Folded into `T-0036` below** —
   turns out it's the same touch-point as the release.yml extractor cutover.
6. **Old-corpus-vs-new-corpus content-parity check** (help.mikrotik.com HTML
   DB vs. the new Docusaurus DB) doesn't exist in any form today. Needs its
   own design pass first — "equivalent" isn't yet defined at the
   page/section/property level — before it's task-shaped.
7. **bench-routeros-tools non-agent tests:** that repo is Python
   (`pyproject.toml`, `harness/`, `lib/`); rosetta's own `DESIGN.md`
   ("structural metrics + small live pilot") suggests some structural-metric
   pieces plausibly don't need a live agent, but this needs a short scoping
   pass in that repo before committing to "incorporate into rosetta CI" —
   flagged as open, not resolved, here.

## 2026-07-08 follow-up — NPM prerelease channel (Option E), reviewed and split into tasks

User's own priority reordering (their words): tags-to-release.yml first, then
a new dispatch-able `qa.yml` (Option B, "like centrs/quickchr"), then PR
gates/branch protection, then expanding tests in code and `qa.yml` — each a
separate, independently-scoped effort. Coverage reporting (D) folds into
whichever workflow file is being touched anyway, rather than landing as its
own standalone pass. This section covers the first of those: a concrete
strawman for `--tag` support, reviewed against the real `release.yml` and
`package.json` state.

**Load-bearing finding that changes the plan:** `release.yml` was never cut
over to `extract-docusaurus.ts`. `T-0035`'s own closing note says this
explicitly — "`release.yml` was deliberately **not** touched... flipping the
actual release pipeline stays a separate, later decision" — and
`briefings/B-0012-docusaurus-manual-migration.md` "Next steps" confirms: "No
new rosetta release ships until something solid on the Docusaurus migration
lands; that's a deliberate choice, not a stalled step." `release.yml` line
186–189 still calls `extract-html.ts`/`extract-properties.ts` against the
live `html_url` Confluence zip — the exact extractor `Makefile`'s
`extract`/`extract-full` demoted to a manual-only `extract-legacy-confluence`
path back in `T-0035`. So today, dispatching `release.yml` — tagged
prerelease or not — would publish the *old* Confluence-sourced DB unchanged.
Any prerelease-channel work is moot until this is fixed, because there is
currently no CI path that builds a Docusaurus-sourced DB at all.
`package.json` is already sitting at bare `0.11.0` (unreleased); npm's
published `latest` is confirmed still `0.10.0` (the deliberate "final
Confluence corpus" release per `65fc229`'s commit message) — everything is
staged for the cutover except the workflow itself.

**Sharp edges found in the `--tag` mechanics** (beyond the extractor gap):

- The "Build and push OCI images" step unconditionally tags+pushes `:latest`
  to both registries on every run, regardless of npm dist-tag — an
  unguarded alpha dispatch would silently overwrite the production `/app`
  container's `:latest` with an unfinished prerelease DB.
- `npm publish`'s preflight ("Verify npm publish access") hard-fails unless
  `inputs.version` exactly equals `package.json`'s version — but a
  `${GITHUB_RUN_NUMBER}`-suffixed prerelease version (per the user's
  "don't commit the run-number bump" design) can't be predicted ahead of
  dispatch, so `inputs.version`'s role needs to change for tagged runs.
- The user's semver-range read (`^0.11.0-alpha` walks alpha→beta→rc, and
  alphabetical ordering of those identifiers is real per semver's
  prerelease-precedence rules) is correct but incomplete: npm's
  caret-with-prerelease matching only spans the *same* `[major,minor,patch]`
  tuple. The day a `0.11.1-alpha.0` or `0.12.0-alpha.0` ships, that range
  stops matching anything new — it is not a "follow every future
  prerelease" mechanism. That's what dist-tags are for
  (`bunx @tikoci/rosetta@alpha` / `@next`), not semver ranges.
- Removing the `bump-version` job's auto-commit (necessary — its blind
  `PATCH + 1` can't reason across three channels) trades away the "CI always
  advances past what's published" safety net for the `latest` channel; the
  npm preflight's "already published" check becomes the only backstop —
  loud failure, not silent, so acceptable, but worth naming.

**Decisions locked in this session** (via direct discussion, not guessed):

- **Two sequenced tasks, not one.** `T-0036` (cut `release.yml` to
  `extract-docusaurus.ts`, drop `html_url` entirely — independently valuable,
  already the expected next move per B-0012's "Next steps") lands first;
  `T-0037` (`--tag`/dist-tag channel, `depends_on: [T-0036]`) builds on it.
- **Full pipeline runs on every dispatch**, tagged or not — no fast path.
  Docker/GHCR multi-arch push, GH Release, and the 3-OS `bunx-smoke` matrix
  all run for alpha/beta/rc the same as for `latest`. OCI tags get aligned
  with the npm scheme instead: `$VERSION` and `sha-$SHORT_SHA` always push;
  a floating per-stage tag (`:alpha`/`:beta`/`:rc`) and a floating `:next`
  push for prerelease runs; the bare `:latest` OCI tag pushes only on
  non-prerelease runs. User's own caveat: if aligning OCI tags proves more
  work than it's worth in practice, skipping Docker/GHCR for prerelease runs
  entirely is an accepted fallback — not required to get right on the first
  pass.
- **Both dist-tag shapes**: `npm publish --tag <stage>` (stage parsed from
  `package.json`'s prerelease identifier: `alpha`/`beta`/`rc`) *and* an
  `npm dist-tag add ... next` immediately after, so `@next` always resolves
  to the newest prerelease of *any* stage while `@alpha`/`@beta`/`@rc` each
  stay pinned to their own stage's latest.
- **`html_url` drops out of `release.yml` entirely.** A historical-corpus
  rebuild becomes a local-only `make extract-legacy-confluence` + manual
  publish, matching how `MANUAL.md` already frames that target.

See `tasks/done/T-0036-release-yml-docusaurus-cutover.md` and
`tasks/T-0037-npm-prerelease-dist-tag-channel.md` for the resulting
commitments — coverage reporting (D) is folded into `T-0037` since it's the
same `release.yml` touch-point.

**2026-07-08, second pass (independent agent review of both tasks):**
confirmed the npm mechanics (`npm publish` defaults to `latest`, `--tag`
targets another dist-tag, `npm dist-tag add` is the right primitive for
`next`) and the semver-range caveat. Found and fixed four gaps before
treating `T-0037` as implementation-ready: `T-0037` lacked explicit
`republish_assets: true` semantics for prerelease versions (now specified —
no `package.json` rewrite, no dist-tag moves, no floating-OCI-tag moves,
`inputs.version` must carry the exact already-published run-numbered
version); `T-0036` didn't call out that it breaks five existing
`src/release.test.ts` cases anchored on `html_url`/`extract-html.ts`/the
"Download HTML export" step name (now enumerated); `T-0037`'s stage-name
validation (`alpha`/`beta`/`rc` only, reject anything else) was left as an
implementation-time open item instead of a real acceptance criterion (now
promoted); and `T-0037`'s `status: ready` didn't match its own unresolved
`depends_on` per `tasks/README.md`'s definition — changed to `status:
blocked` with a `trigger:` pointing at `T-0036` reaching `done`, matching
the precedent `T-0035` set for `T-0034`.

## Open questions

- Do you want `test.yml`'s PR trigger to actually gate merges (branch
  protection / required status checks), or stay advisory as today? Changes
  how aggressively any non-blocking → blocking promotion should move.
- For the reusable-workflow split (B): should `release.yml` keep its own
  fast-fail typecheck/lint/test ordering (the comment there says this exists
  specifically so a regression fails in ~30s instead of ~3min), or should
  everything funnel through the shared workflow even if that's slower?
- Is a committed (or periodically-refreshed, scheduled-workflow) full-corpus
  `manual/pages/` cache worth having, so `--check-counts`/parity checks can
  run in CI without a live fetch? Today that cache is local-only and
  gitignored.
- Confirm with a short scoping pass which bench-routeros-tools harness
  pieces are genuinely agent-free before committing to incorporate them.

## Related

- `briefings/B-0010-mcp-eval-phases-3plus.md` — eval *sophistication*
  roadmap (judges, differential testing, mutation). This briefing is about
  *wiring/gating* of the eval phases that already exist (Phases 0–2);
  complementary, not overlapping.
- `briefings/B-0012-docusaurus-manual-migration.md` — the extractor whose
  testing gap motivated this review.
- `tasks/done/T-0033-docusaurus-premigration-grounding.md` — closed
  2026-07-08; the B-0012 consolidation work mentioned there is separate from
  this CI-specific angle and remains deferred.
- `VALIDATION.md` — source of truth for the blocking/non-blocking/GAP
  inventory used throughout this briefing.
