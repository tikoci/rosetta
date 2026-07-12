# Validation Matrix

What's load-bearing in rosetta and how it's proven.

This file is the single answer to "is rosetta rock-solid?" Each row names an invariant, the CI step (or test file) that proves it, and the current enforcement status. **Green rows are guarantees. GAP rows are honest debt.**

Tasks in `tasks/` reference these IDs in their `validation:` frontmatter. When a `GAP` row turns into a real check, the task that introduced it gets closed.

## Status legend

- **blocking** — failure fails CI (or release). The invariant is enforced.
- **non-blocking** — runs in CI, prints a result, but does not fail the build. Used for new checks earning trust before being promoted to blocking.
- **GAP** — the invariant matters but no automated check proves it today. The `Tracked by` column names the task that closes the gap.

## Matrix

| ID                       | Invariant                                                                                                            | Proven by                                                              | Status                                       | Tracked by |
|--------------------------|----------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------|----------------------------------------------|------------|
| V-typecheck              | TypeScript types are sound across the repo                                                                           | `bun run typecheck` in `.github/workflows/test.yml`                    | blocking                                     | —          |
| V-lint                   | Biome reports zero errors repo-wide                                                                                  | `bun run lint` in `.github/workflows/test.yml`                         | blocking                                     | —          |
| V-unit                   | Unit + integration tests pass on a fixture-only DB                                                                   | `bun test` in `.github/workflows/test.yml`                             | blocking                                     | —          |
| V-tool-registry          | 14-tool MCP surface is frozen — adds, removals, renames are intentional                                              | `EXPECTED_TOOLS` block in `src/mcp-contract.test.ts` (Block A)         | blocking (test.yml)                          | —          |
| V-tool-shapes            | Tool response shapes stable for 5 canonical queries                                                                  | `src/mcp-contract.test.ts` Block C in `release.yml` post-extraction    | blocking                                     | —          |
| V-tool-budget            | Token-budget guardrails on 10 canonical queries                                                                      | `src/mcp-contract.test.ts` Block B in `release.yml` post-extraction    | blocking                                     | —          |
| V-retrieval-floor        | Recall@10 ≥ baseline − 2pp on 20 hand-curated golden queries; classifier accuracy stable                             | `src/eval/retrieval.ts` in `release.yml`                               | blocking                                     | —          |
| V-retrieval-self         | Self-supervised eval (~170 auto-generated queries) holds within 5pp of baseline                                      | `MCP retrieval eval (Phase 1, self-supervised, non-blocking)` step in `release.yml` | non-blocking (pending promotion) | —     |
| V-db-min-content         | Built DB has ≥200 pages, ≥1000 commands, ≥100 devices, ≥1000 properties, ≥200 hardware_catalog, ≥600 device_aliases before publish | `Validate DB has expected content` step in `.github/workflows/release.yml` | blocking                                 | —          |
| V-db-wipe-guard          | Tests cannot accidentally open and overwrite the on-disk DB                                                          | `src/query.test.ts` `:memory:` guard + post-extraction guard in CI     | blocking                                     | —          |
| V-db-meta                | Released DB carries `db_meta` provenance (release_tag, built_at, source_commit, schema_version)                      | `scripts/stamp-db-meta.ts` step in `release.yml`                       | blocking                                     | —          |
| V-bunx-macos             | `bunx @tikoci/rosetta` installs + serves on macOS                                                                    | `bunx-smoke` matrix in `release.yml`                                   | blocking                                     | —          |
| V-bunx-linux             | Same on Linux                                                                                                        | `bunx-smoke` matrix in `release.yml`                                   | blocking                                     | —          |
| V-bunx-windows           | Same on Windows — catches v0.8.x EBUSY / readonly-WAL / temp-file class of bugs                                      | `windows-latest` row in `bunx-smoke` matrix in `release.yml`           | blocking                                     | —          |
| V-cross-version-bunx     | Schema-mismatched on-disk DB triggers re-download cleanly                                                            | `src/setup.test.ts`                                                    | blocking                                     | —          |
| V-stdio-handshake        | MCP stdio handshake completes against a real `@modelcontextprotocol/sdk` client; no stdout pollution                 | `bun test src/mcp-stdio-client.test.ts` in `.github/workflows/test.yml` | blocking                                     | —          |
| V-http-handshake         | MCP HTTP handshake + multi-session lifecycle works end-to-end                                                        | `src/mcp-http.test.ts`                                                 | blocking                                     | —          |
| V-tui-mcp-parity         | Every MCP tool reachable via a `.routeros_*` dot-command in `browse`                                                 | `src/browse-parity.test.ts` via `bun test` in `.github/workflows/test.yml` | blocking                                 | —          |
| V-cli-flag-uniformity    | CLI flags documented in `MANUAL.md` match `bun src/mcp.ts --help` output                                             | `src/cli-help.test.ts` via `bun test` in `.github/workflows/test.yml`  | blocking                                     | —          |
| V-release-structure      | Release artifacts, build constants, container entrypoint stay structurally consistent                                | `src/release.test.ts`                                                  | blocking                                     | —          |
| V-npm-channel-tags       | Prerelease npm publishes go out under their stage's dist-tag (`alpha`/`beta`/`rc`) plus a rolling `next`; a bare package.json version publishes unchanged (no `--tag`, defaults to `latest`) | `src/release.test.ts` "npm prerelease channel" (structural, runs in test.yml on every push/PR); functional behavior only exercised by an actual `release.yml` dispatch | blocking                                     | —          |
| V-oci-latest-guard       | The bare `:latest` OCI tag only pushes on a non-prerelease (latest-channel) release run — a prerelease dispatch can never clobber the production `/app` container's `:latest` | `src/release.test.ts` "OCI tags align with npm scheme..." (structural); functional behavior only exercised by an actual `release.yml` dispatch | blocking                                     | —          |
| V-changelog-gate         | A bare (latest-channel) `package.json` version can't release without a matching `## [<version>]` `CHANGELOG.md` heading already promoted by hand — CI no longer auto-bumps versions or promotes `[Unreleased]` for any channel | `Verify CHANGELOG promotion for latest-channel release` step in `release.yml` + `src/release.test.ts`      | blocking                                     | —          |
| V-coverage-reported      | `bun test --coverage` runs every release build; results are summarized in `$GITHUB_STEP_SUMMARY` and uploaded as a workflow artifact — informational only, not a gate | `Run tests (fast-fail)` + `Upload coverage artifact` steps in `release.yml` | non-blocking (informational, no threshold)   | —          |
| V-canonicalize           | RouterOS CLI canonicalizer handles every input form + torture cases (H1–H8)                                          | `src/canonicalize.test.ts` + `src/canonicalize.fuzz.test.ts`           | blocking                                     | —          |
| V-classifier             | `classify.ts` detectors hit table-driven cases including overlap                                                     | `src/classify.test.ts`                                                 | blocking                                     | —          |
| V-schema-roundtrip       | Schema importer round-trip preserves arch diffs, completion, desc parsing                                            | `src/schema-roundtrip.test.ts`                                         | blocking                                     | —          |
| V-extract-videos         | yt-dlp extractor handles cache save/import/known-bad correctly                                                       | `src/extract-videos.test.ts`                                           | blocking                                     | —          |
| V-docusaurus-parse-shape | Docusaurus Markdown parsing (properties incl. malformed-emphasis, admonitions, sections, link resolution) matches fixture-verified expectations | `src/extract-docusaurus.test.ts` against `fixtures/docusaurus/*.md`    | blocking                                     | —          |
| V-docusaurus-docs-count  | Extracted `/docs` page count exactly matches the scoped `llms.txt` in-scope entry count (B-0012 H8)                  | `Extract Docusaurus pages, properties, callouts` step (`extract-docusaurus.ts --check-counts --strict`) in `.github/workflows/release.yml` | blocking (release.yml) | —          |
| V-device-map-drift       | Committed device→URL artifacts (`device-map.tsv`, `hardware-unmatched.tsv`, `device-exceptions.toml`, the two assessment JSONs) stay coherent — no device silently stops resolving, no curated exception goes stale, no committed TSV drifts from recomputed output (B-0018) | `make device-map-check` (`build-device-map.ts --check`) step in `.github/workflows/test.yml` | blocking (test.yml, every PR) | —          |
| V-qa-rehearsal           | The release-locked gates above (V-tool-shapes, V-tool-budget, V-retrieval-floor, V-retrieval-self, V-db-min-content, V-db-meta, V-docusaurus-docs-count) are rehearsable on any ref without publishing — same definitions run against a fresh or published DB with no npm/OCI/Release | `qa.yml` (`workflow_dispatch` + `workflow_call`); anchored by `src/release.test.ts` `describe("qa.yml")` | non-blocking (rehearsal surface) | #42        |

