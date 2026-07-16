import sqlite from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION } from "./paths.ts";

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures", "docusaurus");

function extract(dbPath: string): string {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "run",
      join(import.meta.dirname, "extract-docusaurus.ts"),
      "--from-cache",
      `--cache-dir=${FIXTURES_DIR}`,
    ],
    {
      cwd: join(import.meta.dirname, ".."),
      env: { ...process.env, DB_PATH: dbPath },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  expect(result.exitCode, output).toBe(0);
  return output;
}

function stableSnapshot(db: sqlite): string {
  const tables = db
    .query(`
      SELECT p.rosetta_id, t.sort_order, s.anchor_id, t.source_heading, t.raw_markdown,
             t.column_count, t.data_row_count, t.is_ragged,
             r.row_order, c.column_order, c.value
      FROM page_tables t
      JOIN pages p ON p.id = t.page_id
      LEFT JOIN sections s ON s.id = t.section_id
      JOIN page_table_rows r ON r.table_id = t.id
      JOIN page_table_cells c ON c.row_id = r.id
      ORDER BY p.rosetta_id, t.sort_order, r.row_order, c.column_order`)
    .all();
  const properties = db
    .query(`
      SELECT pg.rosetta_id, p.name, p.type, p.default_val, p.description, p.section,
             s.anchor_id, p.sort_order, t.sort_order AS table_order, r.row_order
      FROM properties p
      JOIN pages pg ON pg.id = p.page_id
      LEFT JOIN sections s ON s.id = p.section_id
      LEFT JOIN page_table_rows r ON r.id = p.source_table_row_id
      LEFT JOIN page_tables t ON t.id = r.table_id
      ORDER BY pg.rosetta_id, p.sort_order`)
    .all();
  return JSON.stringify({ tables, properties });
}

test(
  "Docusaurus extraction stores normalized tables and exact property provenance on repeated runs (#92)",
  () => {
    const dir = mkdtempSync(join(tmpdir(), "rosetta-docusaurus-tables-"));
    const dbPath = join(dir, "fixture.db");
    try {
      const firstOutput = extract(dbPath);
      expect(firstOutput).toContain("Tables:");

      let db = new sqlite(dbPath, { readonly: true });
      expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);

      const counts = db
        .query(`
          SELECT (SELECT COUNT(*) FROM page_tables) AS tables,
                 (SELECT COALESCE(SUM(data_row_count), 0) FROM page_tables) AS data_rows,
                 (SELECT COUNT(*) FROM page_table_rows) AS rows,
                 (SELECT COUNT(*) FROM page_table_cells) AS cells,
                 (SELECT COUNT(*) FROM properties WHERE source_table_row_id IS NOT NULL) AS table_properties,
                 (SELECT COUNT(*) FROM properties WHERE source_table_row_id IS NULL) AS non_table_properties`)
        .get() as Record<string, number>;
      expect(counts.tables).toBeGreaterThan(0);
      expect(counts.data_rows).toBeGreaterThan(0);
      expect(counts.rows).toBe(counts.tables + counts.data_rows);
      expect(counts.cells).toBeGreaterThan(counts.rows);
      expect(counts.table_properties).toBeGreaterThan(0);
      expect(counts.non_table_properties).toBeGreaterThan(0);

      const phoneNumber = db
        .query(`
          SELECT r.row_order, c.value AS source_cell
          FROM properties p
          JOIN pages pg ON pg.id = p.page_id
          JOIN page_table_rows r ON r.id = p.source_table_row_id
          JOIN page_table_cells c ON c.row_id = r.id AND c.column_order = 0
          WHERE pg.rosetta_id = 'sms' AND p.name = 'phone-number'`)
        .get() as { row_order: number; source_cell: string };
      expect(phoneNumber.row_order).toBeGreaterThan(0);
      expect(phoneNumber.source_cell).toContain("**phone-number**");

      const bullet = db
        .query(`
          SELECT p.source_table_row_id
          FROM properties p JOIN pages pg ON pg.id = p.page_id
          WHERE pg.rosetta_id = 'queues' AND p.name = 'direction'`)
        .get() as { source_table_row_id: number | null };
      expect(bullet.source_table_row_id).toBeNull();

      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      const firstSnapshot = stableSnapshot(db);
      db.close();

      extract(dbPath);
      db = new sqlite(dbPath, { readonly: true });
      expect(stableSnapshot(db)).toBe(firstSnapshot);
      expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20_000,
);
