---
id: B-0022-runtime-sqlite-dataset-exports
topic: Runtime SQLite-only dataset exports for local audit and future static hosting
status: open
related_tasks: ["#90", "#91", "#92", "#93", "#94", "#95", "#100", "#101"]
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

Every count in this briefing comes from the **CI-built release artifact v0.11.0-rc.99**
(schema v10, 363 Docusaurus pages, `source_commit` 67edb80 — the #92 merge) — not a local rebuild. CI is
the truer source of truth because it is what npm consumers receive, and because `export` is meant to
follow the DB-based extract rather than a developer's working state. Counts were re-derived after #90 and
#92 landed; the pre-#90 figures from the original rc.97 pass are retained below only where the delta is
the point.

This matters more than it sounds: a local `--from-cache` rebuild yields 365 pages against CI's 363, and
grounding against a stale repo-root DB produced a wrong conclusion during this pass (that
`schema_nodes`/`schema_node_presence` ship empty — they ship with 41,967 nodes). Knowing which DB is
under the question is a prerequisite for trusting any of this; #94 tracks making that legible.

Note for anyone re-deriving these: `bun:sqlite` fails with `SQLITE_CANTOPEN` opening a downloaded
release DB with `{ readonly: true }` (WAL mode wants to create a `-shm` sidecar). The `sqlite3` CLI and a
read-write open on a scratch copy both work.

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

Section identity was a schema problem, not an export problem — **#90, now landed**. The workaround this
briefing originally specified (emit `section` as stored plus a `section_anchor` resolved only where the
join is unique) is obsolete: `properties.section_id` is a real foreign key, and on rc.99 **4,569 of 4,581
properties carry one**. `export` joins it directly. `properties.section` is retained as the raw
nearest-heading text and the two deliberately disagree under an h4–h6 — both are worth emitting, since
the disagreement is itself a fact about the corpus.

`properties.source_table_row_id` (added by #92) links a property back to the exact `page_table_rows` row
it came from: 4,519 of 4,581 have one, and the 62 that do not are the bullet-list properties. That link is
what makes the coverage audit below possible at all.

## Pages, fragments, and tables

`pages.tsv` provides two kinds of row in one pivot-like audit view:

- a page rollup with `rosetta_id`, `slug`, `title`, `url`, stored `word_count`, derived text/code byte
  counts, section count, and table counts; and
- one row per `sections` record with `anchor_id`, `heading`, `level`, `sort_order`, `word_count`, byte
  counts, and table/table-row counts for that fragment.

The **sizing** is the point here, not the content. Pages run p50 7.6KB / p90 28KB / p99 85KB and reach
**155KB** (`bridging-and-switching`); sections are far better behaved at p50 730B, p90 3.3KB, p99 10.7KB,
max 34KB. That spread is a concrete argument that sections, not pages, are the sane retrieval unit, and
that any page-level `limit` is really a truncation policy. The 129 empty sections (4.4%) should be
*flagged* — the existing `word_count = 0` is enough — but they are not an export problem; their cost is a
wasted `get_page(section=)` call, which is #93.

**Tables are the reason this family matters, and #92 has landed.** The whole corpus is now stored:
**855 tables / 8,287 data rows / 25,286 cells across 179 pages** (`page_tables`, `page_table_rows`,
`page_table_cells`), with `raw_markdown` retained for reversibility. 839 of 855 tables resolve to a
`section_id`; the 16 that do not are genuinely page-level, above the first heading. The uniformity the
original pass hoped for held up: zero HTML `<table>` elements, no MDX table forms, 79% two-column, and
only **16 ragged tables**.

This **removes a constraint rather than satisfying one**. The original briefing warned that `export` must
not invent its own Markdown parser and must reuse `splitTableRow`. That is now moot: `export` reads
tables from SQLite like any other dataset and needs no parser at all. The DB-only boundary got easier to
hold, not harder.

Per-fragment table files (`pages/<page-slug>/<fragment>[--N].tsv`) stay in scope: 647 sections hold at
least one table, **83 hold more than one** (max 38, in `tg-lr-setup-guide`) and need a deterministic
suffix.

## Callouts

`callouts.tsv` directly supports page, type, order, and text. The missing section attribution — the same
root as #90 — **is fixed**: 839 of 943 callouts now carry a `section_id`. The remaining 104 NULLs are
honest page-level content sitting above the first heading, not a defect, and `export` should emit them as
empty rather than inventing an attribution.

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

| Issue | Finding | Status |
|---|---|---|
| [#90](https://github.com/tikoci/rosetta/issues/90) | 165 properties destroyed on insert; `properties.section` is heading text (28% unresolvable); `callouts` has no section attribution | ✅ landed (rc.98) |
| [#92](https://github.com/tikoci/rosetta/issues/92) | 257 non-property tables discarded; `splitTableRow` module-private; parse all tables, filter property-shaped | ✅ landed (rc.99) |
| [#91](https://github.com/tikoci/rosetta/issues/91) | `command_versions` arch-blind; 18 dual-arch versions are last-writer-wins | open |
| [#93](https://github.com/tikoci/rosetta/issues/93) | 129 empty sections waste a `get_page(section=)` call | parked |
| [#94](https://github.com/tikoci/rosetta/issues/94) | No check that the resolved DB matches the codebase | open |

None of them block `export`, and `export` does not block any of them. The intended order is to fix the
important ones first, then build the first `export` against a corrected schema.

## New finding: property tables the cell gate silently skips

#92's stored corpus makes a gap visible that was previously unmeasurable, and it is the clearest example
yet of the audit doing its job — it is only findable because tables are now retained *whether or not* they
became properties.

`parseProperties` gates on the table header (`/\b(property|parameter)\b/i`) and then requires each row's
first cell to match `/\*\*([a-z0-9][a-z0-9-]*)\*\*/i` — a **bold, kebab-case** name. **27 tables pass the
header gate and yield zero properties**, because the corpus documents property names in at least three
other conventions:

| Convention | Rows | Example |
|---|---|---|
| `` `backticked` `` | 70 | `route-selection-and-filtering` — `` `dst-len` ``, `` `bgp-med` `` |
| plain kebab, no emphasis | 91 | `dns` [Adlist] — `url`, `ssl-verify`, `match-count` |
| bold with spaces | 45 | `css106` [PoE] — `**PoE Out**` |
| other / mixed | 108 | `mikrotik-tag-advertisement-formats` packet-structure tables |

**These are not all properties, and that is the point of the issue.** Spot-checked against rc.99:

- **Real and missing.** `route-selection-and-filtering` has **zero** rows in `properties` despite two
  tables headed `Property | Type | Description` holding 70 rows of genuine routing-filter properties;
  **57 of those names appear nowhere in the corpus**. `dns` [Adlist]'s `url` / `ssl-verify` /
  `match-count` are likewise absent from that page's 42 properties.
- **Correctly rejected.** `disks` [Flags] documents CLI flags (`**X - disabled**`), `css106` [PoE]
  documents WebFig UI labels, and `profiler` [Classifiers] lists *values* (`bgp`, `bfd`) rather than
  properties. Loosening the gate naively would import all of these as fake properties.

So the work is classification, not a regex tweak — and it is tractable for the same reason #92's ragged
tables were: **27 tables is small enough to enumerate and decide by hand.** Note that #90's `parsed ==
stored` assert cannot catch this class: these rows are never parsed, so nothing is dropped to detect.

Distinct from **#61**, which covers properties with *no table at all* (firewall prose bullets, dotted wifi
names) and the doc↔inspect alignment question. This is the narrower complement: a property-shaped table
exists and the cell gate skips it. Tracked as **#100**.

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

The corpus supports it. **No scalar column an export would emit contains a tab** — re-verified on rc.99
across 18 candidate columns (`properties.name`/`description`/`type`/`default_val`/`section`,
`changelogs.description`, `callouts.content`, `video_segments.transcript`, `videos.title`,
`pages.title`/`slug`, `sections.heading`/`anchor_id`, `page_tables.source_heading`,
`hardware_catalog.specs_json`, `device_aliases.alias`, `commands.path`) — **including the 25,286
`page_table_cells.value` rows that #92 added since the original pass**, which is the one place new tabs
could plausibly have entered. Tabs exist only inside fenced code blocks in `pages.text` (13 pages), which
never become a TSV cell. So plain tab-delimited output with no quoting is lossless and stays parseable by
`awk -F '\t'` and RouterOS `:deserialize`. No column carries a CR, so LF endings are safe too.

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

`export` must not invent its own Markdown parser — and after #92 it has no reason to, since cells are
stored already-parsed. The rule survives as a *boundary* rather than a shared-code requirement: if a
future dataset seems to need re-parsing `raw_markdown`, that is a signal the extractor should be storing
the value, not that `export` should grow a parser. The original hazard still explains why: 1,420 table
cells contain a literal `|` after unescaping, so a naive `split("|")` reports 374 ragged tables against a
true 16 — which is also why a downstream `awk -F'|'` consumer would silently corrupt data, and why
per-fragment TSV output is more useful than handing people the Markdown back.

# Working direction

Use the export to **measure and expose** the current artifact rather than to design every future schema.
Products resolve to one catalog plus per-product specs. Pages/tables *were* the least settled area; #92
settled it by storing all tables rather than only the ones today's schema models, which turned the
export's hardest chunk into a straight DB read. Commands stay narrow, and honest about what #91 prevents
them from claiming.

The audit has now paid for itself twice before exporting a single file — #90 (real loss in the shipped
artifact) and #100 (property tables never parsed) were both found by asking what the DB could not
produce. That is the argument for keeping `export` honest about omissions rather than letting it paper
over them: its value is in what it fails to emit.

The first useful output should favor honest omissions and coverage summaries over cache fallbacks or
re-parsing hidden inside `export`. Schema fixes and the export are independent tracks, sequenced only
because building the export against a corrected schema is less wasted work.

# Next steps

Steps 1–4 of the original plan are **done**: #90 and #92 landed, and the "census the 257 non-property
tables" step became a DB query rather than a parsing exercise — its output is the new finding above
(#100) plus the shape data now folded into the Pages/tables section. What remains is the export itself,
plus one schema finding the census produced.

The export decomposes into four chunks. **E1 blocks the rest; E2–E4 are mutually independent** and can be
picked up in any order or in parallel, because each one only adds files under a spine E1 has already
fixed. Sizing assumes one agent session each.

| Chunk | Scope | Depends on | Issue |
|---|---|---|---|
| **E1 — spine** | `export` command, DB resolution/readiness, output directory, TSV serializer + escape guard, `manifest.toml`, and two proof datasets: `changelog.tsv` (trivially direct) and `callouts.tsv` (the only multiline scalar) | — | [#101](https://github.com/tikoci/rosetta/issues/101) |
| **E2 — flat datasets** | `properties.tsv`, `videos.tsv`, `commands.tsv`, `pages.tsv` | E1 | not filed |
| **E3 — products** | `products/products.tsv`, `products/matrix.tsv`, `products/<id>/specs.tsv` | E1 | not filed |
| **E4 — per-fragment tables** | `pages/<page-slug>/<fragment>[--N].tsv` from `page_tables` | E1 | not filed |

E2–E4 are deliberately **not filed yet**. Their specs are only settled once E1 fixes the contract, and an
issue is a promotion earned when acceptance criteria stop moving — not a placeholder. File them from this
table when E1 lands.

**E1 carries all the contract decisions**, which is why it is worth doing alone and first rather than
folding into a bigger "build the export" task. It must settle: the escape convention for the 162 multiline
`callouts.content` rows and the general "any value that would produce invalid TSV" backstop; SQL `NULL`
vs. empty-string; the shared word-count rule; deterministic row/column ordering; filesystem-safe name
encoding with the encoded name emitted as its own column; and overwrite-vs-replace semantics. Pairing
`changelog.tsv` with `callouts.tsv` is deliberate — one dataset that needs nothing and one that exercises
every hard part of the serializer, so the contract is proven by real rows rather than asserted.

E2–E4 are then mostly SQL plus the spine. E3 reuses `exportDevicesCsv()`'s query and changes only
serialization. E4 needs no Markdown parser at all now that #92 stores cells — its real work is the
deterministic `--N` suffix for the 83 multi-table sections and filesystem-safe slugs.

Independent of the export, and **not blocking it**: **#100** (property tables the cell gate skips) is the
census's own finding and stands on its own merits; **#91** and **#94** remain open from the original pass.

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
