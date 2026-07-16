---
id: B-0022-runtime-sqlite-dataset-exports
topic: Runtime SQLite-only dataset exports for local audit and future static hosting
status: open
related_tasks: ["#90", "#91", "#92", "#93", "#94", "#95"]
created: 2026-07-15
last_revisited: 2026-07-15
---

# Question

What useful, spreadsheet-friendly datasets can rosetta export from its **runtime SQLite database
alone**, and what does attempting those exports reveal that the current schema or ETL does not retain?

The proposed first surface is deliberately small:

```sh
bunx @tikoci/rosetta export /tmp/rosetta-datasets
```

It creates a directory containing a predictable set of top-level summary files plus subdirectories
where a subject naturally has per-item detail (for example, product specs or page tables). A future
subdirectory might carry non-tabular details such as transcript text and metadata, but the initial pass
does not need to export every DB value in every possible representation.

There are no CI or GitHub Pages changes in this pass, and no flags for partial exports, formats, or
other options. (`@tikoci/rosetta`, with a slash, is the canonical package name.)

# Why this is worth doing

This is not only another presentation surface. A DB-only export is a practical audit of the artifact
rosetta actually ships:

- Maintainers can import broad, flat views into Numbers, Excel, or another analysis tool and perform
  manual queries without first writing SQL.
- Every field that cannot be produced from the runtime DB identifies a schema/ETL blind spot rather
  than being silently recovered from `matrix/`, transcript caches, assessment JSON, fetched Markdown,
  or another repo-only input.
- Page, section, table, word, row, and byte distributions can expose unbalanced retrieval units and
  inform later MCP/TUI work such as `limit` behavior or first-class handling for unusually large or
  structured pages.
- MikroTik itself is a plausible audit audience while the Docusaurus manual is still new. A TSV that
  makes missing values in a column visible is easier to discuss than a SQL recipe or agent-generated
  prose summarizing internal queries, and it can point directly at source-documentation gaps.
- Many MikroTik users, administrators, and partners already work in spreadsheets and do not use AI
  agents. Rosetta's ETL can still provide useful standalone data to them through familiar tools.
- A deterministic directory is a natural precursor to publishing release-scoped static datasets on
  GitHub Pages, where `curl`, `fetch()`, `requests`, and `awk` can consume ETL results without speaking
  SQLite, MCP, or the TUI.

This complements B-0003's decision not to expose a general `run_sql` MCP tool. It is a bounded,
read-only set of bulk datasets, not arbitrary SQL execution in an agent-facing request path.

## Why a surface rather than an audit script

The obvious objection is that a throwaway `scripts/census.ts` would have produced the findings in #95
without shipping anything. The counter is transparency, and it is the reason to prefer files:

- A script with no durable intermediate output becomes a thing future agents "fix" until it stops
  complaining, or a source of truth of its own that no one reviews. Files a human opens in Numbers
  cannot quietly drift.
- The export is deliberately an **independent surface**: it re-derives the DB's contents without going
  through the query/classifier path, so it functions as a design audit of the core database rather than
  a report from the code under test.
- The findings it produced are exactly the kind that are hard to see from MCP interactions — a
  `get_page(section=)` returning nothing, or a per-version count that quietly means one architecture.

Both are true at once: `src/eval/db-census.ts` exists to re-check the #95 findings after fixes land,
and it is not a substitute for the export.

# Hard boundary: the shipped DB is the source

At runtime, `export` may read only the database selected through rosetta's normal DB resolution. It may
run SQL, derive counts, decode stored JSON, and do small deterministic transformations of values already
stored in SQLite. It must not read project caches or source artifacts, inspect the git checkout, fetch a
network source, or rerun an extractor.

In particular, the first pass must not fall back to:

- `matrix/**`, `device-map.tsv`, `hardware-unmatched.tsv`, or hardware assessment artifacts;
- `transcripts/**` or `manual/pages/**`;
- `inspect.json`, `deep-inspect.json`, or restraml's GitHub Pages output;
- source Markdown/HTML outside `pages.text` / `sections.text`; or
- live MikroTik or YouTube endpoints.

An unavailable column should be omitted or explicitly documented as unavailable. Recovering it from a
cache would defeat the audit.

