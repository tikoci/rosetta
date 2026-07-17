---
id: B-0023-page-section-normalization
topic: Normalize a page as a complete set of sections (make section coverage total) so page prose is sliceable, not just whole-page
status: open
related_tasks: ["#27", "#93", "#95", "B-0012", "B-0022"]
created: 2026-07-16
last_revisited: 2026-07-16
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
- **Cons:** leaves the 12% permanently unaddressable; blocks the #27 retrieval-unit direction; the
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

# Current lean

**Option A (lead fragment), as a 0.11.0 schema/ETL change, with a coverage-invariant assert.** Concretely:

1. `parseSections()` emits a synthetic lead fragment for non-empty pre-first-heading content (reuse the
   #93 empty rule; no lead row when the lead is empty).
2. Reserve the lead `anchor_id` (empty string or `#lead`) and document it next to `attributeSection()`,
   which then attributes lead-content rows to that anchor instead of `NULL`.
3. Add an extractor assert in the spirit of #90/#92: the sum of fragment coverage reconciles to the page
   (bytes, not just words, so it's exact) within a documented structural allowance for heading/title lines.
   Decide up front where heading lines and the title/AI-summary blockquote "count" so the reconciliation is
   defined, not approximate.
4. Re-run the B-0022 export; `pages_summary.tsv` section words should now roll up to (page words − the
   defined structural allowance), and the `section_id IS NULL` counts should drop to the genuinely
   page-global rows.

This is deliberately **schema/ETL only**. It ships the *data* that a future #27 tool change would need
(section-level selection, term-at-line) without changing any MCP tool this release — matching the stated
0.11.0 stance of stable surfaces, better underlying data.

# Relationship to other work

- **#93 (empty sections)** — same subsystem. The lead-fragment rule and the empty-section rule should be
  decided together (do not mint empty lead rows). Fold #93's decision into this work.
- **#27 (MCP/TUI surface alignment)** — the *consumer* of total coverage. This briefing is the data
  precondition; the actual `get_page(section=)` / lighter-`routeros_search()` design stays in #27 and is
  explicitly **not** proposed here.
- **#95 (schema/ETL umbrella)** — this is a schema/ETL finding of exactly the kind #95 tracks; recorded
  there as a not-yet-filed child (promotion to an agent-ready issue is earned once the lead-anchor
  convention and the reconciliation allowance are pinned — see #95's own E2–E4 discipline).
- **B-0012 (Docusaurus migration)** — the h1–h3 split and h4–h6 fold originate there; this refines that
  overlay from "partial" to "total" without changing the whole-page store.
- **B-0022 / #104 (export)** — the surface that surfaced this. Per-TSV cosmetic findings (callouts wanting
  page/section *names*, changelog column order) are export-output shape and live in #104; this briefing is
  the underlying schema question, kept separate on purpose.

# Open questions

- **Lead anchor convention:** empty string vs. a reserved `#lead`/`#_lead` token. Empty string is smallest
  but is easy to mistake for "unset"; a reserved token is self-documenting but must be guaranteed
  collision-free against `slugify()` output.
- **Exact reconciliation:** bytes won't reconcile perfectly unless heading-text lines, the title, and the
  AI-summary blockquote are each assigned a home. Is a *defined structural allowance* (heading lines belong
  to no fragment, counted separately) acceptable, or do we want literal `sum == page`? The former is
  simpler and still catches drift.
- **Is the lead fragment FTS-indexed as a section?** Leaning yes (future section-level search needs it), but
  it must be additive to page FTS, not double-counted in a way that skews BM25. Verify against the #26
  ranking-regression fixtures before committing.
- **h4–h6 (Option B):** parked for #27, but worth a cheap count now — how many pages are, like
  `hotspot-customisation`, dominated by h4 structure? If it's a handful, A alone is enough; if it's broad,
  #27 will want B sooner.
