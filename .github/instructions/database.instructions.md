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
- `pages` + `pages_fts` — 317 Confluence HTML pages
- `callouts` + `callouts_fts` — 1,034 Note/Warning/Info callouts (FK → pages)
- `sections` — ~3,000 page sections split by h1–h3 headings (FK → pages)
- `properties` + `properties_fts` — 4,860 property table rows (FK → pages)
- `commands` — 40K command tree entries from inspect.json (FK → pages for linked dirs)
- `ros_versions` — 46 RouterOS versions (7.9–7.23beta2) with channel metadata
- `command_versions` — 1.67M junction table entries (command_path × ros_version)
- `devices` + `devices_fts` — 144 MikroTik products with hardware specs (from product matrix CSV)

## FTS5 Triggers
Content-sync triggers on `pages`, `callouts`, and `properties` tables handle INSERT/UPDATE/DELETE automatically. Do not manually insert into `*_fts` tables.

## Schema Changes
If modifying tables, update both:
1. The `CREATE TABLE` in `db.ts`
2. The corresponding extractor that populates it

## FK Deletion Order
When deleting from `pages`, delete dependents first: sections → callouts → properties → pages. Use `PRAGMA foreign_keys = OFF` temporarily for pages self-referential parent_id.
