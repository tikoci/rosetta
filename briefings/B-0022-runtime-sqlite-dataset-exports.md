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

It creates one directory containing a deterministic set of TSV files. There are no CI or GitHub Pages
changes in this pass, and no flags for partial exports, formats, or other options. (`@tikoci/rosetta`,
with a slash, is the canonical package name.)

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

# What the current SQLite shape can support

This is a feasibility inventory, not a final column contract. Names below are descriptive rather than
normative, and `#`-style count ideas are written as machine-friendly `*_count` columns.

| Candidate export | DB-only feasibility today | Current grounding and gaps |
|---|---|---|
| `changelog.tsv` | Ready | `changelogs` directly stores `version`, `is_breaking`, `category`, and `description` (plus `released` and source order). The requested `version`, `breaking`, `category`, `text` view is a direct query. |
| `videos.tsv` | Mostly ready | `videos` stores title, upload date, YouTube ID/URL, and whether chapters exist. Joining `video_segments` provides segment/chapter counts plus transcript word and UTF-8 byte counts. The DB does **not** retain transcript provenance/type such as auto-generated vs. manual or language/track; `has_chapters` can only support a derived layout label such as `chaptered` vs. `full-video`. Full transcript text is already stored, so future per-video text/metadata directories remain DB-only feasible. |
| `properties.tsv` | Mostly ready | `properties` joins to `pages` for page slug/`rosetta_id`, numeric page ID, title, and URL; `properties.section` records the nearest heading text. It does not FK directly to `sections.id` or store the exact `anchor_id`, so a guaranteed fragment URL requires a schema improvement (or a potentially ambiguous heading-text join when headings repeat). |
| `devices-matrix.tsv` | Ready | `devices` contains the normalized product-matrix fields. The existing `rosetta://datasets/devices.csv` query is the obvious query/column source to reuse, changing only the serialization to TSV rather than rebuilding the view from matrix files. |
| `devices-by-hardware-slug.tsv` | Mostly ready | `hardware_catalog.source_hardware_slug` can be the row key; `device_id IS NOT NULL` answers `has_matrix`; `devices` provides CPU/RAM fields; `specs_json` carries broad www specs including `Switch chip model` when present. A `/hardware` page's raw body and byte size are **not** stored in this catalog, so only stored-spec JSON bytes can be reported, not hardware-page bytes. |
| `devices-by-www-slug.tsv` | Mostly ready | `hardware_catalog.source_www_code` supplies the www path token, with the same matrix/spec joins and an optional `/hardware` URL derived from `source_hardware_slug`. The DB retains normalized www specs, not the raw www page body, so raw page byte counts are unavailable. Rows without a www source naturally do not appear in this keyed view. |
| `pages/<page-slug>/<fragment>.tsv` | Conditionally feasible | Current Docusaurus rows retain raw Markdown in `pages.text` and section Markdown in `sections.text`, so a small runtime parser can extract generic Markdown tables without touching a cache. Tables are not normalized in SQLite, however, and legacy Confluence rows do not have the same Markdown contract. Duplicate fragments/multiple tables under one heading need deterministic suffixes such as `--2`; unsupported MDX/HTML tables must be reported rather than guessed. |
| `pages.tsv` | Mostly ready | Page and fragment rows can carry slug/`rosetta_id`, title, URL, stored word counts, and UTF-8 byte counts derived from `pages.text` / `sections.text`; page rows provide the rollup. Table counts and table-row counts depend on the same DB-resident Markdown parser above because the schema does not store generic tables. |
| `commands-by-version.tsv` | Mostly ready | `command_versions`, `commands`, `schema_nodes`, `schema_node_presence`, and `ros_versions` support per-version path/type counts and provenance. RouterOS versions must use the existing numeric/beta/RC comparator, not SQL lexical order. `ros_versions` can indicate which x86/arm64 deep-inspect inputs existed, but `schema_node_presence` lacks an architecture column, so exact per-version, per-architecture node counts are not durably representable today. The meanings of `cmd_count`, `dir_count`, `path_count`, and `arg_count` also need one explicit definition each before becoming a contract. |
| `callouts.tsv` | Conditionally feasible | `callouts` directly provides page, type, order, and text. It has no section/fragment FK. Current Docusaurus Markdown can be re-parsed from `pages.text` to recover heading context, but that duplicates extraction logic and does not give legacy rows the same guarantee. Persisting `section_id` or `anchor_id` during ETL would make page+fragment a direct, auditable export. |

## Immediate schema/ETL audit findings

The exercise already exposes four concrete storage questions worth keeping visible even if the initial
export simply documents the gaps:

1. Should transcript source metadata (track language and auto/manual provenance) be retained alongside
   `videos` or `video_segments`?