The target is the current Docusaurus-built runtime artifact. `extract-docusaurus.ts` deletes and rebuilds
`pages`/`sections`/`properties`/`callouts` on every run, so prose sources do not mix and the exporter
needs no reduced compatibility mode for historical Confluence release databases.

# Grounding

Every count in this briefing comes from the **CI-built release artifact v0.11.0-rc.97**
(`~/.rosetta/ros-help.db`, schema v8, 363 Docusaurus pages, `source_commit` 6a7e800) — not a local
rebuild. CI is the truer source of truth because it is what npm consumers receive, and because `export`
is meant to follow the DB-based extract rather than a developer's working state.

This matters more than it sounds: a local `--from-cache` rebuild yields 365 pages against CI's 363, and
grounding against a stale repo-root DB produced a wrong conclusion during this pass (that
`schema_nodes`/`schema_node_presence` ship empty — they ship with 41,967 nodes). Knowing which DB is
under the question is a prerequisite for trusting any of this; #94 tracks making that legible.

`src/eval/db-census.ts` re-derives every measurement below from a runtime DB alone:

```sh
DB_PATH=~/.rosetta/ros-help.db bun run src/eval/db-census.ts
```

# Working export families and current feasibility

This is a feasibility inventory, not a final filename or column contract. Direct columns should
generally retain their SQLite names: the correspondence makes each export easier to trace and acts as a
loose column-name audit. Derived or joined values still need names chosen for clarity in the file where
they appear; matching SQL mechanically is less important than accurately describing the value.

## Changelog

`changelog.tsv` is directly feasible. `changelogs` stores `version`, `is_breaking`, `category`,
`description`, `released`, and source order. The original `version`, `breaking`, `category`, `text`
sketch should therefore lean toward the existing names (`is_breaking`, `description`) unless the wider
export context shows a good reason to rename them.

## Videos

`videos.tsv` is mostly direct. `videos` stores title, upload date, YouTube ID/URL, duration, view/like
counts, and whether chapters exist. Joining `video_segments` provides segment/chapter counts plus
transcript word and UTF-8 byte counts. Every video has at least one segment (658 videos, 2,175 segments;
videos without chapters carry a single whole-video segment), so the join never drops a row. Full
transcript text is also in the DB, so a later video detail directory stays within the DB-only constraint.

That detail directory should be keyed on a **filesystem-encoded video title**, not the YouTube ID — an
ID forces a cross-reference to be legible, which defeats the point of browsing a directory. The raw ID
and URL stay as columns in `videos.tsv`, and the encoded directory name should itself be a column so the
match between row and directory is definitive rather than inferred.

Transcript provenance (automatic vs. author-provided) is not retained; that is #21's scope. Omit the
field, note it in the manifest, add it when the DB can provide it.

## Products

The product data is one family, not a collection of unrelated `devices-*` files. `devices`,
`hardware_catalog`, `device_aliases`, and `hardware_catalog.specs_json` collectively represent rosetta's
product knowledge across the matrix, `/hardware`, and www product sources.

**The catalog is the product identity, not the matrix.** Of 255 `hardware_catalog` rows: 247 have
`specs_json`, 242 have a `/hardware` slug, 224 have a www code, and only **156 link to a matrix `devices`
row**. The matrix is a manually updated source that predates the three-source scheme, and `/hardware` can
grow between builds without any deliberate action — so matrix-presence is a *coverage signal to audit*,
not a gate on what counts as a product. The normalized three-source shape is the "new matrix"; keying
`products.tsv` on `hardware_catalog.rosetta_device_id` is what makes the other 99 products visible at
all.

`specs_json` holds 142 distinct keys with a steep coverage curve: a head at 74–85% (`Product code`,
`Suggested price`, `MTBF`, `Max power consumption`, `Storage type`/`size`, `CPU`, `CPU core count`,
`Architecture`, `Size of RAM`, `RouterOS license`) and a long sparse tail. Alongside that head,
`products.tsv` should carry the **accessory/switch-chip capability keys**, which are the interesting
hardware differentiators even where coverage is lower:

