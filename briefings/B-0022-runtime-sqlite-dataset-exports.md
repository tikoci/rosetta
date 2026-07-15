---
id: B-0022-runtime-sqlite-dataset-exports
topic: Runtime SQLite-only dataset exports for local audit and future static hosting
status: open
related_tasks: []
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

The audit premise has already paid for itself. Working through the export column by column surfaced
three defects in shipped data that no current test or surface reports: 165 properties destroyed on
insert, per-version command counts that silently reflect one architecture, and 501 properties whose
recorded section cannot exist as a row. Those are findings about rosetta's data, not about file formats.

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

The target is the current Docusaurus-built runtime artifact. The exporter does not need a reduced
compatibility mode for historical Confluence release databases.

The Confluence-contamination worry is settled and can stop being carried as a risk. `extract-docusaurus.ts`
deletes and rebuilds `pages`/`sections`/`properties`/`callouts` on every run, and a fresh build yields
365 pages all under `manual.mikrotik.com` with zero `help.mikrotik.com` rows. Prose sources do not mix.

There is a **developer-environment trap** worth stating plainly, because it invalidates casual grounding:
the repo-root `ros-help.db` is not the artifact this briefing targets. It is the v0.10.0 **Confluence**
corpus (321 pages, all `help.mikrotik.com`), it is held open by running MCP servers, and the in-session
`routeros_*` MCP tools answer from it. Any census of pages, sections, properties, callouts, or tables
must be run against a freshly built Docusaurus DB at a scratch `DB_PATH`, or it measures the wrong
corpus. Product, video, changelog, and command tables do not come from Docusaurus prose and are the same
in both.

# Working export families and current feasibility

This is a feasibility inventory, not a final filename or column contract. Direct columns should
generally retain their SQLite names: the correspondence makes each export easier to trace and acts as a
loose column-name audit. Derived or joined values still need names chosen for clarity in the file where
they appear; matching SQL mechanically is less important than accurately describing the value.

Counts below come from a `--from-cache` Docusaurus build (365 pages, 2,931 sections, 4,410 properties,
945 callouts) for prose, and from the current catalog/command/video tables for the rest.

## Changelog

`changelog.tsv` is directly feasible. `changelogs` stores `version`, `is_breaking`, `category`,
`description`, `released`, and source order. The original `version`, `breaking`, `category`, `text`
sketch should therefore lean toward the existing names (`is_breaking`, `description`) unless the wider
export context shows a good reason to rename them.

## Videos

`videos.tsv` is mostly direct. `videos` stores title, upload date, YouTube ID/URL, duration, view/like
counts, and whether chapters exist. Joining `video_segments` provides segment/chapter counts plus
transcript word and UTF-8 byte counts. Every video has at least one segment (538 videos, 1,953 segments;
232 chaptered, 306 without chapters carrying a single whole-video segment), so the join never drops a row.
Full transcript text is also in the DB, so a later `videos/<video_id>/` detail directory could remain
within the DB-only constraint.

