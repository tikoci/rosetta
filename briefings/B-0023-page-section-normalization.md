---
id: B-0023-page-section-normalization
topic: Normalize a page as a complete set of sections (make section coverage total) so page prose is sliceable, not just whole-page
status: open
related_tasks: ["#27", "#93", "#95", "#131", "B-0012", "B-0022", "B-0024"]
created: 2026-07-16
last_revisited: 2026-07-31
---

# Question

Today a `pages` row stores and indexes the **whole** page, and `sections` stores an *incomplete*
overlay of that page (only the h1–h3-headed chunks). The two do not reconcile: the sum of a page's
sections is not the page. B-0022's `pages.tsv` / `pages_summary.tsv` export made this visible because a
spreadsheet wants the parts to add up to the whole and they don't.

Should the DB instead treat a page as a **complete, non-overlapping set of fragments** — every byte of the
page belonging to exactly one addressable fragment — so that:

1. the export is "pivot-table friendly" (section rows roll up to the page total), and
2. later MCP/TUI work can let a client *select fragments* (e.g. "give me sections X, Y, Z") instead of
   pulling the whole page and trimming with `length=`?

This briefing is **homework and a recommendation**, not a settled spec. No MCP tool-surface change is
proposed for 0.11.0 — the goal is a 0.11.0 **schema/ETL** shape that makes those future tool changes a
data question rather than a re-parse. It spins out of B-0022's final open question ("the page/section
sizing data may deserve its own briefing rather than living here as a byproduct").

# What's grounding this

Measured on the CI artifact **v0.11.0-rc.99** (`schema_version` 10, `source_commit` 67edb80, 363 pages) —
the artifact, not the repo-root `ros-help.db`, per issue #94 / B-0022's grounding rule. Queries are plain
SQL over `pages` and `sections`.

**Section coverage is partial by construction.** `parseSections()` (src/extract-docusaurus.ts) splits the
body on **h1–h3 only**, folding h4–h6 into the enclosing section's text and dropping the pre-first-heading
lead entirely (`attributeSection()` returns `null` for "content before the first section"). So:

