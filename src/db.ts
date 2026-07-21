/**
 * db.ts — SQLite schema for RouterOS documentation.
 *
 * DB path: DB_PATH env var, or <project-root>/ros-help.db
 *
 * Tables:
 *   pages            — one row per Confluence HTML page
 *   pages_fts        — FTS5 over title, path, text, code
 *   page_tables      — generic Markdown tables with page/section provenance
 *   page_table_rows  — header and data rows for page_tables
 *   page_table_cells — decoded cells at their actual source width
 *   properties       — extracted property tables (name, type, default, description)
 *   properties_fts   — FTS5 over name, description
 *   callouts         — note/warning/info callout blocks from pages
 *   callouts_fts     — FTS5 over callout content
 *   commands         — RouterOS command tree from inspect.json (latest version)
 *   command_versions — junction: which commands exist in which RouterOS versions
 *   ros_versions     — metadata for each extracted RouterOS version
 *   schema_nodes     — structured command tree from deep-inspect.json (richer desc, arch, completion)
 *   schema_node_presence — junction: which schema_nodes exist in which versions
 *   devices          — MikroTik product hardware specs from product matrix CSV
 *   devices_fts      — FTS5 over product name, code, architecture, CPU
 *   hardware_catalog — /hardware + mikrotik.com/product device overlay (superset of devices)
 *   device_aliases   — alias/slug/code variant -> hardware_catalog.rosetta_device_id
 *   device_overview  — VIEW: catalog + devices spec columns + alias counts (read surface)
 *   changelogs       — parsed changelog entries per RouterOS version
 *   changelogs_fts   — FTS5 over category, description
 *   videos           — MikroTik YouTube video metadata (title, description, duration, chapters)
 *   videos_fts       — FTS5 over title, description
 *   video_segments   — transcript segments (one per chapter, or full video if no chapters)
 *   video_segments_fts — FTS5 over chapter_title, transcript
 *   dude_pages       — The Dude documentation pages (archived from wiki.mikrotik.com via Wayback Machine)
 *   dude_pages_fts   — FTS5 over title, path, text, code
 *   dude_images      — screenshot images from The Dude wiki pages
 *   skills           — agent skill guides (from tikoci/routeros-skills, community content)
 *   skills_fts       — FTS5 over name, description, content
 *   skill_references — reference documents for each skill
 */

import sqlite from "bun:sqlite";
import { classifyDbGrounding, detectMode, resolveDbPath, resolveVersion, SCHEMA_VERSION } from "./paths.ts";

export { SCHEMA_VERSION };

export const DB_PATH = resolveDbPath(import.meta.dirname);

export const db = new sqlite(DB_PATH);