The schema does not yet retain transcript provenance such as automatic vs. author-provided. That is
already tracked by [#21](https://github.com/tikoci/rosetta/issues/21), including the proposed
`transcript_source` field and the harder question of how reliably it can be detected. It should not
block this export: omit the field now, make the gap visible in the manifest, and add it when the DB can
provide it.

## Products

The product data is better considered one family than a collection of unrelated `devices-*` files.
`devices`, `hardware_catalog`, `device_aliases`, and `hardware_catalog.specs_json` collectively represent
rosetta's product knowledge across the matrix, `/hardware`, and www product sources.

Coverage is now measured rather than assumed. Of 255 `hardware_catalog` rows: 247 have `specs_json`, 242
have a `/hardware` slug, 209 have a www code, and only 156 link to a matrix `devices` row. So roughly
**39% of catalog products have no matrix backing** — a `products.tsv` keyed on the catalog is strictly
richer than re-exporting `devices`, and the matrix-presence column is a real audit signal, not a
formality.

`specs_json` holds **142 distinct keys** with a steep coverage curve: a head of keys at 74–85%
(`Product code`, `Suggested price`, `MTBF`, `Max power consumption`, `Storage type`/`size`, `CPU`,
`CPU core count`, `Architecture`, `Size of RAM`, `RouterOS license`) and a long sparse tail. That head
is the answer to "which specs belong in the summary" — it is a coverage cliff, not a judgement call.

One shape problem the export must decide rather than inherit: `specs_json` **mixes provenance metadata
into the spec namespace**. `_hardware_title` (98%), `_www_title` (85%), and `_www_tagline` (85%) are
underscore-prefixed internal fields sitting alongside genuine product specs. A naive vertical expansion
would present them to a spreadsheet user as if they were specs. Either the exporter filters the
underscore prefix (and the convention becomes load-bearing), or ETL should separate them.

Likely useful views to probe are:

- **`products/products.tsv`** — one row per `hardware_catalog.rosetta_device_id`, including source
  identities/slugs, display name/category/lifecycle, matrix presence and common matrix fields, alias
  count, spec count, and the measured high-coverage spec head above. This is the closest DB-only
  successor to the manually produced `hardware-www-matrix.csv`.
- **`products/matrix.tsv`** — the normalized matrix-backed fields currently exposed as
  `rosetta://datasets/devices.csv`. `exportDevicesCsv()` already exists and is the obvious query source
  to reuse, changing only the serialization.
- **`products/<rosetta_device_id>/specs.tsv`** — a vertical `name`/`value` expansion of every stored
  `specs_json` member for that product, optionally accompanied by aliases and source identities. This
  preserves the 142-key sparse tail without turning `products.tsv` into mostly-empty columns.

The two alternate slug-keyed views (`by-hardware-slug.tsv`, `by-www-slug.tsv`) should be **dropped**.
Both `source_hardware_slug` and `source_www_code` are already columns on `products.tsv`, and both are
near-unique per product, so the alternate files would be the same rows in a different sort order minus
the products lacking that source. A spreadsheet user sorts a column; they do not need a third file to do
it. If a genuine need appears later it is a trivial re-emit.

The earlier page-byte idea was mistaken and is dropped. The catalog stores normalized www facts, not
raw `/hardware` or www page bodies. Useful size-like audit signals here are row counts, alias counts,
`spec_count`, and per-key coverage across products—not byte counts of `specs_json`.

## Properties and section identity

This was the briefing's "measure it before declaring a migration" item. It has been measured, and the
finding is stronger than expected: **`properties.section` storing heading text rather than a section
identity is actively destroying data in the shipped artifact.**

Of 4,575 properties parsed from the current corpus, only **4,410 are stored**. The
`UNIQUE(page_id, name, section)` constraint combined with `INSERT OR IGNORE` silently discards **165
rows** — a property whose page has two same-named headings collapses into whichever came first. Real
examples: `ppp-aaa` loses `comment`, `local-address`, `name`, and `remote-address` because the page has
several `Properties` headings; `dot1x` loses `interface` under a repeated `Server`. Nothing reports this.

Of the 4,410 that survive, joining `properties.section` to `sections.heading` within a page gives:

| Result | Rows | Share |
|---|---|---|
| Unique match | 3,191 | 72% |
| Ambiguous (2–8 candidate sections) | 718 | 16% |
| No matching section row at all | 501 | 11% |

The two failure modes have distinct, already-understood causes in `extract-docusaurus.ts`:

- **The 501 "no match" are not missing data — they are a level mismatch.** `parseProperties` tracks
  `currentSection` from `#{1,6}` headings; `parseSections` only mints section rows for `#{1,3}`,
  deliberately folding deeper headings into the enclosing section's text. So every property under an
  h4–h6 heading records a `section` string that cannot exist in `sections`. The corpus has 817 h4–h6
  headings against 4,098 h1–h3, and a sample of "no match" values (`Certificate template properties`,
  `Advanced Monitor`, `Port Resources/Usage`, …) confirmed all were h4–h6.
- **The 718 ambiguous are a discarded disambiguation.** `parseSections` already resolves duplicate
  headings into unique `anchor_id`s (`foo`, `foo-1`, `foo-2`); `properties` stores the raw heading text
  and throws that away. The corpus has 86 page/heading pairs that repeat, worst offenders being
  `layer2-misconfiguration` (`Problem`/`Solution`/`Symptoms`, 18× each) and `user-manager`/`ipsec`
  (`Properties`, 8× each).

This reframes the fix. It is not a speculative schema migration justified by export convenience: both
parsers already walk the same Markdown, line by line, in the same extraction pass. Correlating a
property to the section whose line range contains it is local work, and `section_id` then makes the
`UNIQUE` constraint correct instead of lossy. The export is what made the loss visible; the loss would
be worth fixing even if the export were abandoned.

The honest interim behavior for `properties.tsv` is to emit `section` as stored plus a resolved
`section_anchor` where the join is unique and empty where it is not, so the file shows the 28% rather
than papering over it.

## Pages, fragments, and generic tables

`pages.tsv` can provide two kinds of row in one pivot-like audit view:

- a page rollup with `rosetta_id`, `slug`, `title`, `url`, stored `word_count`, derived text/code byte
  counts, section count, and table counts; and
- one row per `sections` record with `anchor_id`, `heading`, `level`, `sort_order`, `word_count`, byte
  counts, and table/table-row counts for that fragment.

The scalar metrics are straightforward and immediately useful as MCP/TUI evidence. Pages average 13KB of
text but run to **153KB** (`bridging-and-switching`, 21,626 words, 50 sections); the ten largest pages
are 17.6% of all page bytes. Sections are far better behaved: p50 730B, p90 3.3KB, p99 10.7KB, max 34KB.
That ~200× page-level spread against a ~15× section-level spread is a concrete argument that sections,
not pages, are the sane retrieval unit, and that any page-level `limit` is really a truncation policy.
The census also found **129 empty sections** (4.4%) — headings with no body — which retrieval currently
treats as real fragments.

The generic-table question is now answered, and it is not the hard part the briefing assumed:

| Measure | Result |
|---|---|
| Pipe tables | 855 across 180/365 pages, 8,278 data rows |
| HTML `<table>` elements | **0** |
| Genuinely ragged tables | **14** (1.6%) |
| Empty-header (layout) tables | 28 |
| Two-column tables | 672 (79%) |
| Property-like header (`Property`/`Parameter` …) | **596 (70%)** |
| Non-property tables | **259** |
| Fragments containing >1 table | 85 / 704 (12%) |

Three conclusions follow, two of which cut against the original framing:

1. **There is no HTML/MDX table problem.** The worry about distinguishing pipe tables from "raw HTML/MDX
   forms" was unfounded: the corpus contains zero `<table>` elements. The shape is uniform pipe syntax,
   overwhelmingly two columns, and 98.4% of tables are internally consistent. A parser is small.
2. **But 70% of tables are already `properties`.** The generic table corpus is mostly a less-structured
   copy of a table rosetta already extracts. Only **259 tables carry information not already modeled**.
   That materially weakens "export every table as a file" and strengthens the narrower question: what is
   in those 259?
3. **Naive parsing is a trap, and the fix is not exported.** RouterOS enum values pervade these tables as
   escaped pipes (`*md5 \| sha1 \| sha256*`), and **1,422 cells contain a literal `|` after unescaping**.
   A `line.split("|")` implementation reports 374 "ragged" tables — 44% — that are simply wrong; the true
   figure using escape-aware splitting is 14. `extract-docusaurus.ts` already has correct
   `splitTableRow`, but it is **module-private and not exported**. Any second implementation will
   re-introduce this bug, and it is the same reason a downstream `awk -F'|'` consumer would silently
   corrupt data.

So the useful next probe is not "can we parse tables" but "are the 259 non-property tables worth
promoting". Emitting per-fragment table files for the 70% that duplicate `properties` would add files
without adding knowledge.

This still matters beyond the exporter. A generic stored-table representation could retain page/section
context, headers, rows, ordinals, and perhaps raw source; `routeros_get_page` could then return tables
structurally. Property extraction might eventually become a classification over that generic corpus
rather than the only special table parser — the 70% overlap is evidence that this is the *same* corpus
viewed twice, not two corpora. The device-specific tables in B-0007 may still deserve normalized domain
schema.

## Callouts

`callouts.tsv` directly supports page, type, order, and text, but `callouts` has no section/fragment FK.

The briefing suggested re-parsing `pages.text` to recover heading context, and worried it would duplicate
extraction logic. That framing was wrong in a useful way: `parseProperties` **already tracks
`currentSection`** while walking the same Markdown. `parseCallouts` simply does not — it tracks a fence
stack and sort order and never looks at headings. So callout section attribution is not a re-parse
problem or an export problem; it is a field the extractor is positioned to record and does not. That
belongs with the `section_id` work above, not in the exporter.

`callouts.content` is also the **only** multiline scalar in the export set — see below.

## Commands

The original instinct — keep this shallow, just round out the export — does not survive contact with the
data. `commands-by-version.tsv` as specified would be actively misleading.

The direct part is fine: `commands.type` gives `dir`/`cmd`/`arg` counts straight (550 / 5,097 / 34,948 of
40,595), so those columns need only a definition, not new logic.

The version dimension is the problem. `command_versions` has PK `(command_path, ros_version)` — **no
architecture column** — while `ros_versions` has PK `(version, arch)` and holds both `x86` and `arm64`
rows for **17 versions** (7.20.8 through 7.24rc1). `extract-commands.ts` runs
`DELETE FROM command_versions WHERE ros_version = ?` and then re-inserts. That is **last-writer-wins**,
not a merge: for those 17 versions the stored path set reflects whichever architecture was extracted
last, and which one that was is not recorded anywhere. A version→path-count column would present that as
a fact. This is worse than the briefing's "not durably representable today" — the data is not merely
un-exportable per-arch, it is silently one arch wearing the label of the version.

Two further traps sit next to it:

- `schema_nodes` and `schema_node_presence` are **empty** (0 rows) in the current local DB.
  `release.yml` only runs `extract-all-versions.ts` when the `full_versions` input is set, otherwise it
  runs `extract-commands.ts`. So whether these tables ship populated is a per-release property. An export
  that reads them will produce an empty file for some releases and data for others, with no explanation.
  The manifest should record which path built the DB. (Whether published release assets actually ship
  them populated is unverified here and should be checked against a real release asset, not inferred
  from this local file.)
- The version comparator warning is real and easy to underestimate. Preparing this pass, a
  `MIN/MAX(version)` query reported x86 as spanning only 7.1.1–**7.9.2**, which is lexical nonsense —
  `7.9.2` sorts above `7.24rc1` — and led to a wrong conclusion about arch coverage until it was caught.
  Any exporter touching versions must use the existing comparator, and the census scripts should too.

The right move is to keep commands shallow by **narrowing** rather than by summarizing loosely: emit the
`dir`/`cmd`/`arg` totals and the version list, and either omit per-version path counts or carry them only
with an explicit `arch_unknown` marker until `command_versions` can distinguish. Per-architecture command
work stays with the existing command/CLI Reference issues; this briefing should hand them a measured bug
rather than pull their scope forward.

# Schema/ETL findings this audit produced

The directional questions have largely resolved into findings. Ordered by confidence and materiality:

1. **Confirmed data loss — properties.** 165 of 4,575 parsed properties are silently dropped by
   `UNIQUE(page_id, name, section)` + `INSERT OR IGNORE`, because `section` is heading text. Fixing
   section identity fixes the loss. This deserves an issue on its own merits, independent of `export`.
2. **Confirmed integrity bug — command_versions.** Arch-blind PK plus delete-then-reinsert makes 17
   versions' path sets last-writer-wins between x86 and arm64. Deserves an issue; likely belongs to the
   existing command/CLI Reference thread rather than a new one.
3. **Confirmed design gap — section identity.** 28% of properties cannot be uniquely resolved to a
   section (11% because sections stop at h3 while properties track to h6; 16% because `anchor_id`
   disambiguation exists but is discarded). Callouts have no section attribution at all despite the
   extractor already tracking it for properties. One `section_id` change addresses all three.
4. **Resolved — generic tables are easy to parse but mostly redundant.** 855 tables, 0 HTML, 1.6%
   ragged, but 70% already modeled as `properties`. The open question shrinks to the 259 non-property
   tables. `splitTableRow` needs exporting before anything else parses a table.
5. **Resolved — product spec head.** 142 keys, coverage cliff at ~74%, and `specs_json` mixes
   underscore-prefixed provenance with real specs. Alternate slug-keyed views are redundant.
6. **Resolved — TSV is safe.** See below.
7. **Open — release-conditional tables.** `schema_nodes`/`schema_node_presence` populated only on
   `full_versions` releases; the manifest should say which.

Transcript provenance is a real gap already scoped in [#21](https://github.com/tikoci/rosetta/issues/21).

# Strawman local directory

The structure below reflects the census: the two slug-keyed product views are gone, and per-fragment
table files are held back pending the 259-table question.

```text
rosetta-datasets/
├── manifest.toml
├── changelog.tsv
├── videos.tsv
├── properties.tsv
├── pages.tsv
├── commands.tsv
├── callouts.tsv
└── products/
    ├── products.tsv
    ├── matrix.tsv
    └── <rosetta-device-id>/
        └── specs.tsv
```

`manifest.toml` can carry richer structure than a TSV: database/package/schema/release provenance from
`db_meta`, generated file names and row counts, coverage summaries, and known omitted/unavailable
fields. It is the natural home for the census results that do not fit one flat row shape, and for the
honest disclosures this pass has identified — the properties that lost their section, whether the DB was
built with `full_versions`, and which architecture claim cannot be made. JSON remains a possible future
bulk dataset format, not a requirement of this local pass.

Subdirectories are not restricted to TSV forever. For example, a later video detail export could use
`transcript.txt` plus `metadata.toml`.

# TSV as the working tabular format

TSV is a reasonable default, and the consumer-mismatch worry is now mostly retired by measurement rather
than by testing a matrix.

**The corpus contains no tabs.** Zero across `properties.description`, `properties.name`,
`changelogs.description`, `callouts.content`, `pages.title`, `video_segments.transcript`, and all 8,278
Markdown table cells. The hope that ETL avoids tabs is not a hope; it is a measured property. So plain
tab-delimited output with no quoting is lossless for every scalar in the export set, and stays parseable
by `awk -F '\t'` and RouterOS `:deserialize`.

**One exception:** `callouts.content` contains newlines in **163 of 945 rows** (17%). That is the whole
of the multiline problem, and it is confined to one column of one file. Rather than adopting quote-aware
TSV corpus-wide — which would cost every simple consumer the one-line-equals-one-record property to
serve 163 rows — the proportionate options are a documented reversible escape for that column, or moving
callout bodies to sidecars while `callouts.tsv` keeps type/order/page and a reference. The earlier
three-way consumer matrix does not need running; it only needs deciding for this one column.

The serializer still needs defined behavior if a tab ever appears, since "measured absent today" is not
"impossible tomorrow" — but that is a guard, not a design constraint.

Whatever shape wins should be UTF-8 with LF endings, a header row, stable row/column ordering, explicit
SQL `NULL` handling, and a single shared word-count rule. Raw slugs and fragments stay in columns even
when filesystem-safe names must be sanitized.

Note the corpus does contain 1,422 table cells with literal `|`. That does not affect TSV output, but it
is why any consumer or second implementation that splits Markdown tables on `|` is wrong.

# Working direction

Proceed by using the export idea to **measure and expose** the current artifact, not by designing every
future schema now. The census has done much of that already and shifted the weight: the interesting
output of this briefing is turning out to be the schema findings, with the files as the instrument that
produced them.

Two course corrections against the earlier draft:

- **Products got simpler** (three near-identical views collapse to one catalog plus per-product specs).
- **Commands got harder** (the "KISS summary" would have shipped an arch-mixed number as a fact).

The first useful output should favor honest omissions and coverage summaries over cache fallbacks or
complex re-parsing hidden inside `export`. Schema improvement should not block getting files — but the
properties data loss is now confirmed rather than suspected, and it should not wait on `export` either.

# Next steps

Session-scoped items, each independently useful. None require adding `export` to core code.

1. **File the properties data-loss issue.** The 165-row loss, the 72/16/11 split, and the h3-vs-h6 and
   `anchor_id`-discard causes are all measured with examples. Scope: carry `section_id` on `properties`
   and `callouts` by correlating line ranges in the existing single parse pass; make `UNIQUE` use
   `section_id`. Cite this briefing. Do this first — it is a shipped-data bug, not export scope.
2. **File the `command_versions` arch issue** against the existing command/CLI Reference thread, with
   the 17 dual-arch versions and the delete-then-reinsert mechanism. Decide there whether the PK gains
   `arch` or extraction refuses to overwrite across arches.
3. **Export `splitTableRow`** from `extract-docusaurus.ts` (plus a test asserting escaped-pipe handling).
   One-line change that prevents the 44%-wrong second implementation this pass already stumbled into, and a
   prerequisite for any table census script living in the repo.
4. **Census the 259 non-property tables** — the one table question still open. Group them by header
   shape and page, and decide whether they are (a) device/capability tables belonging to B-0007, (b)
   worth a generic stored-table representation, or (c) noise. This is the input to the biggest schema
   decision in the briefing and is a scripting task, not a code change.
5. **Prototype two files throwaway** — `products.tsv` and `pages.tsv` — against a scratch Docusaurus DB,
   and open them in Numbers and GitHub. These are the two with real shape questions (spec head selection;
   page-vs-section rows in one file). Keep it out of `src/`; the point is to answer the layout question
   before any `export` command exists.

Deferred deliberately: publication/Pages layout, retention, compression, JSON, and overwrite/replacement
semantics. None of them can be decided well before the file set stabilizes.

# Questions for the next pass

- **Is `products.tsv` keyed correctly?** It assumes `hardware_catalog.rosetta_device_id` is the product
  identity, which makes 99 matrix-less products first-class rows. If the intended audience thinks in
  matrix terms, that is 39% surprising rows; if they think in catalog terms, `devices` is the surprising
  view. This drives the whole family's shape.
- **Do the 129 empty sections and the 153KB page belong in `pages.tsv` as-is,** or is the census
  actually pointing at a retrieval-unit issue worth its own briefing? The size data seems more valuable
  to MCP/TUI work than to the export, and may be escaping this briefing's scope.
- **Is `export` still the right vehicle** if the schema findings are the main product? An honest reading
  of this pass is that a `scripts/census.ts` would have produced findings 1–5 without shipping a user
  surface. `export` is still worth building for the spreadsheet audience — but that is a product
  argument, not the audit argument, and the briefing should probably say which one is load-bearing.