> **`qa.yml` rehearses the release-locked rows.** The seven invariants above marked `release.yml` are also runnable via the `QA` workflow (`qa.yml`) on any branch — no publish. `qa.yml` currently carries its own copy of the DB-content floors; a `src/release.test.ts` drift guard asserts those floors are byte-identical to `release.yml`'s until the Phase B `uses:` dedup (#42) collapses them to one definition. See `MANUAL.md` → "Rehearsing release quality gates without publishing".

## How to add a row

1. Pick a free `V-*` ID. Use kebab-case after the prefix.
2. Add the row in roughly the right thematic neighbourhood (build basics, tool surface, retrieval, DB, install, transports, surface parity, extractors).
3. If `Status` is `GAP`, name the task in `Tracked by` — the row stays GAP until the task lands.
4. Reference the new ID from any task's `validation:` frontmatter that depends on the invariant holding.

## How to flip a row

GAP → non-blocking when the test exists and runs in CI.
non-blocking → blocking after at least one fully green run with the check on the critical path.

When promoting non-blocking → blocking, remove `continue-on-error: true` from the workflow step in the same PR. If the check is red on the next run, it's surfacing real signal — fix, don't paper over.

### `V-retrieval-self` promotion path (straw man)

`V-retrieval-self` is non-blocking because its first landing suppressed a real −10pp regression (`continue-on-error: true` in `release.yml`; see `briefings/B-0014-ci-testing-qa-cleanup.md`). Promotion criteria, proposed here so the row has an owner and a bar rather than drifting forever:

1. **Rehearse blocking on demand first.** `qa.yml`'s `eval_self_blocking: true` input runs the self-supervised eval as a hard gate against a fresh `local-build` DB without touching the release path — use it to observe real build-to-build drift.
2. **Bar:** at least 3 consecutive `eval_self_blocking` rehearsals (or release runs) green with no legitimate-drift red, i.e. every red in that window was a genuine retrieval regression that got fixed, not tolerated.
3. **Owner:** the maintainer flips it, in one PR that removes `continue-on-error` from *both* `release.yml`'s Phase 1 step and `qa.yml`'s eval-self default.
4. **Prerequisite, not yet built:** trend persistence. Today each run's numbers live only in that run's `$GITHUB_STEP_SUMMARY`; a durable baseline/trend store (cf. centrs' `qa-history` branch pattern) should land before blocking, so a promotion decision reads history instead of one run.
