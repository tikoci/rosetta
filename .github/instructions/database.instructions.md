---
description: "Use when working on SQLite schema, database initialization, WAL mode, FTS5 triggers, or table definitions."
applyTo: "src/db.ts"
---
# Database Layer

## Key Rules
- Use `bun:sqlite` — never `better-sqlite3` or other drivers
- WAL mode + foreign keys enabled in `initDb()`
- `DB_PATH` env var overrides default `ros-help.db`
- Singleton pattern: one `Database` instance shared across modules

## Tables
- `pages` + `pages_fts` — legacy Confluence HTML pages (breadcrumb path, URL, text, code); do not assume this identity model works for the future Docusaurus extractor
- `callouts` + `callouts_fts` — Note/Warning/Info/Tip callouts (FK → pages)
- `sections` — page sections split by h1–h3 headings with anchor IDs (FK → pages)
- `page_tables` + `page_table_rows` + `page_table_cells` — normalized Docusaurus pipe tables with raw Markdown, page/section provenance, and actual ragged row widths
- `properties` + `properties_fts` — Docusaurus table/bullet properties plus historical Confluence properties (FK → pages; table-derived rows link to `page_table_rows`)
- `commands` — command tree entries from inspect.json (FK → pages for linked dirs)
- `ros_versions` — tracked RouterOS versions with channel metadata
- `command_versions` — junction: command_path × ros_version (full extracted history)
- `schema_nodes` + `schema_node_presence` — multi-arch deep-inspect schema; presence is pruned to active channel heads in release DBs
- `devices` + `devices_fts` — MikroTik products with hardware specs (from product matrix CSV)
- `device_test_results` — benchmark rows per device (ethernet/IPSec throughput)
- `changelogs` + `changelogs_fts` — parsed per-entry changelog data (version, category, breaking flag)
- `videos` + `videos_fts` — MikroTik YouTube video metadata
- `video_segments` + `video_segments_fts` — chapter-level transcript segments (FK → videos.id)
- `dude_pages` + `dude_pages_fts` — archived Dude wiki pages from Wayback/cache
- `dude_images` — screenshot metadata for Dude wiki pages
- `skills` + `skills_fts` — RouterOS agent skill guides from tikoci/routeros-skills
- `skill_references` — reference documents attached to skills
- `glossary` — seeded RouterOS terms and aliases
- `db_meta` — release provenance and schema/update metadata

For current corpus counts, use the `routeros_stats` MCP tool or see the snapshot in `DESIGN.md § Corpus Snapshot`.

## FTS5 Triggers
Content-sync triggers on content tables (`pages`, `callouts`, `properties`, `devices`, `changelogs`, `videos`, `video_segments`, `dude_pages`, `skills`) handle INSERT/UPDATE/DELETE automatically. Do not manually insert into `*_fts` tables.

## Schema Changes
If modifying tables, update both:
1. The `CREATE TABLE` in `db.ts`
2. The corresponding extractor that populates it

## FK Deletion Order
When deleting from `pages`, delete dependents first: callouts → properties → page_table_cells → page_table_rows → page_tables → sections → pages. Use `PRAGMA foreign_keys = OFF` temporarily for pages self-referential parent_id.
