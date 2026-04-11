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
 *   devices          — MikroTik product hardware specs from product matrix CSV
 *   devices_fts      — FTS5 over product name, code, architecture, CPU
 *   changelogs       — parsed changelog entries per RouterOS version
 *   changelogs_fts   — FTS5 over category, description
 *   videos           — MikroTik YouTube video metadata (title, description, duration, chapters)
 *   videos_fts       — FTS5 over title, description
 *   video_segments   — transcript segments (one per chapter, or full video if no chapters)
 *   video_segments_fts — FTS5 over chapter_title, transcript
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

  db.run(`CREATE TABLE IF NOT EXISTS ros_versions (
    version        TEXT PRIMARY KEY,
    channel        TEXT,
    extra_packages INTEGER NOT NULL DEFAULT 0,
    extracted_at   TEXT NOT NULL
  );`);

  db.run(`CREATE TABLE IF NOT EXISTS command_versions (
    command_path TEXT NOT NULL,
    ros_version  TEXT NOT NULL REFERENCES ros_versions(version),
    PRIMARY KEY (command_path, ros_version)
  );`);

  db.run(`CREATE INDEX IF NOT EXISTS idx_cmdver_version ON command_versions(ros_version);`);

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
    ros_versions: count("SELECT COUNT(*) AS c FROM ros_versions"),
    videos: count("SELECT COUNT(*) AS c FROM videos"),
    video_segments: count("SELECT COUNT(*) AS c FROM video_segments"),
    ...(() => {
      // Semantic version sort — SQL MIN/MAX is lexicographic ("7.10" < "7.9")
      const versions = (db.prepare("SELECT version FROM ros_versions").all() as Array<{ version: string }>).map((r) => r.version);
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
