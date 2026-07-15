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
compatibility mode for historical Confluence release databases. If current extraction leaves
Confluence-sourced page rows in the release DB, that is a data-integrity finding to surface rather than
an alternate export contract to design around.

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
transcript word and UTF-8 byte counts. Full transcript text is also in the DB, so a later
`videos/<video_id>/` detail directory could remain within the DB-only constraint.

The schema does not yet retain transcript provenance such as automatic vs. author-provided. That is
already tracked by [#21](https://github.com/tikoci/rosetta/issues/21), including the proposed
`transcript_source` field and the harder question of how reliably it can be detected. It should not
block this export: omit the field now, make the gap visible in the manifest, and add it when the DB can
provide it.

## Products

The product data is better considered one family than a collection of unrelated `devices-*` files.
`devices`, `hardware_catalog`, `device_aliases`, and `hardware_catalog.specs_json` collectively represent
rosetta's product knowledge across the matrix, `/hardware`, and www product sources.

Likely useful views to probe are:

- **`products/products.tsv`** — one row per `hardware_catalog.rosetta_device_id`, including source
  identities/slugs, display name/category/lifecycle, matrix presence and common matrix fields, alias
  count, spec count, and a deliberately small set of high-coverage/useful www specs such as CPU,
  architecture, RAM, storage, switch chip, power, and port counts. This is the closest DB-only successor
  to the manually produced `hardware-www-matrix.csv`, but should be a richer combined catalog rather
  than merely re-exporting `devices`.
- **`products/matrix.tsv`** — the normalized matrix-backed fields currently exposed as
  `rosetta://datasets/devices.csv`, if retaining the narrower source-shaped view proves useful beside
  the combined catalog.
- **`products/by-hardware-slug.tsv` and `products/by-www-slug.tsv`** — alternate flat views keyed by
  `source_hardware_slug` or `source_www_code`, with cross-links and the same useful/common columns.
  These may overlap enough with `products.tsv` that the feasibility pass can simplify them rather than
  committing to three nearly identical tables.
- **`products/<rosetta_device_id>/specs.tsv`** — a vertical `name`/`value` expansion of every stored
  `specs_json` member for that product, optionally accompanied by aliases and source identities. This
  preserves the sparse long tail without turning `products.tsv` into hundreds of mostly empty columns.

The earlier page-byte idea was mistaken and is dropped. The catalog stores normalized www facts, not
raw `/hardware` or www page bodies. Useful size-like audit signals here are row counts, alias counts,
`spec_count`, and per-key coverage across products—not byte counts of `specs_json`.

## Properties and section identity

`properties.tsv` can join `properties` to `pages` for `slug`/`rosetta_id`, numeric page ID, title, URL,
and the stored property fields. `properties.section` records the nearest heading text, but it does not
FK directly to `sections.id` or store the exact `anchor_id`. A heading-text join may be ambiguous when a
page repeats a heading.

That looks like a real schema weakness, but the useful next step here is to measure it rather than
declare a migration from the briefing: count properties with no section, repeated headings within a
page, and rows that cannot map uniquely to a stored section. If the materiality is confirmed, a focused
schema issue can use those results and examples to scope a `section_id`/fragment relationship.

## Pages, fragments, and generic tables

`pages.tsv` can provide two kinds of row in one pivot-like audit view:

- a page rollup with `rosetta_id`, `slug`, `title`, `url`, stored `word_count`, derived text/code byte
  counts, section count, and any table counts the probe can establish; and
- one row per `sections` record with `anchor_id`, `heading`, `level`, `sort_order`, `word_count`, byte
  counts, and table/table-row counts for that fragment.

The scalar page/section metrics are straightforward. Generic table metrics are the uncertain part:
the current Docusaurus extractor stores raw Markdown in `pages.text` and section Markdown in
`sections.text`, but does not store generic tables as structured rows. An export-time parser would need
to scan the DB-resident Markdown, distinguish pipe tables from raw HTML/MDX forms, associate each table
with a page and nearest fragment, handle multiple tables under one fragment, and identify malformed or
unsupported shapes without guessing.

Before making that parser a permanent part of `export`, a focused DB-only census should answer:

- how many pages/fragments contain pipe-style, HTML, or MDX-like table shapes;
- how many tables parse with a simple shared rule and how many are exceptional;
- how often a fragment contains multiple tables or filename collisions;
- which headers/shapes recur, especially property-like and device-keyed tables; and
- how much parsing logic would duplicate or diverge from `extract-docusaurus.ts`.

If the common case stays small and deterministic, emit each table as
`pages/<page-slug>/<fragment>[--N].tsv` and feed the same parse result into `pages.tsv` counts. If doing
that honestly requires complex source-specific logic, stopping at the census is itself a useful result:
it suggests generic tables or a parsed-table JSON representation may belong in ETL/core data rather
than inside the exporter.

This is more than an export implementation detail. A generic stored-table representation could retain
page/section context, headers, rows, ordinals, and perhaps raw source; `routeros_get_page` could then
reconstruct or return tables structurally. Property extraction might eventually become a classification
or query over that generic table corpus instead of the only special table parser. The device-specific
tables in B-0007 may still deserve normalized domain schema, but seeing the complete table inventory as
files is a practical precursor to deciding which tables warrant that promotion.

## Callouts

`callouts.tsv` directly supports page, type, order, and text, but `callouts` has no section/fragment FK.
Re-parsing `pages.text` could recover heading context for current Docusaurus Markdown, but that would
duplicate extraction logic just as generic table parsing would. The feasibility probe should measure
how reliably stored callout content maps to a unique `sections` row. Together with the properties probe,
this gives concrete scope to the broader finding that page subsections are not consistently represented
as relationships in the schema.

## Commands

Keep this deliberately shallow. `commands-by-version.tsv` only needs to round out the export with a
summary of data already present: RouterOS version, total distinct path count, and simple `dir`/`cmd`/`arg`
counts where the existing tables support them reliably. Versions must use the existing numeric/beta/RC
comparator rather than SQL lexical order.

Per-architecture counts and a redesign of `schema_node_presence` are not goals here. CLI Reference,
multi-architecture deep-inspect, and command-schema work already have their own active research/issues;
this briefing does not need to pull them forward merely to make the export more symmetrical.

# Schema/ETL questions this audit is surfacing

The valuable questions are still directional and evidence-seeking:

1. **Section identity:** how material are the missing/ambiguous property and callout relationships to
   `sections`, and would a direct `section_id` or stable fragment identity solve both cleanly?
2. **Generic table storage:** are DB-resident Markdown tables simple enough to parse only for export, or
   would storing a generic structured representation in ETL unlock better auditing plus MCP/TUI
   behavior? How would that generic layer coexist with domain-specific promotion for properties and
   device-capability tables?
3. **Product catalog shape:** which `specs_json` keys are common/useful enough for the combined summary,
   and which belong only in per-product key/value files? Do alternate hardware/www keyed views add real
   audit value beyond identifiers already present in `products.tsv`?
4. **Artifact readability:** which combination of summary TSVs, per-item TSVs, and non-tabular sidecars
   makes the DB easiest to inspect without hiding sparse or multiline content?

Transcript provenance is also a real schema gap, but it is already scoped in #21 and is not a question
this briefing needs to answer. Command architecture is intentionally left to the existing command/CLI
Reference work.

# Strawman local directory

The structure below is a working aid for the feasibility pass, not a promise that every alternate view
survives unchanged:

```text
rosetta-datasets/
├── manifest.toml
├── changelog.tsv
├── videos.tsv
├── properties.tsv
├── pages.tsv
├── commands-by-version.tsv
├── callouts.tsv
├── products/
│   ├── products.tsv
│   ├── matrix.tsv
│   ├── by-hardware-slug.tsv
│   ├── by-www-slug.tsv
│   └── <rosetta-device-id>/
│       └── specs.tsv
└── pages/
    └── <page-slug>/
        ├── <fragment>.tsv
        └── <fragment>--2.tsv
```

`manifest.toml` can carry richer structure than a TSV: database/package/schema/release provenance from
`db_meta`, generated file names and row counts, coverage summaries, and known omitted/unavailable
fields. It is also a natural place for the table/section/product census results that do not fit one flat
row shape. JSON remains a possible future bulk dataset format, not a requirement of this local pass.

Subdirectories are not restricted to TSV forever. For example, a later video detail export could use
`transcript.txt` plus `metadata.toml`; keeping multiline prose out of a summary table may make both the
table and the detail easier to consume.

# TSV as the working tabular format

TSV is a reasonable default to test. GitHub and editor plugins render it well, spreadsheets commonly
import it, and it is visually/physically lighter than comma-separated output for data whose ordinary
values contain commas. It also resembles direct SQL query output and is friendlier to token-based text
inspection when cells remain simple.

There is one important consumer mismatch to investigate rather than hand-wave: spreadsheet-compatible
CSV-style quoting with a tab delimiter can preserve literal tabs/newlines, but plain `awk -F '\t'` and
RouterOS `:deserialize` do not provide the same quote-aware record parsing. Quoted multiline cells also
break the useful property that one physical line equals one record.

The feasibility pass should therefore test a small consumer matrix and choose intentionally among:

- keeping summary TSV cells single-line and free of literal tabs, with a documented reversible escape
  for exceptional characters;
- using quote-aware TSV for exact multiline values and accepting that simple `awk`/RouterOS consumers
  need a stronger parser; or
- moving multiline/raw content into per-item `.txt`/`.md` sidecars while TSVs retain summaries and
  references.

Whatever shape wins should be UTF-8 with LF endings, a header row, stable row/column ordering, explicit
SQL `NULL` handling, and a single shared word-count rule. Raw slugs and fragments stay in columns even
when filesystem-safe names must be sanitized. The hope that ETL normally avoids tabs is useful, but the
serializer still needs defined behavior when a source does contain one.

# High-level plan of attack

1. **Run a DB-only feasibility/census pass.** Write focused queries and small probes for proposed
   columns, product-spec key coverage, page table shapes, section joins, and callout attribution. Confirm
   the current runtime artifact contains only the expected Docusaurus prose source.
2. **Generate a representative local sample.** Materialize enough of the strawman directory to inspect
   in Numbers/Excel, GitHub/editor renderers, `awk`, and—where relevant—RouterOS `:deserialize`. The
   sample is there to refine scope and file shapes, not to declare them stable contracts.
3. **Refine the small useful core.** Keep direct/normalized summaries, the combined product catalog,
   per-product sparse specs, and page/section audit metrics. Collapse redundant product views. Include
   per-page table files only if the census shows they can be produced with small, trustworthy logic.
4. **Build one reusable export path.** Add `export <directory>` before MCP startup, reuse normal DB
   resolution/readiness and existing device-export query logic, and share deterministic TSV/TOML/path
   helpers. For this local phase, overwriting the command's previously generated output is the simplest
   working assumption; safe replacement behavior needs definition before implementation.
5. **Turn measured schema gaps into focused follow-ups where useful.** Section FKs and generic table
   storage should gain issues only when the probes provide counts/examples and a clearer scope. Link the
   resulting work back here and to B-0007 where table findings affect device-capability treatment.
6. **Validate the directory as an artifact.** Compare row counts with direct SQL, check stable reruns,
   ensure no reads escape the DB boundary, and avoid leaving a partially convincing directory on error.
7. **Consider publication later.** Release/version URL layout, Pages deployment, retention,
   compression, caching, and large-scale JSON depend on the usefulness of the local output and remain
   intentionally unspecified.

# Working direction

Proceed by using the export idea to **measure and expose** the current artifact, not by designing every
future schema now. Product and page/table exploration are the highest-value areas. Commands get a KISS
summary; the known video provenance gap stays with #21; mistaken device page-byte counts are gone.

The first useful output should favor honest omissions and coverage summaries over cache fallbacks or
complex re-parsing hidden inside `export`. At the same time, the exporter should produce enough concrete
files—especially per-product specs and, if feasible, generic page tables—to make the next schema/MCP/TUI
questions visible to humans using ordinary tools.

# Feasibility questions to answer next

- What is the full census of pipe, HTML, MDX, malformed, and duplicate-fragment table shapes in the
  current Docusaurus DB, and how much code is needed to export all of them honestly?
- Can properties and callouts be mapped uniquely to `sections` from current stored data, and how often
  do they fail or become ambiguous?
- Which product spec keys have enough coverage or audit value for `products.tsv`, and are the two
  alternate slug-keyed files useful after the combined identifiers are present?
- Which TSV encoding strategy actually works across the intended spreadsheet, GitHub/editor, Unix, and
  RouterOS consumers? Would sidecar text files remove the hardest incompatibilities?
- When overwriting an existing destination, which paths are safely command-owned and how can replacement
  avoid stale files or partial output without making CI/versioned publication part of this scope?