2. Should `properties` and `callouts` carry a direct `section_id`/fragment identity rather than only
   heading text (properties) or no fragment context (callouts)?
3. Should generic Markdown tables become normalized ETL data, or is re-parsing DB-resident Markdown at
   export time intentionally sufficient? B-0007 independently identified the same generic-table
   question for device-capability pages.
4. Does command presence eventually need `(node, version, arch)` rather than `(node, version)` if
   architecture-specific audit exports are a desired contract?

Raw `/hardware` and www document byte counts are a different boundary: rosetta currently stores their
catalog identity and normalized facts, not those source documents as page corpora. Adding byte counts
would require deliberately retaining a body or source-size fact during ETL; an exporter cannot recreate
them honestly from `specs_json`.

# Strawman local directory

The first implementation can keep a stable, unsurprising layout while the exact columns remain subject
to a follow-up issue:

```text
rosetta-datasets/
├── manifest.tsv
├── changelog.tsv
├── videos.tsv
├── properties.tsv
├── devices-matrix.tsv
├── devices-by-hardware-slug.tsv
├── devices-by-www-slug.tsv
├── pages.tsv
├── commands-by-version.tsv
├── callouts.tsv
└── pages/
    └── <page-slug>/
        ├── <fragment>.tsv
        └── <fragment>--2.tsv
```

`manifest.tsv` should identify the rosetta/schema/release provenance available in `db_meta`, list each
generated file and row count, and record intentionally unavailable datasets/fields. That makes a local
directory self-describing and later gives a static release URL a lightweight inventory without making
JSON a supported dataset format yet.

For spreadsheet safety and reproducibility, the likely serialization contract is UTF-8, LF endings, a
header row, stable row/column ordering, empty fields for SQL `NULL`, and CSV-style double-quote escaping
using a tab delimiter. Counts should define their unit: UTF-8 bytes via `length(CAST(value AS BLOB))`,
and a single shared word-count rule rather than subtly different SQL and TypeScript approximations.
Raw slugs and fragments stay in columns even when filesystem-safe names must be sanitized.

# High-level plan of attack

1. **Turn this inventory into executable probes.** For every proposed column, write the SQL or small
   derivation against a runtime DB and mark unavailable fields explicitly. Check both a current release
   database and focused fixture DBs; do not use source artifacts to make a probe pass.
2. **Settle the initial column glossary and filenames.** Define count semantics, video transcript-type
   handling, command count categories, TSV escaping, path sanitization/collisions, and behavior when the
   destination already exists. Keep this small enough for one no-flags command.
3. **Build one reusable export core.** Add an `export <directory>` CLI dispatch before MCP startup,
   reuse existing DB resolution/readiness and device CSV query logic, and share deterministic TSV/path
   helpers across datasets.
4. **Land normalized exports first.** Changelog, videos, properties, matrix devices, hardware/www
   device pivots, page/section scalar metrics, command-version aggregates, and page-level callouts are
   mostly SQL plus formatting and provide the quickest local audit value.
5. **Add the DB-resident Markdown pass deliberately.** Reuse/generalize the existing table-row parser
   patterns, test multiple tables under one fragment and malformed/unsupported tables, then use the same
   parse result for per-table files and page/fragment table counts. Decide whether callout fragment
   recovery belongs in this parser or should wait for an ETL FK.
6. **Validate the directory as an artifact.** Assert stable reruns, row counts against direct SQL,
   correct quoting in Numbers/Excel-like inputs, no reads outside the DB, and useful failure behavior
   without leaving a partially convincing directory.
7. **Only then consider publication.** A later issue can define release/version URL layout, Pages
   deployment, retention, compression, caching, and large-scale JSON. None belongs in the initial local
   pass.

# Current lean

Proceed with a local DB-only exporter, but treat it as an **artifact audit with honest omissions**, not a
promise that every strawman column already exists. Start with the normalized TSVs and scalar metrics;
include the generic Markdown-table pass only if it remains small and deterministic against the Markdown
stored in SQLite. Do not add cache fallbacks to fill holes.

Before implementation, promote the settled first-pass file/column contract to a GitHub issue and cite
this briefing. Schema additions uncovered here should be separate, explicit follow-ups unless one is
strictly required for a coherent initial export.

# Open questions

- Is `transcript_type` meant to describe provenance (automatic/manual/language) or output layout
  (chaptered/full-video)? Only the latter is derivable today.
- Should page table exports include only pipe-style Markdown tables, or also raw HTML/MDX tables
  retained in page text?
- For device `byte_count`, is the desired unit the unavailable raw source-page body, or the stored
  normalized `specs_json` payload?
- Should legacy Confluence DBs export a reduced, clearly identified dataset, or should generic page-table
  exports require current Docusaurus provenance?
- Is an existing non-empty destination an error, an atomic replacement, or an idempotent overwrite?