| Key | Products |
|---|---|
| `10/100/1000 Ethernet ports` | 152 |
| `Switch chip model` | 126 |
| `Number of USB ports` | 76 |
| `USB slot type` | 74 |
| `SFP+ ports` | 40 |
| `SFP ports` | 34 |
| `MiniPCI-e slots` | 30 |

Plus a total `spec_count` per product, so a sparse row is visibly sparse rather than silently so.

That `specs_json` also carries `_hardware_title` (98%), `_www_title` (85%), and `_www_tagline` (85%)
alongside genuine specs is fine — those are per-source titles, and seeing them next to the normalized
name is itself an audit of how the three sources agree. The exporter should surface them, not filter them.

Files:

- **`products/products.tsv`** — one row per `rosetta_device_id`: source identities/slugs, display
  name/category/lifecycle, matrix presence and common matrix fields, alias count, `spec_count`, the
  high-coverage spec head, and the accessory/switch-chip keys above.
- **`products/matrix.tsv`** — the matrix-backed fields already exposed as
  `rosetta://datasets/devices.csv`. `exportDevicesCsv()` exists and is the query source to reuse,
  changing only serialization.
- **`products/<rosetta_device_id>/specs.tsv`** — a vertical `name`/`value` expansion of every stored
  `specs_json` member, optionally with aliases and source identities. This preserves the 142-key sparse
  tail without turning `products.tsv` into mostly-empty columns.

The earlier page-byte idea is dropped: the catalog stores normalized www facts, not raw `/hardware` or
www page bodies. The size-like audit signals here are row counts, alias counts, `spec_count`, and
per-key coverage.

## Properties

`properties.tsv` joins `properties` to `pages` for `slug`/`rosetta_id`, numeric page ID, title, URL, and
the stored property fields.

Section identity is a schema problem, not an export problem — **#90**. `properties.section` stores
heading text, which destroys 165 properties on insert and leaves 28% of survivors unresolvable to a
section. The resolution logic does not belong in `export`; the exporter should emit `section` as stored
plus a resolved `section_anchor` where the join is unique, leaving it empty where it is not, so the file
shows the gap rather than papering over it. Once #90 lands, `section_id` makes this direct.

## Pages, fragments, and tables

`pages.tsv` provides two kinds of row in one pivot-like audit view:

- a page rollup with `rosetta_id`, `slug`, `title`, `url`, stored `word_count`, derived text/code byte
  counts, section count, and table counts; and
- one row per `sections` record with `anchor_id`, `heading`, `level`, `sort_order`, `word_count`, byte
  counts, and table/table-row counts for that fragment.

The **sizing** is the point here, not the content. Pages average 13KB of text but reach **155KB**
(`bridging-and-switching`); sections are far better behaved at p50 730B, p90 3.3KB, p99 10.7KB, max 34KB.
That spread is a concrete argument that sections, not pages, are the sane retrieval unit, and that any
page-level `limit` is really a truncation policy. The 129 empty sections (4.4%) should be *flagged* — the
existing `word_count = 0` is enough — but they are not an export problem; their cost is a wasted
`get_page(section=)` call, which is #93.

**Tables are the reason this family matters.** The corpus has 852 pipe tables (8,258 data rows) across
180 pages, of which **595 are property-shaped and already extracted, and 257 are discarded entirely**.
The uniformity is good news: zero HTML `<table>` elements, no MDX table forms, 79% two-column, and only
**14 genuinely ragged tables** — a small enough exception set to enumerate and handle deliberately rather
than guess at.

