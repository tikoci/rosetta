/**
 * db.ts — SQLite schema for RouterOS documentation.
 *
 * DB path: DB_PATH env var, or <project-root>/ros-help.db
 *
 * Tables:
 *   pages            — one row per Confluence HTML page
 *   pages_fts        — FTS5 over title, path, text, code
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
import { resolveDbPath, SCHEMA_VERSION } from "./paths.ts";

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

  // -- Properties (extracted from confluenceTable) --

  db.run(`CREATE TABLE IF NOT EXISTS properties (
    id          INTEGER PRIMARY KEY,
    page_id     INTEGER NOT NULL REFERENCES pages(id),
    name        TEXT NOT NULL,
    type        TEXT,
    default_val TEXT,
    description TEXT NOT NULL,
    section     TEXT,
    sort_order  INTEGER NOT NULL,
    UNIQUE(page_id, name, section)
  );`);

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
    sort_order  INTEGER NOT NULL
  );`);

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

  // -- Sections (page chunks split by headings, for large-page retrieval) --

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
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    parent_id   INTEGER REFERENCES schema_nodes(id),
    parent_path TEXT,
    dir_role    TEXT,
    desc_raw    TEXT,
    data_type   TEXT,
    enum_values TEXT,
    enum_multi  INTEGER,
    type_tag    TEXT,
    range_min   TEXT,
    range_max   TEXT,
    max_length  INTEGER,
    _arch       TEXT,
    _package    TEXT,
    _attrs      TEXT,
    page_id     INTEGER REFERENCES pages(id),
    UNIQUE(path, type)
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_sn_parent ON schema_nodes(parent_path);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sn_type ON schema_nodes(type);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sn_path ON schema_nodes(path);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sn_page ON schema_nodes(page_id);`);

  db.run(`CREATE TABLE IF NOT EXISTS schema_node_presence (
    node_id     INTEGER NOT NULL REFERENCES schema_nodes(id),
    version     TEXT NOT NULL,
    PRIMARY KEY (node_id, version)
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_snp_version ON schema_node_presence(version);`);

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
  return {
    db_path: DB_PATH,
    db_size_bytes: dbSizeBytes,
    schema_version: schemaVersion,
    pages: count("SELECT COUNT(*) AS c FROM pages"),
    sections: count("SELECT COUNT(*) AS c FROM sections"),
    properties: count("SELECT COUNT(*) AS c FROM properties"),
    callouts: count("SELECT COUNT(*) AS c FROM callouts"),
    commands: count("SELECT COUNT(*) AS c FROM commands"),
    commands_linked: count("SELECT COUNT(*) AS c FROM commands WHERE page_id IS NOT NULL"),
    devices: count("SELECT COUNT(*) AS c FROM devices"),
    device_test_results: count("SELECT COUNT(*) AS c FROM device_test_results"),
    devices_with_tests: count("SELECT COUNT(DISTINCT device_id) AS c FROM device_test_results"),
    changelogs: count("SELECT COUNT(*) AS c FROM changelogs"),
    changelog_versions: count("SELECT COUNT(DISTINCT version) AS c FROM changelogs"),
    ros_versions: count("SELECT COUNT(DISTINCT version) AS c FROM ros_versions"),
    videos: count("SELECT COUNT(*) AS c FROM videos"),
    video_segments: count("SELECT COUNT(*) AS c FROM video_segments"),
    dude_pages: count("SELECT COUNT(*) AS c FROM dude_pages"),
    dude_images: count("SELECT COUNT(*) AS c FROM dude_images"),
    skills: count("SELECT COUNT(*) AS c FROM skills"),
    skill_references: count("SELECT COUNT(*) AS c FROM skill_references"),
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
    doc_export: "2026-03-25 (Confluence HTML)",
  };
}

// Run schema init when executed directly
if (import.meta.main) {
  initDb();
  console.log("Schema initialized:", DB_PATH);
  console.log(getDbStats());
}
