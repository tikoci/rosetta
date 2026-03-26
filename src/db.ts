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
 */

import sqlite from "bun:sqlite";
import path from "node:path";

declare const IS_COMPILED: boolean;

/**
 * Resolve the base directory for finding ros-help.db:
 * - Compiled binary: directory containing the executable
 * - Dev mode: project root (one level up from src/)
 */
const baseDir =
  typeof IS_COMPILED !== "undefined" && IS_COMPILED
    ? path.dirname(process.execPath)
    : path.resolve(import.meta.dirname, "..");

export const DB_PATH =
  process.env.DB_PATH?.trim() || path.join(baseDir, "ros-help.db");

export const db = new sqlite(DB_PATH);

export function initDb() {
  db.run("PRAGMA journal_mode=WAL;");
  db.run("PRAGMA foreign_keys=ON;");

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
    msrp_usd          REAL
  );`);

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS devices_fts USING fts5(
    product_name, product_code, architecture, cpu,
    content=devices,
    content_rowid=id,
    tokenize='porter unicode61'
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
}

export function getDbStats() {
  const count = (sql: string) =>
    Number((db.prepare(sql).get() as { c: number }).c ?? 0);
  const scalar = (sql: string) => {
    const row = db.prepare(sql).get() as { v: string | null } | null;
    return row?.v ?? null;
  };
  return {
    db_path: DB_PATH,
    pages: count("SELECT COUNT(*) AS c FROM pages"),
    sections: count("SELECT COUNT(*) AS c FROM sections"),
    properties: count("SELECT COUNT(*) AS c FROM properties"),
    callouts: count("SELECT COUNT(*) AS c FROM callouts"),
    commands: count("SELECT COUNT(*) AS c FROM commands"),
    commands_linked: count("SELECT COUNT(*) AS c FROM commands WHERE page_id IS NOT NULL"),
    devices: count("SELECT COUNT(*) AS c FROM devices"),
    ros_versions: count("SELECT COUNT(*) AS c FROM ros_versions"),
    ros_version_min: scalar("SELECT MIN(version) AS v FROM ros_versions"),
    ros_version_max: scalar("SELECT MAX(version) AS v FROM ros_versions"),
    doc_export: "2026-03-25 (Confluence HTML)",
  };
}

// Run schema init when executed directly
if (import.meta.main) {
  initDb();
  console.log("Schema initialized:", DB_PATH);
  console.log(getDbStats());
}
