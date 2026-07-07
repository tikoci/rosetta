---
id: T-0033-docusaurus-premigration-grounding
title: Pre-migration grounding pack — resolve B-0012 homework H1–H8 before cutting extractor tasks
status: ready
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