export function initDb() {
  db.run("PRAGMA journal_mode=WAL;");
  db.run("PRAGMA foreign_keys=ON;");
  // Stamp schema version unconditionally — initDb() is only called by extractors
  // (which produce a current-schema DB) and by the MCP server after the version
  // check in mcp.ts. If you ever need to open a DB read-only without touching
  // user_version, call `db.run("PRAGMA foreign_keys=ON;")` directly and skip initDb().
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  );`);

  // -- DB metadata (release tag, build date, source commit) --
  // Key/value to avoid schema churn. Written by extractors / release.yml;
  // read by MCP startup banner and the freshness-check path.
  db.run(`CREATE TABLE IF NOT EXISTS db_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`);

  // -- Pages (from Confluence HTML export) --

  db.run(`CREATE TABLE IF NOT EXISTS pages (
    id           INTEGER PRIMARY KEY,
    slug         TEXT NOT NULL,
    title        TEXT NOT NULL,
    path         TEXT NOT NULL,
    depth        INTEGER NOT NULL,
    parent_id    INTEGER REFERENCES pages(id),
    url          TEXT NOT NULL,
    text         TEXT NOT NULL,
    code         TEXT NOT NULL,
    code_lang    TEXT,
    author       TEXT,
    last_updated TEXT,
    word_count   INTEGER NOT NULL,
    code_lines   INTEGER NOT NULL,
    html_file    TEXT NOT NULL
  );`);

  // Migration: add rosetta_id (H7 Option 2 — see briefings/B-0012, "Identity / rosetta-id
  // design"). NULL for legacy Confluence-sourced rows (they keep their numeric `id` as the
  // only identifier); populated for Docusaurus-sourced rows extracted by extract-docusaurus.ts.
  // A UNIQUE index (not a column constraint) so multiple NULLs are allowed side by side.
  const pageCols = db.prepare("PRAGMA table_info(pages)").all() as Array<{ name: string }>;
  if (!pageCols.some((c) => c.name === "rosetta_id")) {
    db.run("ALTER TABLE pages ADD COLUMN rosetta_id TEXT;");
  }
  db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_rosetta_id ON pages(rosetta_id) WHERE rosetta_id IS NOT NULL;");

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
    title, path, text, code,
    content=pages,
    content_rowid=id,
    tokenize='porter unicode61'
  );`);

  db.run(`CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
    INSERT INTO pages_fts(rowid, title, path, text, code)
    VALUES (new.id, new.title, new.path, new.text, new.code);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, path, text, code)
    VALUES('delete', old.id, old.title, old.path, old.text, old.code);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
    INSERT INTO pages_fts(pages_fts, rowid, title, path, text, code)
    VALUES('delete', old.id, old.title, old.path, old.text, old.code);
    INSERT INTO pages_fts(rowid, title, path, text, code)
    VALUES (new.id, new.title, new.path, new.text, new.code);
  END;`);

  // -- Sections (page chunks split by headings, for large-page retrieval) --
  //
  // Created before properties/callouts: both carry a section_id FK into this table
  // (issue #90), so it must exist first.

  // Migration: drop legacy sections table (from PDF-era schema) if it lacks page_id
  const secCols = db.prepare("SELECT name FROM pragma_table_info('sections')").all() as Array<{ name: string }>;
  if (secCols.length > 0 && !secCols.some((c) => c.name === "page_id")) {
    db.run("DROP TABLE sections;");
  }

  db.run(`CREATE TABLE IF NOT EXISTS sections (
    id          INTEGER PRIMARY KEY,
    page_id     INTEGER NOT NULL REFERENCES pages(id),
    heading     TEXT NOT NULL,
    level       INTEGER NOT NULL,
    anchor_id   TEXT NOT NULL,
    text        TEXT NOT NULL,
    code        TEXT NOT NULL,
    word_count  INTEGER NOT NULL,
    sort_order  INTEGER NOT NULL
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_sections_page ON sections(page_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sections_anchor ON sections(page_id, anchor_id);`);

  // -- Generic Markdown tables (Docusaurus source) --
  //
  // These tables retain every parsed pipe table structurally without classifying its meaning.
  // raw_markdown keeps delimiter/alignment syntax reversible; normalized rows/cells make the
  // corpus directly queryable for audits and future classifiers (issue #92).

  db.run(`CREATE TABLE IF NOT EXISTS page_tables (
    id             INTEGER PRIMARY KEY,
    page_id        INTEGER NOT NULL REFERENCES pages(id),
    section_id     INTEGER REFERENCES sections(id),
    source_heading TEXT,
    raw_markdown   TEXT NOT NULL,
    column_count   INTEGER NOT NULL,
    data_row_count INTEGER NOT NULL,
    is_ragged      INTEGER NOT NULL,
    sort_order     INTEGER NOT NULL,
    UNIQUE(page_id, sort_order)
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_page_tables_page ON page_tables(page_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_page_tables_section ON page_tables(section_id);`);

  db.run(`CREATE TABLE IF NOT EXISTS page_table_rows (
    id        INTEGER PRIMARY KEY,
    table_id  INTEGER NOT NULL REFERENCES page_tables(id),
    row_order INTEGER NOT NULL,
    UNIQUE(table_id, row_order)
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_page_table_rows_table ON page_table_rows(table_id);`);

  db.run(`CREATE TABLE IF NOT EXISTS page_table_cells (
    row_id       INTEGER NOT NULL REFERENCES page_table_rows(id),
    column_order INTEGER NOT NULL,
    value        TEXT NOT NULL,
    PRIMARY KEY(row_id, column_order)
  );`);

  // -- Properties (extracted from confluenceTable) --
  //
  // Deliberately NOT UNIQUE on (page_id, name, section) — issue #90. That constraint,
  // combined with INSERT OR IGNORE, silently destroyed 141 distinct properties: the corpus
  // documents the same property name more than once within a single section (dot1x defines
  // `interface` twice under "Server" — once for the server table, once for the client one),
  // so section is not a fine enough context to identify a property. Measured against the
  // whole corpus, no section-based key reaches zero loss; only removing the constraint does.
  // Extractors assert parsed == stored instead, so a drop is loud rather than silent.
  //
  // `section` (raw nearest-heading text, any level) is retained as-is for compatibility;
  // `section_id` is the resolvable identity. For a property under an h4–h6 the two
  // deliberately disagree — see attributeSection() in extract-docusaurus.ts.

  db.run(`CREATE TABLE IF NOT EXISTS properties (
    id          INTEGER PRIMARY KEY,
    page_id     INTEGER NOT NULL REFERENCES pages(id),
    name        TEXT NOT NULL,
    type        TEXT,
    default_val TEXT,
    description TEXT NOT NULL,
    section     TEXT,
    section_id  INTEGER REFERENCES sections(id),
    source_table_row_id INTEGER REFERENCES page_table_rows(id),
    sort_order  INTEGER NOT NULL
  );`);

  // Migration (v8 → v9): rebuild properties to drop UNIQUE(page_id, name, section) and add
  // section_id. Detected via the missing column; rows are carried over with section_id NULL
  // and repopulated by the next extractor run. Rebuild-in-place rather than DROP so a v8 DB
  // opened by an older-corpus workflow keeps its rows.
  {
    const propCols = db.prepare("PRAGMA table_info(properties)").all() as Array<{ name: string }>;
    if (propCols.length > 0 && !propCols.some((c) => c.name === "section_id")) {
      db.run("PRAGMA foreign_keys=OFF;");
      db.run("BEGIN;");
      try {
        db.run(`CREATE TABLE properties_new (
          id          INTEGER PRIMARY KEY,
          page_id     INTEGER NOT NULL REFERENCES pages(id),
          name        TEXT NOT NULL,
          type        TEXT,
          default_val TEXT,
          description TEXT NOT NULL,
          section     TEXT,
          section_id  INTEGER REFERENCES sections(id),
          source_table_row_id INTEGER REFERENCES page_table_rows(id),
          sort_order  INTEGER NOT NULL
        );`);
        // Preserve `id`: properties_fts is external-content (content_rowid=id), and the
        // indexed columns (name, description) are unchanged, so carrying rowids across the
        // rebuild leaves the existing index valid without a reindex. The triggers dropped
        // along with the old table are recreated by the CREATE TRIGGER IF NOT EXISTS below.
        db.run(`INSERT INTO properties_new (id, page_id, name, type, default_val, description, section, section_id, sort_order)
                SELECT id, page_id, name, type, default_val, description, section, NULL, sort_order FROM properties;`);
        db.run("DROP TABLE properties;");
        db.run("ALTER TABLE properties_new RENAME TO properties;");
        db.run("COMMIT;");
      } catch (e) {
        db.run("ROLLBACK;");
        throw e;
      }
      db.run("PRAGMA foreign_keys=ON;");
    }
  }

  // Migration (v9 -> v10): generic tables are additive, and historical/bullet-derived
  // properties honestly have no source table row. The Docusaurus extractor repopulates the
  // link for table-derived properties on its next deterministic rebuild.
  {
    const propCols = db.prepare("PRAGMA table_info(properties)").all() as Array<{ name: string }>;
    if (!propCols.some((c) => c.name === "source_table_row_id")) {
      db.run("ALTER TABLE properties ADD COLUMN source_table_row_id INTEGER REFERENCES page_table_rows(id);");
    }
  }

  db.run(`CREATE INDEX IF NOT EXISTS idx_properties_page ON properties(page_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_properties_section ON properties(section_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_properties_source_table_row ON properties(source_table_row_id);`);

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS properties_fts USING fts5(
    name, description,
    content=properties,
    content_rowid=id,
    tokenize='porter unicode61'
  );`);

  db.run(`CREATE TRIGGER IF NOT EXISTS props_ai AFTER INSERT ON properties BEGIN
    INSERT INTO properties_fts(rowid, name, description)
    VALUES (new.id, new.name, new.description);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS props_ad AFTER DELETE ON properties BEGIN
    INSERT INTO properties_fts(properties_fts, rowid, name, description)
    VALUES('delete', old.id, old.name, old.description);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS props_au AFTER UPDATE ON properties BEGIN
    INSERT INTO properties_fts(properties_fts, rowid, name, description)
    VALUES('delete', old.id, old.name, old.description);
    INSERT INTO properties_fts(rowid, name, description)
    VALUES (new.id, new.name, new.description);
  END;`);

  // -- Callouts (note/warning/info blocks from Confluence pages) --

  db.run(`CREATE TABLE IF NOT EXISTS callouts (
    id          INTEGER PRIMARY KEY,
    page_id     INTEGER NOT NULL REFERENCES pages(id),
    type        TEXT NOT NULL,
    content     TEXT NOT NULL,
    section_id  INTEGER REFERENCES sections(id),
    sort_order  INTEGER NOT NULL
  );`);

  // Migration (v8 → v9): add section_id (issue #90 — callouts had no section attribution at
  // all). Additive, so a plain ADD COLUMN; permitted with foreign_keys=ON because the default
  // is NULL. Populated by the next extractor run.
  const calloutCols = db.prepare("PRAGMA table_info(callouts)").all() as Array<{ name: string }>;
  if (!calloutCols.some((c) => c.name === "section_id")) {
    db.run("ALTER TABLE callouts ADD COLUMN section_id INTEGER REFERENCES sections(id);");
  }

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS callouts_fts USING fts5(
    content,
    content=callouts,
    content_rowid=id,
    tokenize='porter unicode61'
  );`);

  db.run(`CREATE TRIGGER IF NOT EXISTS callouts_ai AFTER INSERT ON callouts BEGIN
    INSERT INTO callouts_fts(rowid, content)
    VALUES (new.id, new.content);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS callouts_ad AFTER DELETE ON callouts BEGIN
    INSERT INTO callouts_fts(callouts_fts, rowid, content)
    VALUES('delete', old.id, old.content);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS callouts_au AFTER UPDATE ON callouts BEGIN
    INSERT INTO callouts_fts(callouts_fts, rowid, content)
    VALUES('delete', old.id, old.content);
    INSERT INTO callouts_fts(rowid, content)
    VALUES (new.id, new.content);
  END;`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_callouts_page ON callouts(page_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_callouts_type ON callouts(type);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_callouts_section ON callouts(section_id);`);

  // -- Commands (from inspect.json) --

  db.run(`CREATE TABLE IF NOT EXISTS commands (
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    parent_path TEXT,
    page_id     INTEGER REFERENCES pages(id),
    description TEXT,
    ros_version TEXT
  );`);

  // Migration: add ros_version column if missing (from pre-version schema)
  const cmdCols = db.prepare("PRAGMA table_info(commands)").all() as Array<{ name: string }>;
  if (!cmdCols.some((c) => c.name === "ros_version")) {
    db.run("ALTER TABLE commands ADD COLUMN ros_version TEXT;");
  }

  db.run(`CREATE INDEX IF NOT EXISTS idx_commands_parent ON commands(parent_path);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_commands_page ON commands(page_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_commands_type ON commands(type);`);

  // -- Command version tracking --
  //
  // ros_versions is keyed on (version, arch) — restraml emits per-arch
  // deep-inspect.<arch>.json (x86 vs arm64; arm64 carries ~1K extra nodes
  // for wifi-qcom etc.). _meta fields capture provenance from the inspect
  // file (generatedAt, crashPaths, completionStats). _attrs is a JSON
  // catch-all for forward-compat: anything restraml later emits lands here
  // first and gets promoted to a column once shape is stable.
  //
  // command_versions intentionally has no FK to ros_versions — the composite
  // PK on the parent makes a single-column FK invalid, and command_versions
  // is slated for replacement by schema_node_presence in the upcoming
  // schema_nodes refactor (BACKLOG.md "Multi-arch schema import").

  // Migration: legacy ros_versions had `version TEXT PRIMARY KEY` with no
  // arch column. Detect via PRAGMA table_info and rebuild both tables in
  // place — the FK on command_versions.ros_version requires the dance.
  // Idempotent: only fires when arch column is missing.
  {
    const rvCols = db.prepare("PRAGMA table_info(ros_versions)").all() as Array<{ name: string }>;
    if (rvCols.length > 0 && !rvCols.some((c) => c.name === "arch")) {
      db.run("PRAGMA foreign_keys=OFF;");
      db.run("BEGIN;");
      try {
        db.run(`CREATE TABLE ros_versions_new (
          version              TEXT NOT NULL,
          arch                 TEXT NOT NULL DEFAULT 'x86',
          channel              TEXT,
          extra_packages       INTEGER NOT NULL DEFAULT 0,
          extracted_at         TEXT NOT NULL,
          generated_at         TEXT,
          crash_paths_tested   TEXT,
          crash_paths_crashed  TEXT,
          completion_stats     TEXT,
          source_url           TEXT,
          _attrs               TEXT,
          PRIMARY KEY (version, arch)
        );`);
        db.run(`INSERT INTO ros_versions_new (version, arch, channel, extra_packages, extracted_at)
                SELECT version, 'x86', channel, extra_packages, extracted_at FROM ros_versions;`);
        db.run("DROP TABLE ros_versions;");
        db.run("ALTER TABLE ros_versions_new RENAME TO ros_versions;");

        db.run(`CREATE TABLE command_versions_new (
          command_path TEXT NOT NULL,
          ros_version  TEXT NOT NULL,
          PRIMARY KEY (command_path, ros_version)
        );`);
        db.run("INSERT INTO command_versions_new SELECT command_path, ros_version FROM command_versions;");
        db.run("DROP TABLE command_versions;");
        db.run("ALTER TABLE command_versions_new RENAME TO command_versions;");
        db.run("COMMIT;");
      } catch (e) {
        db.run("ROLLBACK;");
        throw e;
      }
      db.run("PRAGMA foreign_keys=ON;");
    }
  }

  db.run(`CREATE TABLE IF NOT EXISTS ros_versions (
    version              TEXT NOT NULL,
    arch                 TEXT NOT NULL DEFAULT 'x86',
    channel              TEXT,
    extra_packages       INTEGER NOT NULL DEFAULT 0,
    extracted_at         TEXT NOT NULL,
    generated_at         TEXT,
    crash_paths_tested   TEXT,
    crash_paths_crashed  TEXT,
    completion_stats     TEXT,
    source_url           TEXT,
    _attrs               TEXT,
    PRIMARY KEY (version, arch)
  );`);

  // Migration: add deep-inspect _meta provenance columns if missing
  {
    const rvCols2 = db.prepare("PRAGMA table_info(ros_versions)").all() as Array<{ name: string }>;
    if (rvCols2.length > 0 && !rvCols2.some((c) => c.name === "api_transport")) {
      db.run("ALTER TABLE ros_versions ADD COLUMN api_transport TEXT;");
    }
    if (rvCols2.length > 0 && !rvCols2.some((c) => c.name === "enrichment_duration_ms")) {
      db.run("ALTER TABLE ros_versions ADD COLUMN enrichment_duration_ms INTEGER;");
    }
    if (rvCols2.length > 0 && !rvCols2.some((c) => c.name === "crash_paths_safe")) {
      db.run("ALTER TABLE ros_versions ADD COLUMN crash_paths_safe TEXT;");
    }
  }

  db.run(`CREATE TABLE IF NOT EXISTS command_versions (
    command_path TEXT NOT NULL,
    ros_version  TEXT NOT NULL,
    PRIMARY KEY (command_path, ros_version)
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_cmdver_version ON command_versions(ros_version);`);

  // -- Schema nodes (structured command tree from deep-inspect.json) --
  //
  // schema_nodes replaces the flat commands table with richer structure:
  // parsed desc fields (data_type, enum_values, range), arch tagging,
  // dir_role classification, and a JSON _attrs catch-all for completion
  // data and future metadata like _package.
  //
  // The `commands` table is regenerated from schema_nodes at import time
  // by extract-schema.ts — existing queries continue to read `commands`
  // with zero downstream churn.

  db.run(`CREATE TABLE IF NOT EXISTS schema_nodes (
    id           INTEGER PRIMARY KEY,
    path         TEXT NOT NULL,
    name         TEXT NOT NULL,
    type         TEXT NOT NULL,
    inspect_type TEXT,
    parent_id    INTEGER REFERENCES schema_nodes(id),
    parent_path  TEXT,
    dir_role     TEXT,
    desc_raw     TEXT,
    data_type    TEXT,
    enum_values  TEXT,
    enum_multi   INTEGER,
    type_tag     TEXT,
    range_min    TEXT,
    range_max    TEXT,
    max_length   INTEGER,
    _arch        TEXT,
    _package     TEXT,
    _attrs       TEXT,
    page_id      INTEGER REFERENCES pages(id),
    UNIQUE(path, type)
  );`);

  // inspect_type preserves RouterOS' raw /console/inspect class (path|dir|cmd|arg)
  // that `type` normalizes (extract-schema.ts collapses raw `path` → `dir`). Additive,
  // NULL default, safe with foreign_keys=ON; repopulated by the next extract-schema run.
  const snCols = db.prepare("PRAGMA table_info(schema_nodes)").all() as Array<{ name: string }>;
  if (!snCols.some((c) => c.name === "inspect_type")) {
    db.run("ALTER TABLE schema_nodes ADD COLUMN inspect_type TEXT;");
  }

  db.run(`CREATE INDEX IF NOT EXISTS idx_sn_parent ON schema_nodes(parent_path);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sn_type ON schema_nodes(type);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sn_path ON schema_nodes(path);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sn_page ON schema_nodes(page_id);`);
  // Supports the cliref_field_inspect_links view's arg-by-name lookups.
  db.run(`CREATE INDEX IF NOT EXISTS idx_sn_type_name ON schema_nodes(type, name);`);

  db.run(`CREATE TABLE IF NOT EXISTS schema_node_presence (
    node_id     INTEGER NOT NULL REFERENCES schema_nodes(id),
    version     TEXT NOT NULL,
    PRIMARY KEY (node_id, version)
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_snp_version ON schema_node_presence(version);`);

  // -- CLI-Reference overlay (manual.mikrotik.com/docs/cli-reference/*) --
  //
  // A source-faithful, version-less overlay of the official CLI Reference, kept
  // structurally separate from the inspect.json-derived schema_nodes tree. An entry
  // (a heading path) is one of Directory/Settings Directory/Command; its fields are
  // named Argument/Read-only Argument rows; its flags are print-output markers. A
  // field has NO path — it maps to zero-to-many inspect coordinates. See #124 and
  // briefings/B-0016-cli-reference-overlay-design.md for the identity rationale.

  db.run(`CREATE TABLE IF NOT EXISTS cliref_pages (
    id              INTEGER PRIMARY KEY,
    slug            TEXT NOT NULL UNIQUE,
    url             TEXT NOT NULL UNIQUE,
    toc_name        TEXT NOT NULL,
    toc_group       TEXT NOT NULL,
    source_title    TEXT,
    source_markdown TEXT NOT NULL,
    source_sha256   TEXT NOT NULL,
    source_order    INTEGER NOT NULL UNIQUE
  );`);

  db.run(`CREATE TABLE IF NOT EXISTS cliref_entries (
    id                   INTEGER PRIMARY KEY,
    page_id              INTEGER NOT NULL REFERENCES cliref_pages(id),
    source_parent_id     INTEGER REFERENCES cliref_entries(id),
    source_heading       TEXT NOT NULL,
    source_path          TEXT NOT NULL,
    source_type          TEXT NOT NULL
      CHECK (source_type IN ('Directory', 'Settings Directory', 'Command')),
    heading_level        INTEGER NOT NULL CHECK (heading_level BETWEEN 1 AND 6),
    package              TEXT,
    conditions           TEXT,
    syscap               TEXT,
    description_markdown  TEXT NOT NULL,
    source_order         INTEGER NOT NULL,
    source_line          INTEGER NOT NULL,
    source_end_line      INTEGER NOT NULL,
    UNIQUE (page_id, source_order)
  );`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cliref_entries_page ON cliref_entries(page_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cliref_entries_path ON cliref_entries(source_path);`);

  db.run(`CREATE TABLE IF NOT EXISTS cliref_fields (
    id                   INTEGER PRIMARY KEY,
    entry_id             INTEGER NOT NULL REFERENCES cliref_entries(id),
    field_kind           TEXT NOT NULL
      CHECK (field_kind IN ('Argument', 'Read-only Argument')),
    name                 TEXT NOT NULL,
    raw_type             TEXT NOT NULL,
    mandatory            INTEGER NOT NULL CHECK (mandatory IN (0, 1)),
    unsettable           INTEGER NOT NULL CHECK (unsettable IN (0, 1)),
    syscap               TEXT,
    description_markdown  TEXT NOT NULL,
    source_order         INTEGER NOT NULL,
    source_line          INTEGER NOT NULL,
    UNIQUE (entry_id, source_order)
  );`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cliref_fields_entry ON cliref_fields(entry_id, name);`);

  db.run(`CREATE TABLE IF NOT EXISTS cliref_flags (
    id                   INTEGER PRIMARY KEY,
    entry_id             INTEGER NOT NULL REFERENCES cliref_entries(id),
    flag                 TEXT NOT NULL,
    name                 TEXT NOT NULL,
    description_markdown  TEXT NOT NULL,
    source_order         INTEGER NOT NULL,
    source_line          INTEGER NOT NULL,
    UNIQUE (entry_id, source_order)
  );`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cliref_flags_entry ON cliref_flags(entry_id, flag);`);

  // STORED: carries the non-derivable exact/alias resolution. entry_id as PRIMARY KEY
  // enforces the ≤1-inspect-link-per-entry invariant. Ambiguous aliases stay unlinked.
  db.run(`CREATE TABLE IF NOT EXISTS cliref_entry_schema_links (
    entry_id       INTEGER PRIMARY KEY REFERENCES cliref_entries(id),
    schema_node_id INTEGER NOT NULL REFERENCES schema_nodes(id),
    match_kind     TEXT NOT NULL CHECK (match_kind IN ('exact', 'alias')),
    match_detail   TEXT
  );`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_cliref_entry_links_node ON cliref_entry_schema_links(schema_node_id);`,
  );

  // COMPUTED: field→inspect arg crosswalk, correct by construction against the current
  // schema_nodes snapshot — never stored, so a version-less overlay never pins to a
  // versioned tree. Directory/Settings Directory entries match a field name under each
  // child command's arg nodes; Command entries match their direct arg children.
  db.run(`DROP VIEW IF EXISTS cliref_field_inspect_links;`);
  db.run(`CREATE VIEW cliref_field_inspect_links AS
    SELECT f.id AS field_id, sn.id AS schema_node_id
    FROM cliref_fields f
    JOIN cliref_entries e             ON e.id = f.entry_id
    JOIN cliref_entry_schema_links el ON el.entry_id = e.id
    JOIN schema_nodes en              ON en.id = el.schema_node_id
    JOIN schema_nodes sn              ON sn.type = 'arg' AND sn.name = f.name
    WHERE (en.type = 'cmd' AND sn.parent_path = en.path)
       OR (en.type = 'dir' AND sn.parent_path IN
            (SELECT c.path FROM schema_nodes c WHERE c.type = 'cmd' AND c.parent_path = en.path));`);

  // -- Devices (MikroTik product matrix) --

  db.run(`CREATE TABLE IF NOT EXISTS devices (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    product_name      TEXT NOT NULL UNIQUE,
    product_code      TEXT,
    architecture      TEXT,
    cpu               TEXT,
    cpu_cores         INTEGER,
    cpu_frequency     TEXT,
    license_level     INTEGER,
    operating_system  TEXT,
    ram               TEXT,
    ram_mb            INTEGER,
    storage           TEXT,
    storage_mb        INTEGER,
    dimensions        TEXT,
    poe_in            TEXT,
    poe_out           TEXT,
    poe_out_ports     TEXT,
    poe_in_voltage    TEXT,
    dc_inputs         INTEGER,
    dc_jack_voltage   TEXT,
    max_power_w       REAL,
    wireless_24_chains INTEGER,
    antenna_24_dbi    REAL,
    wireless_5_chains INTEGER,
    antenna_5_dbi     REAL,
    eth_fast          INTEGER,
    eth_gigabit       INTEGER,
    eth_2500          INTEGER,
    usb_ports         INTEGER,
    combo_ports       INTEGER,
    sfp_ports         INTEGER,
    sfp_plus_ports    INTEGER,
    eth_multigig      INTEGER,
    sim_slots         INTEGER,
    memory_cards      TEXT,
    usb_type          TEXT,
    msrp_usd          REAL,
    product_url       TEXT,
    block_diagram_url TEXT
  );`);

  // Migration: add product_url and block_diagram_url columns if missing
  const devCols = db.prepare("PRAGMA table_info(devices)").all() as Array<{ name: string }>;
  if (!devCols.some((c) => c.name === "product_url")) {
    db.run("ALTER TABLE devices ADD COLUMN product_url TEXT;");
  }
  if (!devCols.some((c) => c.name === "block_diagram_url")) {
    db.run("ALTER TABLE devices ADD COLUMN block_diagram_url TEXT;");
  }

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS devices_fts USING fts5(
    product_name, product_code, architecture, cpu,
    content=devices,
    content_rowid=id,
    tokenize='unicode61'
  );`);

  db.run(`CREATE TRIGGER IF NOT EXISTS devices_ai AFTER INSERT ON devices BEGIN
    INSERT INTO devices_fts(rowid, product_name, product_code, architecture, cpu)
    VALUES (new.id, new.product_name, new.product_code, new.architecture, new.cpu);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS devices_ad AFTER DELETE ON devices BEGIN
    INSERT INTO devices_fts(devices_fts, rowid, product_name, product_code, architecture, cpu)
    VALUES('delete', old.id, old.product_name, old.product_code, old.architecture, old.cpu);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS devices_au AFTER UPDATE ON devices BEGIN
    INSERT INTO devices_fts(devices_fts, rowid, product_name, product_code, architecture, cpu)
    VALUES('delete', old.id, old.product_name, old.product_code, old.architecture, old.cpu);
    INSERT INTO devices_fts(rowid, product_name, product_code, architecture, cpu)
    VALUES (new.id, new.product_name, new.product_code, new.architecture, new.cpu);
  END;`);

  // -- Device test results (from mikrotik.com product pages) --

  db.run(`CREATE TABLE IF NOT EXISTS device_test_results (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id     INTEGER NOT NULL REFERENCES devices(id),
    test_type     TEXT NOT NULL,
    mode          TEXT NOT NULL,
    configuration TEXT NOT NULL,
    packet_size   INTEGER NOT NULL,
    throughput_kpps REAL,
    throughput_mbps REAL,
    UNIQUE(device_id, test_type, mode, configuration, packet_size)
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_device_tests_device ON device_test_results(device_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_device_tests_type ON device_test_results(test_type);`);

  // -- Hardware catalog (manual.mikrotik.com/hardware + mikrotik.com/product overlay) --
  //
  // Superset of `devices` — covers accessories and legacy/EOL SKUs `devices` doesn't carry,
  // in addition to every device `devices` already has. `devices` itself is untouched (no
  // schema change, no risk to routeros_device_lookup); `device_id` links back for the
  // rows matrix.csv also tracks. See briefings/B-0017-hardware-overlay-device-resolution.md
  // "Phased implementation plan" for the full rationale (specs_json over ~40 sparse columns
  // — spec-field coverage falls off sharply outside a small universal core).
  //
  // rosetta_device_id is a rosetta-curated stable key (slugified matrix product name for
  // devices-linked rows, `hw-<hardware-slug>` for hardware/www-only rows) — not any one
  // source's own slug, since MikroTik does rename products (`hEX` -> `hEX refresh`) and
  // www/`/hardware` carry independently-drifting slugs (see extract-hardware-catalog.ts).
  //
  // `name` is the human-readable display name (COALESCE of www title, /hardware page title,
  // matrix product name — never NULL). `device_id` (not `devices_id`) links back to
  // devices(id), matching device_test_results.device_id's naming so both FKs to devices read
  // the same. B-0017 Phase 1.5 (PR #36 review) renamed the column and added `name`; the
  // migration below drops the pre-rename shape so a dev DB rebuilds cleanly (both tables are
  // fully repopulated every run by extract-hardware-catalog.ts, so a drop loses nothing).
  const hwcatCols = db.prepare("PRAGMA table_info(hardware_catalog)").all() as Array<{ name: string }>;
  if (hwcatCols.some((c) => c.name === "devices_id")) {
    db.run("DROP VIEW IF EXISTS device_overview;");
    db.run("DROP TABLE IF EXISTS device_aliases;");
    db.run("DROP TABLE IF EXISTS hardware_catalog;");
  }

  db.run(`CREATE TABLE IF NOT EXISTS hardware_catalog (
    id                   INTEGER PRIMARY KEY,
    rosetta_device_id    TEXT NOT NULL UNIQUE,
    device_id            INTEGER REFERENCES devices(id),
    name                 TEXT NOT NULL,
    category             TEXT,
    discontinued         INTEGER,
    specs_json           TEXT,
    source_hardware_slug TEXT,
    source_www_code      TEXT
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_hwcat_device ON hardware_catalog(device_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_hwcat_category ON hardware_catalog(category);`);

  // device_aliases.alias is stored normalized (trim + lowercase, see normCode() in
  // assess-hardware.ts) so case/whitespace variants of the same code collapse to one
  // row — display-cased forms live in hardware_catalog.specs_json / devices.product_name.
  db.run(`CREATE TABLE IF NOT EXISTS device_aliases (
    alias              TEXT PRIMARY KEY,
    rosetta_device_id  TEXT NOT NULL REFERENCES hardware_catalog(rosetta_device_id),
    source             TEXT NOT NULL
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_device_aliases_device ON device_aliases(rosetta_device_id);`);

  // device_overview — the documented read surface for the catalog: one row per catalog
  // device, its display name, category/discontinued overlay, the matrix-derived structured
  // spec columns where the row links to `devices`, and its alias count. Every future
  // consumer (MCP, TUI, ad-hoc SQL) should read this instead of re-deriving the
  // catalog<->devices<->aliases join. Recreated (not IF NOT EXISTS) so definition changes
  // always take effect. The join is on device_id (the FK captured fresh at build
  // time); extract-hardware-catalog.ts validates that FK against devices.product_name — the
  // UNIQUE, rename-stable key — on every write so a stale AUTOINCREMENT link fails loud.
  db.run("DROP VIEW IF EXISTS device_overview;");
  db.run(`CREATE VIEW device_overview AS
    SELECT
      hc.rosetta_device_id,
      hc.name,
      hc.category,
      hc.discontinued,
      hc.device_id,
      d.product_name,
      d.product_code,
      d.architecture,
      d.cpu,
      hc.source_hardware_slug,
      hc.source_www_code,
      hc.specs_json,
      (SELECT COUNT(*) FROM device_aliases da WHERE da.rosetta_device_id = hc.rosetta_device_id) AS alias_count
    FROM hardware_catalog hc
    LEFT JOIN devices d ON d.id = hc.device_id;`);

  // -- Changelogs (parsed per-entry from MikroTik download server) --

  db.run(`CREATE TABLE IF NOT EXISTS changelogs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    version     TEXT NOT NULL,
    released    TEXT,
    category    TEXT NOT NULL,
    is_breaking INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL,
    sort_order  INTEGER NOT NULL,
    UNIQUE(version, sort_order)
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_changelogs_version ON changelogs(version);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_changelogs_category ON changelogs(category);`);

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS changelogs_fts USING fts5(
    category, description,
    content=changelogs,
    content_rowid=id,
    tokenize='porter unicode61'
  );`);

  db.run(`CREATE TRIGGER IF NOT EXISTS changelogs_ai AFTER INSERT ON changelogs BEGIN
    INSERT INTO changelogs_fts(rowid, category, description)
    VALUES (new.id, new.category, new.description);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS changelogs_ad AFTER DELETE ON changelogs BEGIN
    INSERT INTO changelogs_fts(changelogs_fts, rowid, category, description)
    VALUES('delete', old.id, old.category, old.description);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS changelogs_au AFTER UPDATE ON changelogs BEGIN
    INSERT INTO changelogs_fts(changelogs_fts, rowid, category, description)
    VALUES('delete', old.id, old.category, old.description);
    INSERT INTO changelogs_fts(rowid, category, description)
    VALUES (new.id, new.category, new.description);
  END;`);

  // -- Videos (MikroTik YouTube channel transcripts) --

  db.run(`CREATE TABLE IF NOT EXISTS videos (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id     TEXT NOT NULL UNIQUE,
    title        TEXT NOT NULL,
    description  TEXT,
    channel      TEXT,
    upload_date  TEXT,
    duration_s   INTEGER,
    url          TEXT,
    view_count   INTEGER,
    like_count   INTEGER,
    has_chapters INTEGER NOT NULL DEFAULT 0
  );`);

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS videos_fts USING fts5(
    title, description,
    content=videos,
    content_rowid=id,
    tokenize='porter unicode61'
  );`);

  db.run(`CREATE TRIGGER IF NOT EXISTS videos_ai AFTER INSERT ON videos BEGIN
    INSERT INTO videos_fts(rowid, title, description)
    VALUES (new.id, new.title, new.description);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS videos_ad AFTER DELETE ON videos BEGIN
    INSERT INTO videos_fts(videos_fts, rowid, title, description)
    VALUES('delete', old.id, old.title, old.description);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS videos_au AFTER UPDATE ON videos BEGIN
    INSERT INTO videos_fts(videos_fts, rowid, title, description)
    VALUES('delete', old.id, old.title, old.description);
    INSERT INTO videos_fts(rowid, title, description)
    VALUES (new.id, new.title, new.description);
  END;`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_videos_upload_date ON videos(upload_date);`);

  // -- Video segments (transcript chunks, one per chapter or one per video) --

  db.run(`CREATE TABLE IF NOT EXISTS video_segments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id      INTEGER NOT NULL REFERENCES videos(id),
    chapter_title TEXT,
    start_s       INTEGER NOT NULL DEFAULT 0,
    end_s         INTEGER,
    transcript    TEXT NOT NULL,
    sort_order    INTEGER NOT NULL
  );`);

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS video_segments_fts USING fts5(
    chapter_title, transcript,
    content=video_segments,
    content_rowid=id,
    tokenize='porter unicode61'
  );`);

  db.run(`CREATE TRIGGER IF NOT EXISTS video_segs_ai AFTER INSERT ON video_segments BEGIN
    INSERT INTO video_segments_fts(rowid, chapter_title, transcript)
    VALUES (new.id, new.chapter_title, new.transcript);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS video_segs_ad AFTER DELETE ON video_segments BEGIN
    INSERT INTO video_segments_fts(video_segments_fts, rowid, chapter_title, transcript)
    VALUES('delete', old.id, old.chapter_title, old.transcript);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS video_segs_au AFTER UPDATE ON video_segments BEGIN
    INSERT INTO video_segments_fts(video_segments_fts, rowid, chapter_title, transcript)
    VALUES('delete', old.id, old.chapter_title, old.transcript);
    INSERT INTO video_segments_fts(rowid, chapter_title, transcript)
    VALUES (new.id, new.chapter_title, new.transcript);
  END;`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_video_segs_video ON video_segments(video_id);`);

  // -- The Dude documentation (archived from MikroTik wiki via Wayback Machine) --

  db.run(`CREATE TABLE IF NOT EXISTS dude_pages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    slug        TEXT NOT NULL UNIQUE,
    title       TEXT NOT NULL,
    path        TEXT NOT NULL,
    version     TEXT NOT NULL DEFAULT 'v6',
    url         TEXT NOT NULL,
    wayback_url TEXT NOT NULL,
    text        TEXT NOT NULL,
    code        TEXT,
    last_edited TEXT,
    word_count  INTEGER
  );`);

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS dude_pages_fts USING fts5(
    title, path, text, code,
    content=dude_pages,
    content_rowid=id,
    tokenize='porter unicode61'
  );`);

  db.run(`CREATE TRIGGER IF NOT EXISTS dude_pages_ai AFTER INSERT ON dude_pages BEGIN
    INSERT INTO dude_pages_fts(rowid, title, path, text, code)
    VALUES (new.id, new.title, new.path, new.text, new.code);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS dude_pages_ad AFTER DELETE ON dude_pages BEGIN
    INSERT INTO dude_pages_fts(dude_pages_fts, rowid, title, path, text, code)
    VALUES('delete', old.id, old.title, old.path, old.text, old.code);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS dude_pages_au AFTER UPDATE ON dude_pages BEGIN
    INSERT INTO dude_pages_fts(dude_pages_fts, rowid, title, path, text, code)
    VALUES('delete', old.id, old.title, old.path, old.text, old.code);
    INSERT INTO dude_pages_fts(rowid, title, path, text, code)
    VALUES (new.id, new.title, new.path, new.text, new.code);
  END;`);

  db.run(`CREATE TABLE IF NOT EXISTS dude_images (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    page_id      INTEGER NOT NULL REFERENCES dude_pages(id),
    filename     TEXT NOT NULL,
    alt_text     TEXT,
    caption      TEXT,
    local_path   TEXT NOT NULL,
    original_url TEXT,
    wayback_url  TEXT,
    sort_order   INTEGER NOT NULL
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_dude_images_page ON dude_images(page_id);`);

  // -- Skills (agent guides from tikoci/routeros-skills — community content, NOT official MikroTik docs) --

  db.run(`CREATE TABLE IF NOT EXISTS skills (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL UNIQUE,
    description   TEXT,
    content       TEXT NOT NULL,
    source_repo   TEXT NOT NULL DEFAULT 'tikoci/routeros-skills',
    source_sha    TEXT,
    source_url    TEXT,
    word_count    INTEGER,
    extracted_at  TEXT
  );`);

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS skills_fts USING fts5(
    name, description, content,
    content=skills, content_rowid=id,
    tokenize='porter unicode61'
  );`);

  db.run(`CREATE TRIGGER IF NOT EXISTS skills_ai AFTER INSERT ON skills BEGIN
    INSERT INTO skills_fts(rowid, name, description, content) VALUES (new.id, new.name, new.description, new.content);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS skills_ad AFTER DELETE ON skills BEGIN
    INSERT INTO skills_fts(skills_fts, rowid, name, description, content) VALUES ('delete', old.id, old.name, old.description, old.content);
  END;`);
  db.run(`CREATE TRIGGER IF NOT EXISTS skills_au AFTER UPDATE ON skills BEGIN
    INSERT INTO skills_fts(skills_fts, rowid, name, description, content) VALUES ('delete', old.id, old.name, old.description, old.content);
    INSERT INTO skills_fts(rowid, name, description, content) VALUES (new.id, new.name, new.description, new.content);
  END;`);

  db.run(`CREATE TABLE IF NOT EXISTS skill_references (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id      INTEGER NOT NULL REFERENCES skills(id),
    path          TEXT NOT NULL,
    filename      TEXT NOT NULL,
    content       TEXT NOT NULL,
    word_count    INTEGER,
    UNIQUE(skill_id, path)
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_skill_refs_skill ON skill_references(skill_id);`);

  // -- Glossary (domain jargon resolution for RouterOS terms) --

  db.run(`CREATE TABLE IF NOT EXISTS glossary (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    term        TEXT NOT NULL UNIQUE,
    definition  TEXT NOT NULL,
    aliases     TEXT,
    category    TEXT,
    search_hint TEXT
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_glossary_term ON glossary(term);`);

  seedGlossary();
}

/**
 * Seed the glossary table with RouterOS domain jargon. Idempotent — uses
 * INSERT OR IGNORE so existing rows are preserved across schema reinits.
 *
 * Fields:
 *   term        — canonical lookup key (lowercase)
 *   definition  — brief one-line explanation
 *   aliases     — comma-separated alternate spellings/abbreviations
 *   category    — grouping: 'product', 'protocol', 'subsystem', 'concept'
 *   search_hint — query expansion term(s) for FTS — what to actually search for
 */
function seedGlossary() {
  const entries: Array<[string, string, string | null, string, string]> = [
    // Products & platforms
    ["chr", "Cloud Hosted Router — RouterOS VM image for hypervisors", "cloud hosted router", "product", "CHR cloud hosted router"],
    ["routerboard", "MikroTik hardware product line running RouterOS", "rb,routerboard", "product", "RouterBOARD hardware"],
    ["swos", "SwOS — switch operating system for CRS1xx/2xx and CSS series", "switchos,switch os", "product", "SwOS switch operating system"],
    ["winbox", "WinBox — native Windows/macOS GUI management tool for RouterOS", null, "product", "WinBox GUI management"],
    ["webfig", "WebFig — web-based management interface for RouterOS", null, "product", "WebFig web interface"],
    ["the dude", "The Dude — MikroTik network monitor (GUI retired, server remains in RouterOS)", "dude", "product", "Dude network monitor"],
    ["netinstall", "Tool for reinstalling RouterOS on MikroTik hardware via network boot", null, "product", "netinstall network boot"],

    // Wireless
    ["capsman", "Controlled Access Point Manager — centralized wireless management", "caps man,caps,csman", "subsystem", "CAPsMAN wireless controller"],
    ["wifiwave2", "WiFi Wave2 driver — successor to legacy wireless, for newer hardware", "wave2,wifi-qcom", "subsystem", "WiFi Wave2 wireless"],
    ["w60g", "Wireless 60GHz — 802.11ad wireless bridge interface", "60ghz,wireless wire", "subsystem", "60GHz wireless bridge"],

    // Firewall & filtering
    ["mangle", "Firewall mangle table — packet marking and header modification", null, "subsystem", "firewall mangle packet marking"],
    ["raw", "Firewall raw table — pre-connection-tracking filtering", null, "subsystem", "firewall raw pre-conntrack"],
    ["conntrack", "Connection tracking — stateful firewall session table", "connection tracking", "subsystem", "conntrack connection tracking"],
    ["fasttrack", "FastTrack — kernel-level connection fast path bypassing firewall rules", "fast track,fast-track", "concept", "fasttrack fast path"],

    // Routing
    ["ospf", "OSPF — Open Shortest Path First routing protocol", null, "protocol", "OSPF routing"],
    ["bgp", "BGP — Border Gateway Protocol for inter-AS routing", null, "protocol", "BGP routing"],
    ["rpki", "RPKI — Resource Public Key Infrastructure for BGP route origin validation", null, "protocol", "RPKI route origin validation"],
    ["mpls", "MPLS — Multi-Protocol Label Switching", "ldp,vpls,rsvp-te", "protocol", "MPLS label switching"],
    ["vrf", "VRF — Virtual Routing and Forwarding (multiple routing tables)", null, "concept", "VRF virtual routing"],

    // VPN & tunnels
    ["ipsec", "IPsec — IP Security protocol suite for encrypted tunnels", "ike,ike1,ike2", "protocol", "IPsec IKE tunnel encryption"],
    ["wireguard", "WireGuard — modern VPN tunnel protocol", "wg", "protocol", "WireGuard VPN tunnel"],
    ["sstp", "SSTP — Secure Socket Tunneling Protocol (Microsoft VPN)", null, "protocol", "SSTP tunnel"],
    ["l2tp", "L2TP — Layer 2 Tunneling Protocol, often paired with IPsec", null, "protocol", "L2TP tunnel"],
    ["ovpn", "OpenVPN — SSL/TLS VPN tunnel implementation in RouterOS", "openvpn", "protocol", "OpenVPN tunnel"],
    ["vxlan", "VXLAN — Virtual Extensible LAN overlay network", null, "protocol", "VXLAN overlay"],
    ["gre", "GRE — Generic Routing Encapsulation tunnel", null, "protocol", "GRE tunnel"],
    ["eoip", "EoIP — Ethernet over IP tunnel (MikroTik proprietary)", null, "protocol", "EoIP Ethernet tunnel"],

    // Bridging & switching
    ["l3hw", "L3 Hardware Offloading — hardware-accelerated IP routing on supported switches", "l3 hardware,hw offload", "concept", "L3 hardware offloading"],
    ["vlan", "VLAN — Virtual LAN (802.1Q tagging)", "802.1q", "concept", "VLAN tagging"],
    ["dot1x", "802.1X — port-based network access control", "802.1x,port authentication", "protocol", "dot1x port authentication"],
    ["mlag", "MLAG — Multi-Chassis Link Aggregation", null, "protocol", "MLAG multi-chassis"],
    ["macsec", "MACsec — 802.1AE Media Access Control Security", "802.1ae", "protocol", "MACsec layer2 encryption"],

    // Services
    ["user-manager", "User Manager — RADIUS server and hotspot user management built into RouterOS", "userman", "subsystem", "User Manager RADIUS"],
    ["hotspot", "Hotspot — captive portal with authentication and walled garden", "captive portal", "subsystem", "Hotspot captive portal"],
    ["mqtt", "MQTT — IoT messaging protocol client in RouterOS", null, "protocol", "MQTT IoT messaging"],
    ["tr069", "TR-069 — CPE WAN Management Protocol for remote device management", "cwmp,acs", "protocol", "TR-069 remote management"],
    ["snmp", "SNMP — Simple Network Management Protocol for monitoring", null, "protocol", "SNMP monitoring"],
    ["romon", "RoMON — Router Management Overlay Network for out-of-band management", null, "subsystem", "RoMON management overlay"],
    ["zerotier", "ZeroTier — peer-to-peer VPN overlay (extra package)", null, "protocol", "ZeroTier peer VPN"],

    // System concepts
    ["npk", "NPK — RouterOS package file format (.npk)", "package", "concept", "NPK package file"],
    ["supout", "Support output file — diagnostic bundle generated by /system/sup-output", "support output,sup-output", "concept", "supout support output diagnostics"],
    ["defconf", "Default configuration — factory-reset configuration script", "default config", "concept", "default configuration"],
    ["container", "OCI container support in RouterOS (extra package, 7.4+)", "docker", "subsystem", "container Docker OCI"],
    ["lora", "LoRa — Long Range IoT radio support (extra package)", "lorawan", "subsystem", "LoRa IoT radio"],
    ["poe", "PoE — Power over Ethernet (in/out)", "power over ethernet", "concept", "PoE power ethernet"],
    ["etherboot", "Etherboot — network boot mode for RouterOS reinstallation via netinstall", "net boot", "concept", "etherboot network boot netinstall"],
  ];

  const stmt = db.prepare(
    "INSERT OR IGNORE INTO glossary (term, definition, aliases, category, search_hint) VALUES (?, ?, ?, ?, ?)",
  );
  for (const [term, definition, aliases, category, search_hint] of entries) {
    stmt.run(term, definition, aliases, category, search_hint);
  }
}

/**
 * Verify the open DB was built with the expected schema version.
 * Only meaningful after initDb() — initDb() itself stamps the version,
 * so this is mainly a regression guard and for the test suite.
 */
export function checkSchemaVersion(): { ok: boolean; actual: number; expected: number } {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return { ok: row.user_version === SCHEMA_VERSION, actual: row.user_version, expected: SCHEMA_VERSION };
}

/** Read a single row from db_meta. Returns null when the key is missing. */
export function getDbMeta(key: string): string | null {
  try {
    const row = db.prepare("SELECT value FROM db_meta WHERE key = ?").get(key) as { value: string } | null;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

/** Upsert a single row into db_meta. */
export function setDbMeta(key: string, value: string): void {
  db.run("INSERT INTO db_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;", [key, value]);
}

/** Read all db_meta rows as a flat object. */
export function getAllDbMeta(): Record<string, string> {
  try {
    const rows = db.prepare("SELECT key, value FROM db_meta").all() as Array<{ key: string; value: string }>;
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  } catch {
    return {};
  }
}

export function getDbStats() {
  const count = (sql: string) =>
    Number((db.prepare(sql).get() as { c: number }).c ?? 0);
  const dbSizeBytes = (() => {
    try {
      return Bun.file(DB_PATH).size;
    } catch {
      return null;
    }
  })();
  const schemaVersion = (() => {
    try {
      return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    } catch {
      return null;
    }
  })();
  const provenance = (() => {
    const releaseTag = getDbMeta("release_tag");
    const sourceCommit = getDbMeta("source_commit");
    const builtAt = getDbMeta("built_at");
    const metaSchemaRaw = getDbMeta("schema_version");
    const metaSchema = metaSchemaRaw === null ? null : Number(metaSchemaRaw);
    const mode = detectMode(import.meta.dirname);
    const codeVersion = resolveVersion(import.meta.dirname);
    const grounding = classifyDbGrounding({
      pragmaSchema: schemaVersion ?? -1,
      metaSchema,
      releaseTag,
      builtAt,
      sourceCommit,
      codeSchema: SCHEMA_VERSION,
      codeVersion,
      mode,
    });
    return {
      db_path: DB_PATH,
      mode,
      is_ci_artifact: releaseTag !== null && sourceCommit !== null,
      release_tag: releaseTag,
      source_commit: sourceCommit,
      built_at: builtAt,
      schema_version_meta: metaSchema,
      schema_version_pragma: schemaVersion,
      code_schema_version: SCHEMA_VERSION,
      code_version: codeVersion,
      grounding,
    };
  })();
  return {
    db_path: DB_PATH,
    db_size_bytes: dbSizeBytes,
    schema_version: schemaVersion,
    provenance,
    pages: count("SELECT COUNT(*) AS c FROM pages"),
    sections: count("SELECT COUNT(*) AS c FROM sections"),
    properties: count("SELECT COUNT(*) AS c FROM properties"),
    callouts: count("SELECT COUNT(*) AS c FROM callouts"),
    commands: count("SELECT COUNT(*) AS c FROM commands"),
    commands_linked: count("SELECT COUNT(*) AS c FROM commands WHERE page_id IS NOT NULL"),
    devices: count("SELECT COUNT(*) AS c FROM devices"),
    device_test_results: count("SELECT COUNT(*) AS c FROM device_test_results"),
    devices_with_tests: count("SELECT COUNT(DISTINCT device_id) AS c FROM device_test_results"),
    hardware_catalog: count("SELECT COUNT(*) AS c FROM hardware_catalog"),
    hardware_catalog_linked: count("SELECT COUNT(*) AS c FROM hardware_catalog WHERE device_id IS NOT NULL"),
    device_aliases: count("SELECT COUNT(*) AS c FROM device_aliases"),
    changelogs: count("SELECT COUNT(*) AS c FROM changelogs"),
    changelog_versions: count("SELECT COUNT(DISTINCT version) AS c FROM changelogs"),
    ros_versions: count("SELECT COUNT(DISTINCT version) AS c FROM ros_versions"),
    videos: count("SELECT COUNT(*) AS c FROM videos"),
    video_segments: count("SELECT COUNT(*) AS c FROM video_segments"),
    dude_pages: count("SELECT COUNT(*) AS c FROM dude_pages"),
    dude_images: count("SELECT COUNT(*) AS c FROM dude_images"),
    skills: count("SELECT COUNT(*) AS c FROM skills"),
    skill_references: count("SELECT COUNT(*) AS c FROM skill_references"),
    glossary: count("SELECT COUNT(*) AS c FROM glossary"),
    schema_nodes: count("SELECT COUNT(*) AS c FROM schema_nodes"),
    schema_node_presence: count("SELECT COUNT(*) AS c FROM schema_node_presence"),
    ...(() => {
      // Semantic version sort — SQL MIN/MAX is lexicographic ("7.10" < "7.9")
      const versions = (db.prepare("SELECT DISTINCT version FROM ros_versions").all() as Array<{ version: string }>).map((r) => r.version);
      if (versions.length === 0) return { ros_version_min: null, ros_version_max: null };
      const norm = (v: string) => {
        const clean = v.replace(/beta\d*/, "").replace(/rc\d*/, "");
        const parts = clean.split(".").map(Number);
        const suffix = v.includes("beta") ? 0 : v.includes("rc") ? 1 : 2;
        return { parts, suffix };
      };
      const cmp = (a: string, b: string) => {
        const na = norm(a), nb = norm(b);
        for (let i = 0; i < Math.max(na.parts.length, nb.parts.length); i++) {
          const d = (na.parts[i] ?? 0) - (nb.parts[i] ?? 0);
          if (d !== 0) return d;
        }
        return na.suffix - nb.suffix;
      };
      versions.sort(cmp);
      return { ros_version_min: versions[0], ros_version_max: versions[versions.length - 1] };
    })(),
    // Derived from db_meta provenance, not hard-coded — a hard-coded export date
    // silently lied whenever the resolved DB was a different corpus (#94). The
    // string is self-describing (it is a DB build stamp, not a doc-export date),
    // and a stamped artifact missing only `built_at` reports "build time unknown"
    // rather than being mislabeled a local build.
    doc_export: provenance.built_at
      ? `DB built ${provenance.built_at}${provenance.release_tag ? ` (release ${provenance.release_tag})` : ""}`
      : provenance.is_ci_artifact
        ? `DB build time unknown${provenance.release_tag ? ` (release ${provenance.release_tag})` : ""}`
        : "unstamped local build",
  };
}

// Run schema init when executed directly
if (import.meta.main) {
  initDb();
  console.log("Schema initialized:", DB_PATH);
  console.log(getDbStats());
}
