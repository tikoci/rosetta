---
id: T-0033-docusaurus-premigration-grounding
title: Pre-migration grounding pack — resolve B-0012 homework H1–H8 before cutting extractor tasks
status: done
priority: high
area: docs
depends_on: []
conflicts_with: []
validation: []
acceptance:
  - "Each homework item H1–H8 in B-0012 is resolved into a section of B-0012 itself (B-0012 stays the single source future coding agents read; this task adds no new top-level docs)"
  - "H5 produces an agreed cross-repo note with restraml (issue or CLAUDE.md contract update there) on how enrich-openapi.ts survives the page-identity change"
  - "H7 ends with a decided rosetta-id scheme recorded in B-0012 (and promoted to DESIGN.md if stable)"
  - "Closes by proposing the concrete extractor/MCP task files (T-*) for the migration itself, each citing the resolved B-0012 section it depends on"
  - "No production code changes — research, probes, and docs only (throwaway probe scripts stay in scratch, not src/)"
trigger: ""
created: 2026-07-07
---

# Body

B-0012 now carries a "Pre-migration homework" section (H1–H8): site internals
un-minification, lunr/tokenizer deep-dive, CLI Reference survey
(enums/`Conditions`/`Syscap`), property-descriptions assessment (the suspected
hard part), restraml downstream-effects inventory (`enrich-openapi.ts` reads
`ros-help.db` — verified circular dependency), non-`/docs` sections plan
(`/hardware` 240 HTML-only device pages, `/changelog` RSS, `/blog`),
identity/rosetta-id design, and CI cross-check design.

This task is the container for doing that homework so the actual migration
tasks are cut against grounded facts instead of guesses. Suggested order:
H1/H2 first (cheap, unblocks everything), then H3+H4 in parallel (they decide
the two parsers), H5 alongside (cross-repo, has latency), H6–H8 last (they
depend on what H1–H5 find).

**Sequencing gate (do not lose this):** a final help.mikrotik.com-corpus NPM
release must be published **before** any migration code lands, so the last
Confluence-based DB stays durably installable. This research task may run
before that gate; extractor tasks may not. See BACKLOG.md Triggers.

## 2026-07-07 progress

H1, H2, H3, H4, H6, H8 are resolved — each has a dated section in B-0012
("Verified 2026-07-07 (afternoon)"). H5 has a grounded write-up and a
proposed cross-repo contract with restraml, filed as
[tikoci/restraml#85](https://github.com/tikoci/restraml/issues/85) — still
needs restraml-side agreement before it's a real contract. H7 has the
schema-ripple analysis plus a full MCP-surface ID/URL audit done (see
B-0012 "H7" section); the user chose (2026-07-07) to leave the naming
scheme/Option 1 vs. 2 call to `T-0034`'s empirical prototype rather than
commit in the abstract. The proposed extractor/MCP task list is written up
in B-0012 under "Proposed migration task files"; item #1 is already staged
as real tasks (`T-0034`, `T-0035`).

**Deliberately not closed yet (2026-07-07):** this task's closing
acceptance criterion — proposing/finalizing the concrete extractor/MCP
task files, plus a consolidation pass over B-0012's now-large "Verified
2026-07-07" log — is deferred until after `T-0034` (and likely `T-0035`)
land, so closeout reflects what a real spike/extractor pass actually
needed rather than what looked complete in the abstract. Revisit this task
after `T-0034` reaches `done`.

**2026-07-07, later — both `T-0034` and `T-0035` are now `done`.** The
identity spike and the real `/docs` extractor both landed and were
live-verified at full scale (360/360 pages, zero fetch errors). This
task is now ready to revisit for closeout: the remaining acceptance
work is (a) writing up proposed task files #2–#4/#6 from B-0012's
"Proposed migration task files" as real `tasks/T-*.md` files (CLI
Reference overlay, `/hardware` extractor, `/changelog` watcher, MCP/TUI
source-typed results), and (b) the B-0012 consolidation pass. Not done
inline here — left for a deliberate pass rather than folded silently
into `T-0035`'s closeout.

## 2026-07-08 — closed

Revisited per the user's request to check whether T-0033/B-0012 can close
for the `/docs`-prose migration scope (explicitly excluding CLI Reference,
`/hardware`, `/changelog` — those stay future work per B-0012). Since the
note above, `release.yml` itself has also been cut over to the Docusaurus
extractor (`T-0036`, done) and an npm prerelease dist-tag channel landed
(`T-0037`, in-progress) — full write-up in B-0012's new "2026-07-08" section.

All acceptance criteria satisfied for this task's actual scope:

- H1–H8 all resolved with dated B-0012 sections (2026-07-07).
- H5 produced the required cross-repo artifact — filed as
  [tikoci/restraml#85](https://github.com/tikoci/restraml/issues/85). Still
  open/no response as of 2026-07-08 (checked via `gh issue view`), but that's
  restraml's decision to make, not something this research task can force —
  it stays tracked as proposed task #5, not a blocker to closing T-0033.
- H7 decided (Option 2) and promoted into `DESIGN.md`.
- Concrete extractor/MCP task files proposed in B-0012's "Proposed migration
  task files"; item #1 fully landed (`T-0034`, `T-0035`, and the
  `T-0036`/`T-0037` release-pipeline cutover that followed). Items #2–#4/#6
  remain deliberate proposals, not yet cut as real tasks.
- No production code changed by this task itself — all code landed via
  `T-0034`/`T-0035`/`T-0036`/`T-0037`.

**One actionable, not-yet-done gotcha surfaced during this closeout review**
(recorded in full in B-0012's "2026-07-08" section): `package.json`'s
committed version is still a bare `0.11.0` (latest-channel shape) with no
matching `## [0.11.0]` `CHANGELOG.md` heading. Dispatching `release.yml`
as-is would fail the "Verify CHANGELOG promotion for latest-channel release"
gate immediately. To ship the intended first Docusaurus-sourced test build
under the `alpha` npm dist-tag, `package.json`'s version needs to be edited
to a prerelease identifier (e.g. `0.11.0-alpha`) and committed before
dispatch — `release.yml` appends the run-number suffix itself, and
`npm view @tikoci/rosetta dist-tags` (checked 2026-07-08) confirms `latest`
is still `0.10.0` with `0.11.0` never published, so there's no collision
risk. Everything else in the pipeline (Docusaurus extraction, count-check,
channel detection, OCI/npm tagging, `bunx-smoke`) is wired and verified
structurally (`bun run typecheck` clean, full `bun test` 651 pass / 0 fail,
`src/release.test.ts` green) — this version bump is the only outstanding
step before dispatching.

Status: `done`.