| Fact (rc.99) | Value |
|---|---|
| Pages total | 363 |
| Pages with **zero** sections (whole page is lead/preamble) | **40** |
| Total page words | 653,753 |
| Total section words | 576,938 |
| **Words in no section row (the gap)** | **76,815 (11.7%)** |
| ↳ of which, in the 40 no-section pages | 15,280 |
| ↳ of which, preamble on otherwise-sectioned pages | 61,535 |
| Empty sections (`word_count = 0`, #93) | 129 |

The gap is not a rounding artifact — it is whole subsystems of prose. Worst cases:

| Page | Page words | In sections | Orphaned (preamble) |
|---|---|---|---|
| `hotspot-customisation` | 5,256 | 1,170 | **4,086 (78%)** |
| `software-specifications` | 1,300 | 47 | 1,253 (96%) |
| `back-to-home` | 2,043 | 653 | 1,390 |

`hotspot-customisation` is the clean illustration: it has exactly **one** h1–h3 section ("### Firewall
customizations") that appears late, while ~17 `####` (h4) subsections sit above it. Because the split is
h1–h3, every h4-organized subsection folds into "preamble" and never becomes an addressable fragment. A
page authored at h4 depth is nearly invisible to the section table.

**How broad is the h4-dominated case?** Of the 363 pages, **64 have >50% of their words orphaned**; of those,
**41 have no section at all** and only **23 have some section but are still h4-dominated** (the
`hotspot-customisation` shape). A lead fragment (Option A) recovers the preamble for **all 64**; splitting
h4–h6 (Option B) would only *further* help the 23. That ratio is the grounding for keeping Option B out of
scope: it's an exception-driven minority, and A alone closes the bulk of the gap.

**The same gap shows up in the attribution columns** #90 added — rows that belong to page-level (pre-first-
heading) content have `section_id = NULL` honestly, but that means they also cannot roll up to a section:

| Table | Rows | `section_id IS NULL` |
|---|---|---|
| `properties` | 4,581 | 12 |
| `callouts` | 943 | 104 |
| `page_tables` | 855 | 16 |

A lead fragment would give ~99% of these NULLs a real home while keeping the honest-absence semantics for
anything genuinely page-global.

**What is correct today and must stay correct:** the whole-page `pages.text` / `pages.code` and their FTS
index are the retrieval spine and should keep indexing the complete page — nothing here argues for
shredding the page or dropping whole-page search. The proposal is about the **section overlay** becoming
total, not about the page store changing role.

# The design principle B-0022 surfaced

**"The parts sum to the whole" is worth adopting as an ETL invariant**, for two reasons beyond the
spreadsheet:

- It is a **cheap, load-bearing check.** `sum(fragment bytes) + structural bytes == page bytes` is a single
  assertion that catches an entire class of silent parse drift — exactly the way #90's `parsed == stored`
  assert catches property loss and #92's generic-table store made #100 visible. A coverage invariant fails
  loudly when a future parser change starts orphaning content.
- It is the **precondition** for the retrieval-unit direction in #27 (MCP/TUI). You cannot offer a client
  "select sections X, Y, Z" or return "term found in section Y at line N" if 12% of the prose lives in no
  section. Total coverage is what makes `get_page(section=)` and a lighter, section-referencing
  `routeros_search()` result *possible later* without a re-parse.

# Options considered

### A. Mint a lead ("H0") fragment for pre-first-heading content — **recommended**

Give every page a synthetic level-0 fragment (heading = page title or a sentinel, `anchor_id = ""` or a
reserved token) holding the body before the first h1–h3 heading. On the 40 no-section pages the whole page
becomes one lead fragment; on sectioned pages the lead paragraph/summary becomes addressable.

- **Pros:** recovers the bulk of the 76,815-word gap; makes `pages.tsv` roll up cleanly; gives the NULL-
  `section_id` rows a real anchor; small, additive ETL change; `attributeSection()` stops returning `null`
  for lead content (or returns the reserved lead anchor). Section stays "the retrieval unit," just a
  complete one.
- **Cons:** need a stable convention for the lead anchor and heading (must not collide with a real slug —
  the empty string or a reserved `#lead` token both work); decide whether the lead fragment is FTS-indexed
  as a section (probably yes, for future section-level search) — this is additive to page FTS, not a
  replacement; empty-lead pages should **not** mint an empty lead fragment (reuse the #93 empty-section
  rule so we don't manufacture 100+ empty rows).

### B. Also fold h4–h6 into their own fragments (deeper split)

Make sections cover h4–h6 too, so `hotspot-customisation`'s 17 subsections become 17 fragments.

- **Pros:** finer addressability; the pivot totals get even closer; better future "select this subsection."
- **Cons:** bigger change to the retrieval unit and to #90's deliberate "fold h4–h6 to nearest h1–h3
  ancestor" decision (documented in `attributeSection()`); risks fragment explosion and changes what a
  "section" *means* for existing MCP/TUI/eval behavior. **Out of scope for 0.11.0** — but the lead fragment
  (Option A) is a strict prerequisite either way, so A first, B later if #27 wants it.

### C. Do nothing structural; keep disclosing the gap in the manifest

Leave the schema; keep `pages_summary.tsv` honest by noting sections don't sum to the page.

- **Pros:** zero risk; the export already discloses honestly.
- **Cons:** leaves the 12% permanently non-addressable; blocks the #27 retrieval-unit direction; the
  spreadsheet stays un-pivotable. Rejected as the *end* state, though it is the correct *interim* state
  until A lands.

### D. Extract code blocks into their own fragments (the user's `pages.tsv` musing)

Considered and **recommended against** as a fragment split. Code blocks differ from tables: a table is a
downstream-processable structure (#92 stores it as rows/cells precisely because a consumer or agent
re-uses it), whereas a fenced code example is only meaningful **with its surrounding prose** — the sentence
before a config snippet is what says what it does. Splitting code into a separate fragment would break the
"parts sum to the whole" reconstruction (there'd be no text fragment to slot it back into) and degrade
retrieval, since the prose+code should surface together. Keep code inline in its fragment's text; keep the
existing derived `code` / `code_lang` columns as a *view* over the same bytes, not a separate partition.
(Tables already are separately stored *and* remain inline in the section text, so a table does not create a
coverage hole — a code carve-out would.)

# Decision (2026-07-16, reviewed with maintainer)

**Do Option A — a lead ("H0") fragment — as a 0.11.0 schema/ETL change.** The open questions below were
reviewed and resolved; the design is settled enough to implement. Concretely:

1. **`parseSections()` emits a synthetic lead fragment** for non-empty pre-first-heading content, reusing
   the #93 empty rule: a page whose lead is empty/whitespace mints no lead row, so we don't manufacture
   100+ empty fragments. It sits first (`sort_order = 0`); real h1–h3 sections shift to `1..n`, which is
   the honest reading order (the lead genuinely precedes them).
2. **Reserved anchor `_lead`, level `0`, heading = the page title.** The underscore is *provably*
   collision-free, not merely unlikely: `slugify()` strips every character outside `[a-z0-9\s-]`, so no
   real heading — and no `foo`/`foo-1` disambiguation suffix — can ever produce an `anchor_id` containing
   `_`. That is stronger than a `#lead` token (which *could* collide with a literal "Lead" heading) and
   self-documents that the fragment is synthetic. `attributeSection()` then returns `_lead` for
   pre-first-heading lines instead of `null`, so lead-resident properties/callouts/tables resolve to a real
   `section_id`.
3. **Reconciliation is a test, not an extractor assert, and approximate is fine.** Exact `sum == page`
   would force a home for every heading-marker line, title, and AI-summary blockquote — not worth bending
   the schema for. A test checks that section coverage is within a reasonable delta of the page (the only
   uncovered content being the h1–h3 heading-text lines, which belong to no fragment by construction), and
   may compute the exact residual if a tighter check is ever wanted. The extractor's completion summary can
   additionally *report* coverage so drift is visible without failing the build.
4. **The lead is not separately FTS-indexed — because sections have no FTS table at all today.** Its text is
   already in `pages_fts` via `pages.text`, so there is nothing to double-count. (Noted for #27: when
   section-level search is built, the lead is often the *best* page summary — authors lead with what the
   page is about — so it should be a first-class target then.)
5. **Re-run the B-0022 export** to confirm `pages_summary.tsv` section words now roll up to the page (minus
   the heading-line residual) and the `section_id IS NULL` counts drop to genuinely page-global rows.

This is deliberately **schema/ETL only**. It ships the *data* that a future #27 tool change would need
(section-level selection, term-at-line) without changing any MCP tool this release — matching the stated
0.11.0 stance of stable surfaces, better underlying data.

# Relationship to other work

- **#93 (empty sections)** — same subsystem. The lead-fragment rule and the empty-section rule should be
  decided together (do not mint empty lead rows). Fold #93's decision into this work.
- **#27 (MCP/TUI surface alignment)** — the *consumer* of total coverage. This briefing is the data
  precondition; the actual `get_page(section=)` / lighter-`routeros_search()` design stays in #27 and is
  explicitly **not** proposed here.
- **B-0024 (command↔prose join) — a second, independent consumer, added 2026-07-31.** #27 wants total
  coverage for *ergonomics* (select fragments instead of trimming a whole page). The command↔prose join
  wants it for *correctness*: "which page owns `/interface/bridge`?" has no good answer (page 10 holds
  all 226 property rows but is a section index; page 27 has the right name and zero properties), while
  "which section documents `pvid` for bridge ports?" does. A join that targets a section instead of a
  page dissolves that false choice. Two notes that do **not** change the Option A / `_lead` decision:
  (1) #131's bridge case does *not* need this briefing — those property rows already carry correct
  `section_id` and anchors, so section granularity exists for them today and what is missing is a join
  that uses it; (2) having a correctness consumer as well as an ergonomics one raises this work's
  priority. See B-0024 for the measurement.
- **#95 (schema/ETL umbrella)** — this is a schema/ETL finding of exactly the kind #95 tracks; recorded
  there as a not-yet-filed child (promotion to an agent-ready issue is earned once the lead-anchor
  convention and the reconciliation allowance are pinned — see #95's own E2–E4 discipline).
- **B-0012 (Docusaurus migration)** — the h1–h3 split and h4–h6 fold originate there; this refines that
  overlay from "partial" to "total" without changing the whole-page store.
- **B-0022 / #104 (export)** — the surface that surfaced this. Per-TSV cosmetic findings (callouts wanting
  page/section *names*, changelog column order) are export-output shape and live in #104; this briefing is
  the underlying schema question, kept separate on purpose.

# Resolved questions (2026-07-16)

- **Lead anchor convention — resolved: `_lead`.** The maintainer's pedantic lean was `NULL` (most literally
  "accurate"), but self-documentation wins for agentic development, so a reserved token it is. The
  underscore was the deciding factor and turns out to be *provably* safe: `slugify()` deletes `_`, so no
  heading can mint an `anchor_id` with an underscore, whereas a bare `lead` could collide with a literal
  "Lead" heading. `_lead` it is.
- **Exact reconciliation — resolved: not required.** `sum ~= page` within a reasonable delta is acceptable;
  a test can check the delta (or compute the exact heading-line residual if ever wanted). The schema should
  not bend over backwards for byte-exactness. Optionally surface coverage in the extractor's summary output.
- **Lead FTS-indexing — resolved: yes in principle, no-op in practice.** Agreed the lead is often the best
  page summary and should be a first-class search target — but there is no `sections_fts` today, and the
  lead text is already in `pages_fts` via `pages.text`, so this change adds no FTS work. It's a note for #27.
- **h4–h6 split (Option B) — resolved: out of scope now, counted for later.** The maintainer is interested
  in the H0 side and in keeping MCP stable; h4–h6 is suspected to be exception/heuristic-driven (splitting
  it risks minting near-empty or overhead-heavy micro-fragments on other pages), so it deserves its own
  effort if #27 ever wants it. The count was done as quick grounding: 23 h4-dominated pages (see grounding
  section) — a minority, confirming A-first.

# Open questions

- None blocking implementation. The remaining judgment call is *where exactly* the lead slice ends relative
  to the dropped duplicate-title lines and the AI-summary blockquote — settled in code as "everything before
  the first non-title h1–h3 heading," which keeps the raw-slice semantics the other sections already use.
