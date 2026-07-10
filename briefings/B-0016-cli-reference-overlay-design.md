---
id: B-0016-cli-reference-overlay-design
topic: Precursor ETL design for the manual.mikrotik.com CLI-Reference overlay
status: open
related_tasks:
  - "#25"
  - "#28"
created: 2026-07-10
last_revisited: 2026-07-10
---

# Question

What exact shape should the CLI-Reference overlay ETL take — table/columns, join key, quasi-provenance
format, and parsing approach — so the ETL half of issue
[#25](https://github.com/tikoci/rosetta/issues/25) can move from "blocked" to a scoped, agent-ready
extractor task?

This briefing exists because issue #25 currently bundles two different kinds of work: (1) ingesting
CLI-Reference data (an ETL problem) and (2) changing `routeros_command_tree`/`routeros_explain_command`
fallback behavior to use that data (a query-core problem). The maintainer flagged this directly on #25
(2026-07-10): *"ETL of /hardware and /cli-reference is needed before this issue can be worked - should
like have issues and/or briefing on the precursor work. Issue correct, but the ETL part of it deserves
its own thinking before tool changes."* This briefing is that precursor thinking for the CLI-Reference
half. `B-0017` covers the parallel `/hardware` half.

## What's grounding this

All of the following is already-verified research, not new — this briefing's job is to turn it into a
concrete extractor spec, not to re-derive it:

- `briefings/B-0012-docusaurus-manual-migration.md` H3 ("CLI Reference survey") did a full 236-page
  census: 223/236 pages have `<ArgTable>`, 69/236 have a `**Package:**` field (19 distinct package
  values), 41/236 have `**Conditions:**` (arch tokens like `!smips` mixed with build-feature flags like
  `BFD_AUTHENTICATION`), 18/236 have `**Syscap:**` (including explicit `chr`/`nochr` markers CHR-based
  `/console/inspect` cannot self-report), 1,150 argument rows carry inline enum values, 397 carry
  `[min .. max]` ranges, 293 carry `alt { ... }` composite/alternative rows. No version-provenance field
  exists anywhere in the 236 pages.
- B-0012 Option D's "overlay sketch": treat parsed CLI-Reference as a **version-less enrichment overlay**
  keyed by command path (+ argument name). Where a path/arg matches restraml `deep-inspect.json` data,
  attach the CLI-Reference URL and manual-only facts (`Conditions`, `Syscap`, human description) to the
  versioned record. Where it doesn't match, keep it as a manual-only row with explicit provenance. Never
  let the overlay assert version facts — it has no version to assert.
- `command-versions-vs-presence.instructions.md`: `command_versions` (full history) and
  `schema_node_presence` (GC'd active-head view) are deliberately separate concepts — an overlay table
  must not collapse into either; it's a third, version-less thing.
- `data-source-naming-product-matrix.instructions.md`: precedent for "don't assume canonical naming
  across sources, keep matching heuristic" — likely applies to command-path matching too if CLI-Reference
  paths ever diverge from `deep-inspect.json` paths (not yet observed, but not verified absent either).
- restraml's `enrich-openapi.ts` already reads rosetta's `ros-help.db` to enrich its own OpenAPI output
  (B-0012 H5) — any new overlay table/column rosetta adds is a potential new input for restraml too,
  worth a heads-up once the shape is settled (same channel as
  [tikoci/restraml#85](https://github.com/tikoci/restraml/issues/85)).
- T-0035's extractor pipeline (`src/extract-docusaurus.ts`) already solved sitemap/`llms.txt` discovery
  and per-page `.md`/`.mdx` fetch with count-check validation (`V-docusaurus-docs-count`) — the
  CLI-Reference overlay extractor should reuse that plumbing, not reinvent discovery.

## Open design questions

These need answers before the ETL half of #25 is spec-settled enough for `agent-ready`:

1. **Table shape.** New standalone table (e.g. `cli_reference_overlay`) keyed by `(command_path, arg_name
   NULL-able)`, or new nullable columns bolted onto `schema_nodes`? A standalone table keeps the
   version-less/versioned distinction structurally obvious (matches the `command_versions` vs
   `schema_node_presence` separation principle) but adds a join; columns-on-`schema_nodes` are cheaper to
   query but risk exactly the concept-collapse the versions-vs-presence instruction warns against.
2. **Join key robustness.** Is CLI-Reference's path scheme (`/docs/cli-reference/ip/address`) reliably
   1:1 with `schema_nodes.path`/`commands.path`? B-0012 H3 didn't check this systematically — needs a
   real diff (paths-only-in-CLI-Reference vs paths-only-in-deep-inspect vs paths-in-both) before assuming
   a clean join.
3. **Quasi-provenance format.** #25 proposes text like *"applies to stable; current stable at import time
   was X.Y"* — needs an exact column (or JSON shape) and a defined source for "current stable at import
   time" (restraml's own version detection? a live `/system/package/update` style check? hardcoded at
   extraction time?).
4. **Parsing approach.** H3's census was regex-over-raw-MDX (explicitly "a structural census, not a real
   MDX parser"). Does the real extractor need an actual MDX/JSX parser for `<ArgTable>`/`<ArgTableRow>`
   props, or does a hardened regex (handling the malformed-emphasis-style edge cases H4 found in prose)
   suffice? Decide before writing throwaway parsing code twice.
5. **What surfaces to agents, and how.** `Conditions`/`Syscap`/`Package` are manual-only facts
   `/console/inspect` can't produce (B-0012 H3, point 3: `nochr`/`chr` as an explicit example). Do these
   show up as advisory notes on `routeros_explain_command`/`routeros_command_tree` results, a new field,
   or only via the CLI-Reference URL pointer? This is where the ETL question and #25's query-behavior
   question meet — the overlay's shape should be decided with the consuming shape in mind, even though
   the query-behavior change itself stays out of scope here.
6. **Coverage gaps.** 13/236 pages have no `<ArgTable>` at all (text-only) — what does the overlay do for
   those (skip, or store the manual URL/description-only row)?

## Current lean

None yet — this briefing is intentionally unresolved. Answering questions 1–3 (table shape, join
robustness, provenance format) is the minimum needed to cut a scoped "CLI-Reference overlay extractor"
issue distinct from #25's query-behavior half; questions 4–6 can be resolved during that extractor's
implementation rather than blocking the issue-cutting.

## Open questions

See "Open design questions" above — this briefing's whole body is open questions by design. Re-visit
after a diff pass answers #2 (join-key robustness), since that result may reshape #1 and #3.