The direction (#92) is to invert the current order: parse **all** tables generically in core, then filter
the property-shaped ones to keep MCP/TUI behaviour unchanged. Exporting only the tables today's schema
happens to model would pre-filter the corpus by the very assumption the audit exists to test. The 70%
overlap is evidence that `properties` and the table corpus are the same corpus viewed twice.

Why all tables, beyond the export: large pages need natural seams to split on, and tables are one of the
few; `routeros_get_page` could return tables structurally instead of as Markdown the model re-parses; and
half a dozen "special tables" are already known to be worth promoting (B-0007), with no way to discover
the rest today.

Per-fragment table files (`pages/<page-slug>/<fragment>[--N].tsv`) are therefore in scope, with 85 of 701
fragments containing more than one table and needing a deterministic suffix.

## Callouts

`callouts.tsv` directly supports page, type, order, and text. `callouts` has no section attribution — the
same root as #90, and the same conclusion: the extractor already tracks heading context while parsing
properties and simply does not record it for callouts. That belongs in ETL, not in `export`.

`callouts.content` is the only multiline scalar in the export set (162 of 943 rows). It is not long
enough to justify sidecars, which would make it *less* readable; encode it in place — see below.

## Commands

Keep commands shallow, but narrow rather than loose. `commands.type` gives `dir`/`cmd`/`arg` counts
directly (572 / 5,296 / 36,099 of 41,967), so those need a definition, not new logic.

Per-version path counts must wait on **#91**: `command_versions` has no `arch` column while 18 versions
exist for both x86 and arm64, and extraction is delete-then-reinsert, so those path sets are
last-writer-wins. A version→count column would present one architecture's number as a fact about the
version. Either omit it or carry an explicit `arch_unknown` marker until #91 lands.

Versions must use the existing numeric/beta/RC comparator, never SQL lexical order — `7.9.2` sorts above
`7.24rc1` as a string, which is exactly how this pass briefly reached a wrong conclusion about arch
coverage.

`schema_nodes`/`schema_node_presence` are populated (41,967 nodes, pruned to a single active head) and
working as designed per `command-versions-vs-presence.instructions.md`. Per-architecture command work
stays with #25/#33.

# Schema/ETL findings, now tracked

The audit's findings are GitHub issues under umbrella **#95** (label `export-audit`), not prose here:

| Issue | Finding |
|---|---|
| [#90](https://github.com/tikoci/rosetta/issues/90) | 165 properties destroyed on insert; `properties.section` is heading text (28% unresolvable); `callouts` has no section attribution |
| [#91](https://github.com/tikoci/rosetta/issues/91) | `command_versions` arch-blind; 18 dual-arch versions are last-writer-wins |
| [#92](https://github.com/tikoci/rosetta/issues/92) | 257 non-property tables discarded; `splitTableRow` module-private; parse all tables, filter property-shaped |
| [#93](https://github.com/tikoci/rosetta/issues/93) | 129 empty sections waste a `get_page(section=)` call |
| [#94](https://github.com/tikoci/rosetta/issues/94) | No check that the resolved DB matches the codebase |

None of them block `export`, and `export` does not block any of them. The intended order is to fix the
important ones first, then build the first `export` against a corrected schema.

Also open and out of scope here: #21 (transcript provenance), #25/#33 (arch + CLI Reference), B-0007
(device-capability tables).

# Strawman local directory

```text
rosetta-datasets/
├── manifest.toml
├── changelog.tsv
├── videos.tsv
├── properties.tsv
├── pages.tsv
├── commands.tsv
├── callouts.tsv
├── products/
│   ├── products.tsv
│   ├── matrix.tsv
│   └── <rosetta-device-id>/
│       └── specs.tsv
└── pages/
    └── <page-slug>/
        ├── <fragment>.tsv
        └── <fragment>--2.tsv
```

The two alternate slug-keyed product views are not included: `source_hardware_slug` and `source_www_code`
are already columns on `products.tsv`, so a spreadsheet user sorts a column instead of opening a third
near-identical file.

`manifest.toml` carries what a TSV cannot: `db_meta` provenance (release tag, schema version, source
commit, build time), generated file names and row counts, coverage summaries, and honest disclosures —
which fields are unavailable and why, and which claims the data cannot support (per-version architecture,
until #91).

Subdirectories are not restricted to TSV forever; a video detail export could pair `transcript.txt` with
`metadata.toml`.

# TSV as the working tabular format

TSV is the working default. GitHub and editors render it, spreadsheets import it, it resembles direct SQL
output, and it is lighter than CSV for data whose values routinely contain commas.

The corpus supports it. **No scalar column an export would emit contains a tab** — verified across
`properties.description`, `properties.name`, `changelogs.description`, `callouts.content`,
`video_segments.transcript`, and all 8,258 Markdown table cells. Tabs exist only inside fenced code blocks
in `pages.text` (13 pages), which never become a TSV cell. So plain tab-delimited output with no quoting
is lossless and stays parseable by `awk -F '\t'` and RouterOS `:deserialize`.

The one exception is newlines in `callouts.content` (162 rows). Adopting quote-aware TSV corpus-wide would
cost every simple consumer the one-line-equals-one-record property to serve those rows, and sidecars would
hurt readability for content this short. Encode in place instead: a documented, reversible escape, or a
Unicode replacement/visible-marker convention.

More generally, **`export` should guard rather than assume**. "No tabs today" is a measured property, not
an invariant, so the serializer needs defined behavior — a reversible re-encoding backstop against any
value that would produce invalid TSV, applied as a general rule and not only to callouts. A companion
ETL-hygiene test asserting the absence of tabs outside code blocks is probably worth having on its own
merits (#92 is the natural home, since it also needs an escaped-pipe test).

Output is UTF-8 with LF endings, a header row, stable row/column ordering, explicit SQL `NULL` handling,
and a single shared word-count rule. **Raw slugs and fragments stay in columns** even where filesystem-safe
names must be sanitized — and where a row corresponds to a generated file or directory, the encoded name
should be its own column so the match is definitive rather than reconstructed.

`export` must not invent its own Markdown parser. The shared `splitTableRow` (#92) is the single
implementation; sharpen it where needed and handle shape differences after parsing. Note 1,420 table cells
contain a literal `|` after unescaping — which is why a naive `split("|")` reports 374 ragged tables
against a true 14, and why a downstream `awk -F'|'` consumer would silently corrupt data.

# Working direction

Use the export to **measure and expose** the current artifact rather than to design every future schema.
Products resolve to one catalog plus per-product specs. Pages/tables are the highest-value and least
settled area, and the decision there is to take all tables rather than only the ones today's schema
models. Commands stay narrow, and honest about what #91 prevents them from claiming.

The first useful output should favor honest omissions and coverage summaries over cache fallbacks or
re-parsing hidden inside `export`. Schema fixes and the export are independent tracks, sequenced only
because building the export against a corrected schema is less wasted work.

# Next steps

Session-scoped, in the intended order. The first three are #95 work, not export work.

1. **#90 — properties data loss + section identity.** Highest value: real loss in the shipped artifact,
   self-contained (both parsers already walk the same Markdown in one pass), and a prerequisite #92 and
   #93 both want. The one open decision is whether h4–h6 headings mint section rows or resolve to their
   nearest h1–h3 ancestor; the latter preserves the retrieval unit and is the likely answer.
2. **#92 step 1 — export `splitTableRow` with an escaped-pipe test.** One-line change that prevents the
   44%-wrong second implementation, and unblocks any table work.
3. **#92 steps 2–3 — generic table representation, properties derived as a filter.** The largest schema
   change in the briefing; wants #90's section identity first.
4. **Census the 257 non-property tables** before or during step 3 — group by header shape and page to
   inform the generic schema and to tell B-0007's device tables apart from the rest. Cheap, and it is the
   input to the biggest design decision here.
5. **First `export`, later session.** Reuse normal DB resolution/readiness, `exportDevicesCsv()`, and the
   shared table parser; share deterministic TSV/TOML/path helpers. Overwriting previous output is the
   working assumption; safe replacement needs definition before implementation.

# Deferred deliberately

Publication and Pages layout, release/version URL scheme, retention, compression, caching, and large-scale
JSON. All depend on the local output proving useful.

Also deferred: **alternative directory groupings** — spinning `pages/` on Docusaurus TOC parents, or
`products/` on device categories, rather than a flat slug/id layout. Grouping is a real readability
question for a human browsing the output, but it should follow a stable file set rather than shape it.

# Open questions

- Does `pages.tsv` mixing page-rollup and section rows in one file actually read well in a spreadsheet,
  or does the pivot-like shape want splitting once real data is in front of us? This is a "look at it in
  Numbers" question, not an argue-about-it question.
- Is the page/section sizing data escaping this briefing's scope? It is arguably more valuable to the
  MCP/TUI retrieval-unit work (#27) than to the export, and may deserve its own briefing rather than
  living here as a byproduct.
