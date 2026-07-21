/**
 * export.test.ts — the `rosetta export` spine (issue #101 / B-0022).
 *
 * Nails the serialization contract E2–E4 inherit: reversible escaping, NULL vs.
 * empty, deterministic byte-identical output, manifest provenance from db_meta,
 * and the DB-only hard boundary.
 *
 * DB_PATH must be set BEFORE db.ts is first imported; dynamic imports below make
 * this env-var assignment win over Bun's static-import hoisting.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DB_PATH = ":memory:";

const { db, initDb, DB_PATH } = await import("./db.ts");
if (DB_PATH !== ":memory:") {
  throw new Error(`export.test.ts: DB singleton is at "${DB_PATH}" — expected ":memory:".`);
}

const {
  runExport,
  encodeTsvField,
  decodeTsvField,
  parseTsv,
  toTsv,
  countWords,
  utf8Bytes,
  encodeFsName,
  TSV_NULL,
} = await import("./export.ts");

// A callout body that exercises every hard case at once: LF, CRLF, a real tab,
// a literal backslash, and a literal "\N" that must NOT be read back as NULL.
const HARD_CONTENT = "line one\nline two\r\ntab\there\\slash literal-\\N end";

// Collision-proof FK ids: the DB singleton is shared across every test file in the
// process, so other files may have left pages/sections rows behind.
const PAGE_ID = 999001;
const SECTION_ID = 999010;
// A second page carrying a property-headed table the extractor produced no property
// from — the is_property_source = 0 case (the tables B-0077 still needs to recognize).
const PAGE_ID_2 = 999002;

beforeAll(() => {
  initDb();
  // readChangelog/readCallouts read the whole table, so start from a clean slate;
  // touch only our own pages/sections rows so other files' fixtures are undisturbed.
  db.run("PRAGMA foreign_keys = OFF");
  for (const t of [
    "callouts",
    "changelogs",
    "properties",
    "video_segments",
    "videos",
    "commands",
    "page_table_cells",
    "page_table_rows",
    "page_tables",
  ]) {
    db.run(`DELETE FROM ${t}`);
  }
  db.run(`DELETE FROM sections WHERE id = ${SECTION_ID}`);
  db.run(`DELETE FROM pages WHERE id IN (${PAGE_ID}, ${PAGE_ID_2})`);
  db.run("PRAGMA foreign_keys = ON");

  // FK targets for callouts (page + section).
  db.run(
    `INSERT INTO pages (id, rosetta_id, slug, title, path, depth, url, text, code, word_count, code_lines, html_file)
     VALUES (${PAGE_ID}, 'ip-dhcp', 'ip-dhcp', 'DHCP', '/ip/dhcp', 0, 'https://example/ip-dhcp', 'body', '', 2, 0, 'ip-dhcp.html')`,
  );
  db.run(
    `INSERT INTO sections (id, page_id, heading, level, anchor_id, text, code, word_count, sort_order)
     VALUES (${SECTION_ID}, ${PAGE_ID}, 'Notes', 2, 'notes', 'x', '', 1, 0)`,
  );
  db.run(
    `INSERT INTO pages (id, rosetta_id, slug, title, path, depth, url, text, code, word_count, code_lines, html_file)
     VALUES (${PAGE_ID_2}, 'ip-pool', 'ip-pool', 'IP Pool', '/ip/pool', 0, 'https://example/ip-pool', 'body', '', 2, 0, 'ip-pool.html')`,
  );

  // Changelogs: versions deliberately out of lexical order so the numeric/beta/rc
  // comparator is the only thing that yields newest-first. "7.9.2" sorts ABOVE
  // "7.24rc1" as a string — the trap the comparator exists to avoid.
  const cl = db.prepare(
    "INSERT INTO changelogs (version, released, category, is_breaking, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)",
  );
  cl.run("7.24rc1", "2026-07-01", "firewall", 1, "breaking change", 0);
  cl.run("7.24rc1", "2026-07-01", "wifi", 0, "second entry", 1);
  cl.run("7.9.2", "2024-01-01", "system", 0, "older release", 0);

  // Callouts: one page-level (section_id NULL), one section-scoped, one with the
  // empty string as content (distinct from NULL), one multiline hard case.
  const co = db.prepare(
    "INSERT INTO callouts (page_id, type, content, section_id, sort_order) VALUES (?, ?, ?, ?, ?)",
  );
  co.run(PAGE_ID, "note", "simple note", null, 0);
  co.run(PAGE_ID, "warning", HARD_CONTENT, SECTION_ID, 1);
  co.run(PAGE_ID, "info", "", SECTION_ID, 2);

  // Properties: one resolves to a section (section_anchor should fill in), one is
  // orphaned (section_id NULL → section_anchor NULL, but stored heading text kept).
  const pr = db.prepare(
    "INSERT INTO properties (page_id, name, type, default_val, description, section, section_id, source_table_row_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  pr.run(PAGE_ID, "address", "ip", "0.0.0.0", "The IP address", "Notes", SECTION_ID, null, 0);
  pr.run(PAGE_ID, "comment", "string", null, "A comment", "Orphan Heading", null, null, 1);

  // One video, two segments: 3 + 1 = 4 transcript words, 16 + 5 = 21 UTF-8 bytes.
  // Description carries a newline to exercise the escape in a second dataset.
  db.run(
    "INSERT INTO videos (video_id, title, channel, upload_date, duration_s, url, view_count, like_count, has_chapters, description) VALUES ('VID123', 'Test Vid', 'MikroTik', '2026-01-01', 120, 'https://youtu.be/VID123', 100, 5, 1, 'multi\nline desc')",
  );
  const vid = (db.prepare("SELECT id FROM videos WHERE video_id = 'VID123'").get() as { id: number }).id;
  const seg = db.prepare("INSERT INTO video_segments (video_id, chapter_title, start_s, end_s, transcript, sort_order) VALUES (?, ?, ?, ?, ?, ?)");
  seg.run(vid, "Intro", 0, 60, "alpha beta gamma", 0);
  seg.run(vid, "Outro", 60, 120, "delta", 1);

  const cmd = db.prepare("INSERT INTO commands (path, name, type, parent_path, page_id, description, ros_version) VALUES (?, ?, ?, ?, ?, ?, ?)");
  cmd.run("/ip", "ip", "dir", null, PAGE_ID, "IP stuff", "7.20");
  cmd.run("/ip/address", "address", "cmd", "/ip", PAGE_ID, "addresses", "7.20");

  // One table attributed to the section (3 data rows) → table counts on both pages files.
  db.run(
    "INSERT INTO page_tables (page_id, section_id, source_heading, raw_markdown, column_count, data_row_count, is_ragged, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [PAGE_ID, SECTION_ID, "Notes", "| a | b |\n|---|---|\n| 1 | 2 |", 2, 3, 0, 0],
  );
  // Wire the "address" property back to this table so tables.tsv.is_property_source
  // resolves to 1. Mirror the real extractor: row_order 0 is the header, and only DATA
  // rows (row_order > 0) get a source_table_row_id — so link the property to row_order 1,
  // never the header, matching what a runtime extraction can actually emit.
  const tableId = (db.prepare("SELECT id FROM page_tables WHERE page_id = ? AND sort_order = 0").get(PAGE_ID) as { id: number }).id;
  db.run("INSERT INTO page_table_rows (table_id, row_order) VALUES (?, ?)", [tableId, 0]); // header
  const insDataRow = db.prepare("INSERT INTO page_table_rows (table_id, row_order) VALUES (?, ?)");
  const dataRowId = Number(insDataRow.run(tableId, 1).lastInsertRowid); // first data row
  db.run("UPDATE properties SET source_table_row_id = ? WHERE page_id = ? AND name = 'address'", [dataRowId, PAGE_ID]);

  // Negative case: a property-headed table on PAGE_ID_2 that produced NO property (its
  // rows exist but no property points back), so is_property_source must stay 0.
  db.run(
    "INSERT INTO page_tables (page_id, section_id, source_heading, raw_markdown, column_count, data_row_count, is_ragged, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [PAGE_ID_2, null, "Properties", "| p | q |\n|---|---|\n| 3 | 4 |", 2, 1, 0, 0],
  );
  const tableId2 = (db.prepare("SELECT id FROM page_tables WHERE page_id = ? AND sort_order = 0").get(PAGE_ID_2) as { id: number }).id;
  db.run("INSERT INTO page_table_rows (table_id, row_order) VALUES (?, ?)", [tableId2, 0]); // header
  db.run("INSERT INTO page_table_rows (table_id, row_order) VALUES (?, ?)", [tableId2, 1]); // data, unlinked
});

const ALL_FILES = ["callouts.tsv", "changelog.tsv", "commands.tsv", "pages.tsv", "properties.tsv", "sections.tsv", "tables.tsv", "videos.tsv"];

function rowsOf(dir: string, file: string): (string | null)[][] {
  return parseTsv(readFileSync(path.join(dir, file), "utf-8")).rows;
}
function colsOf(dir: string, file: string): string[] {
  return parseTsv(readFileSync(path.join(dir, file), "utf-8")).columns;
}

function exportToTmp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rosetta-export-"));
  return dir;
}

describe("TSV field codec", () => {
  test("round-trips every hard character, including a synthetic tab", () => {
    for (const v of ["", "plain", HARD_CONTENT, "\t", "\\N", "a\tb\nc\rd\\e", "trailing\\"]) {
      expect(decodeTsvField(encodeTsvField(v))).toBe(v);
    }
  });

  test("NULL and empty string are distinct facts", () => {
    expect(encodeTsvField(null)).toBe(TSV_NULL);
    expect(encodeTsvField("")).toBe("");
    expect(decodeTsvField(TSV_NULL)).toBeNull();
    expect(decodeTsvField("")).toBe("");
  });

  test("a literal \\N value cannot masquerade as NULL", () => {
    const encoded = encodeTsvField("\\N");
    expect(encoded).not.toBe(TSV_NULL);
    expect(decodeTsvField(encoded)).toBe("\\N");
  });

  test("encoded fields never contain a raw tab, LF, or CR", () => {
    const encoded = encodeTsvField(HARD_CONTENT);
    expect(/[\t\n\r]/.test(encoded)).toBe(false);
  });

  test("toTsv/parseTsv preserve one-line-per-record and decode back", () => {
    const { columns, rows } = parseTsv(toTsv(["a", "b"], [["x", HARD_CONTENT], [null, ""]]));
    expect(columns).toEqual(["a", "b"]);
    expect(rows).toEqual([["x", HARD_CONTENT], [null, ""]]);
  });
});

describe("shared helpers", () => {
  test("countWords matches the extractor rule", () => {
    expect(countWords("  one  two\tthree\nfour ")).toBe(4);
    expect(countWords("")).toBe(0);
  });

  test("encodeFsName is filesystem-safe and keeps the portable set", () => {
    expect(encodeFsName("ip-dhcp.server_2")).toBe("ip-dhcp.server_2");
    expect(encodeFsName("a/b c:d")).toBe("a%2Fb%20c%3Ad");
  });

  test("encodeFsName encodes astral characters distinctly and escapes dot segments", () => {
    // Without a code-point-aware pass, distinct emoji collapse to the same surrogate
    // replacement bytes; they must stay distinct and reversible.
    expect(encodeFsName("💩")).not.toBe(encodeFsName("😀"));
    expect(encodeFsName("💩")).toBe("%F0%9F%92%A9");
    // "." and ".." are reserved directory names — never emit them verbatim.
    expect(encodeFsName(".")).toBe("%2E");
    expect(encodeFsName("..")).toBe("%2E%2E");
    expect(encodeFsName("a.b")).toBe("a.b"); // interior dots still allowed
  });
});

describe("runExport", () => {
  test("writes manifest.toml + every flat dataset and nothing else", async () => {
    const dir = exportToTmp();
    const summary = await runExport(dir, db);
    expect(readdirSync(dir).sort()).toEqual([...ALL_FILES, "manifest.toml"].sort());
    expect(summary.files.map((f) => f.name).sort()).toEqual([...ALL_FILES].sort());
  });

  test("changelog is ordered newest-first by the numeric comparator, not lexically", async () => {
    const dir = exportToTmp();
    await runExport(dir, db);
    const { columns, rows } = parseTsv(readFileSync(path.join(dir, "changelog.tsv"), "utf-8"));
    expect(columns).toEqual(["version", "released", "category", "is_breaking", "sort_order", "description"]);
    // 7.24rc1 (both entries, by sort_order) before 7.9.2.
    expect(rows.map((r) => r[0])).toEqual(["7.24rc1", "7.24rc1", "7.9.2"]);
    expect(rows.map((r) => r[columns.indexOf("sort_order")])).toEqual(["0", "1", "0"]);
  });

  test("callouts round-trip: multiline content, NULL vs empty section_id/content", async () => {
    const dir = exportToTmp();
    await runExport(dir, db);
    const { columns, rows } = parseTsv(readFileSync(path.join(dir, "callouts.tsv"), "utf-8"));
    expect(columns).toEqual(["page_id", "rosetta_id", "section_id", "section_anchor", "type", "sort_order", "content"]);
    // sort_order 0/1/2 by (page_id, sort_order, id). rosetta_id/section_anchor are the
    // human-readable names joined in; section_anchor is NULL when section_id is NULL.
    expect(rows[0]).toEqual([String(PAGE_ID), "ip-dhcp", null, null, "note", "0", "simple note"]);
    expect(rows[1][columns.indexOf("content")]).toBe(HARD_CONTENT); // exact bytes preserved
    expect(rows[1][columns.indexOf("section_anchor")]).toBe("notes"); // resolved section name
    expect(rows[2]).toEqual([String(PAGE_ID), "ip-dhcp", String(SECTION_ID), "notes", "info", "2", ""]); // empty content, not NULL
  });

  test("every manifest row count matches the emitted file's data-row count", async () => {
    const dir = exportToTmp();
    await runExport(dir, db);
    const manifest = readFileSync(path.join(dir, "manifest.toml"), "utf-8");
    for (const file of ALL_FILES) {
      const dataRows = rowsOf(dir, file).length;
      expect(manifest).toContain(`name = "${file}"`);
      expect(manifest).toMatch(new RegExp(`name = "${file}"[\\s\\S]*?rows = ${dataRows}\\b`));
    }
  });

  test("properties resolve section_anchor via section_id (post-#90), NULL when orphaned", async () => {
    const dir = exportToTmp();
    await runExport(dir, db);
    const cols = colsOf(dir, "properties.tsv");
    expect(cols).toContain("section_anchor");
    const rows = rowsOf(dir, "properties.tsv");
    const byName = (n: string) => {
      const r = rows.find((row) => row[cols.indexOf("name")] === n);
      if (!r) throw new Error(`no property named ${n}`);
      return r;
    };
    const address = byName("address");
    expect(address[cols.indexOf("section")]).toBe("Notes");
    expect(address[cols.indexOf("section_id")]).toBe(String(SECTION_ID));
    expect(address[cols.indexOf("section_anchor")]).toBe("notes");
    const comment = byName("comment");
    expect(comment[cols.indexOf("section_id")]).toBeNull();
    expect(comment[cols.indexOf("section_anchor")]).toBeNull();
    expect(comment[cols.indexOf("section")]).toBe("Orphan Heading"); // stored heading kept
  });

  test("videos aggregate transcript word/byte counts and round-trip a multiline description", async () => {
    const dir = exportToTmp();
    await runExport(dir, db);
    const cols = colsOf(dir, "videos.tsv");
    const [v] = rowsOf(dir, "videos.tsv");
    expect(v[cols.indexOf("segment_count")]).toBe("2");
    expect(v[cols.indexOf("transcript_word_count")]).toBe("4");
    expect(v[cols.indexOf("transcript_bytes")]).toBe("21");
    expect(v[cols.indexOf("description")]).toBe("multi\nline desc");
  });

  test("commands are ordered by path", async () => {
    const dir = exportToTmp();
    await runExport(dir, db);
    const cols = colsOf(dir, "commands.tsv");
    expect(rowsOf(dir, "commands.tsv").map((r) => r[cols.indexOf("path")])).toEqual(["/ip", "/ip/address"]);
  });

  test("sections.tsv is one row per section with byte + table counts", async () => {
    const dir = exportToTmp();
    await runExport(dir, db);
    const cols = colsOf(dir, "sections.tsv");
    // The shared in-memory DB may hold other files' sections, so locate ours by id
    // rather than assuming it is the only row.
    const s = rowsOf(dir, "sections.tsv").find((r) => r[cols.indexOf("section_id")] === String(SECTION_ID));
    if (!s) throw new Error("no sections.tsv row for the seeded section");
    expect(s[cols.indexOf("word_count")]).toBe("1");
    expect(s[cols.indexOf("table_count")]).toBe("1");
    expect(s[cols.indexOf("table_row_count")]).toBe("3");
  });

  test("pages.tsv is one whole-page row with section/table rollup counts", async () => {
    const dir = exportToTmp();
    await runExport(dir, db);
    const cols = colsOf(dir, "pages.tsv");
    const row = rowsOf(dir, "pages.tsv").find((r) => r[cols.indexOf("page_id")] === String(PAGE_ID));
    if (!row) throw new Error("no pages.tsv row for the seeded page");
    expect(row[cols.indexOf("section_count")]).toBe("1");
    expect(row[cols.indexOf("empty_section_count")]).toBe("0");
    expect(row[cols.indexOf("table_count")]).toBe("1");
    expect(row[cols.indexOf("table_row_count")]).toBe("3");
  });

  test("tables.tsv lists each page_table with shape, size, and a section deep link", async () => {
    const dir = exportToTmp();
    await runExport(dir, db);
    const cols = colsOf(dir, "tables.tsv");
    // Column order is a contract: human-readable identity + shape/size stats up front,
    // identifier columns next, the two long URL columns last.
    expect(cols).toEqual([
      "page_id", "sort_order", "title", "source_heading",
      "data_row_count", "column_count", "is_ragged", "is_property_source", "raw_bytes",
      "slug", "section_anchor", "rosetta_id", "section_id", "table_url", "url",
    ]);
    const t = rowsOf(dir, "tables.tsv").find((r) => r[cols.indexOf("page_id")] === String(PAGE_ID));
    if (!t) throw new Error("no tables.tsv row for the seeded table");
    expect(t[cols.indexOf("section_anchor")]).toBe("notes");
    expect(t[cols.indexOf("source_heading")]).toBe("Notes");
    expect(t[cols.indexOf("column_count")]).toBe("2");
    expect(t[cols.indexOf("data_row_count")]).toBe("3");
    expect(t[cols.indexOf("is_ragged")]).toBe("0");
    // is_property_source = 1: the "address" property's source_table_row_id resolves
    // back to this table (page_table_rows → page_tables).
    expect(t[cols.indexOf("is_property_source")]).toBe("1");
    // table_url deep-links to the containing section (url#anchor).
    expect(t[cols.indexOf("table_url")]).toBe("https://example/ip-dhcp#notes");
    // raw_bytes = UTF-8 length of the seeded raw markdown, not a rendered size.
    expect(t[cols.indexOf("raw_bytes")]).toBe(String(utf8Bytes("| a | b |\n|---|---|\n| 1 | 2 |")));

    // Negative case: a property-headed table that produced no property stays 0 — the
    // "looks like a property table but isn't recognized yet" signal B-0077 relies on.
    const t2 = rowsOf(dir, "tables.tsv").find((r) => r[cols.indexOf("page_id")] === String(PAGE_ID_2));
    if (!t2) throw new Error("no tables.tsv row for the property-headed table on PAGE_ID_2");
    expect(t2[cols.indexOf("source_heading")]).toBe("Properties");
    expect(t2[cols.indexOf("is_property_source")]).toBe("0");
    // No section resolves → table_url is the bare page URL (no #anchor).
    expect(t2[cols.indexOf("table_url")]).toBe("https://example/ip-pool");
  });

  test("manifest provenance mirrors db_meta", async () => {
    // The DB singleton is process-wide, so snapshot and restore these keys — leaking
    // v9.9.9-test / deadbeef would let later tests observe fake provenance.
    const keys = ["release_tag", "source_commit", "built_at"];
    const saved = new Map(keys.map((k) => [k, (db.prepare("SELECT value FROM db_meta WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null]));
    try {
      db.run("INSERT OR REPLACE INTO db_meta (key, value) VALUES ('release_tag', 'v9.9.9-test')");
      db.run("INSERT OR REPLACE INTO db_meta (key, value) VALUES ('source_commit', 'deadbeef')");
      db.run("INSERT OR REPLACE INTO db_meta (key, value) VALUES ('built_at', '2026-07-16T00:00:00Z')");
      const dir = exportToTmp();
      await runExport(dir, db);
      const manifest = readFileSync(path.join(dir, "manifest.toml"), "utf-8");
      expect(manifest).toContain('release_tag = "v9.9.9-test"');
      expect(manifest).toContain('source_commit = "deadbeef"');
      expect(manifest).toContain('built_at = "2026-07-16T00:00:00Z"');
    } finally {
      for (const [k, v] of saved) {
        if (v === null) db.run("DELETE FROM db_meta WHERE key = ?", [k]);
        else db.run("INSERT OR REPLACE INTO db_meta (key, value) VALUES (?, ?)", [k, v]);
      }
    }
  });

  test("output is byte-identical across two consecutive runs on the same DB", async () => {
    const a = exportToTmp();
    const b = exportToTmp();
    await runExport(a, db);
    await runExport(b, db);
    for (const f of ["manifest.toml", ...ALL_FILES]) {
      expect(readFileSync(path.join(b, f), "utf-8")).toBe(readFileSync(path.join(a, f), "utf-8"));
    }
  });

  test("re-running overwrites its own files without deleting foreign ones", async () => {
    const dir = exportToTmp();
    await runExport(dir, db);
    const sentinel = path.join(dir, "keep-me.txt");
    await Bun.write(sentinel, "external");
    await runExport(dir, db);
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, "utf-8")).toBe("external");
  });

  // Simulate a prior run whose file set differed: inject an extra owned file (flat
  // and directory-nested) into a real export's manifest, then re-run. Safe
  // replacement (#108) must prune exactly those stale owned files — and clean the
  // emptied directory — while leaving the produced files and any foreign file alone.
  test("re-running prunes stale files a prior manifest owned, incl. an emptied dir", async () => {
    const dir = exportToTmp();
    await runExport(dir, db);
    const manifestPath = path.join(dir, "manifest.toml");

    const flatStale = path.join(dir, "ghost.tsv");
    const nestedStale = path.join(dir, "pages", "old-slug", "t--1.tsv");
    await Bun.write(flatStale, "stale flat\n");
    await Bun.write(nestedStale, "stale nested\n");
    const foreign = path.join(dir, "notes.md");
    await Bun.write(foreign, "mine");
    // Make the manifest claim ownership of the two stale files (as a prior run would).
    const doctored = `${readFileSync(manifestPath, "utf-8")}\n[[files]]\nname = "ghost.tsv"\n\n[[files]]\nname = "pages/old-slug/t--1.tsv"\n`;
    await Bun.write(manifestPath, doctored);

    await runExport(dir, db);

    expect(existsSync(flatStale)).toBe(false); // pruned
    expect(existsSync(nestedStale)).toBe(false); // pruned
    expect(existsSync(path.join(dir, "pages", "old-slug"))).toBe(false); // emptied dir cleaned
    expect(existsSync(path.join(dir, "pages"))).toBe(false); // and its now-empty parent
    expect(existsSync(foreign)).toBe(true); // untracked file untouched
    for (const f of ALL_FILES) expect(existsSync(path.join(dir, f))).toBe(true); // produced set intact
  });

  test("refuses a non-empty foreign directory unless forced or confirmed", async () => {
    const dir = exportToTmp();
    await Bun.write(path.join(dir, "someone-elses.txt"), "not ours");

    // No manifest of ours → refuse by default (no confirmFn, no force).
    await expect(runExport(dir, db)).rejects.toThrow(/not empty and has no rosetta/);
    expect(existsSync(path.join(dir, "manifest.toml"))).toBe(false); // nothing written

    // A declining confirmFn is also a refusal.
    await expect(runExport(dir, db, { confirmForeign: () => false })).rejects.toThrow(/not empty/);

    // force overwrites it, leaving the foreign file (not in our owned set) intact.
    await runExport(dir, db, { force: true });
    expect(existsSync(path.join(dir, "manifest.toml"))).toBe(true);
    expect(existsSync(path.join(dir, "someone-elses.txt"))).toBe(true);
    // Re-run now adopts our own manifest with no force needed.
    await runExport(dir, db);
    expect(existsSync(path.join(dir, "someone-elses.txt"))).toBe(true);
  });

  test("prune never deletes outside the export root, even from a tampered manifest", async () => {
    const base = exportToTmp();
    const dir = path.join(base, "ds");
    await runExport(dir, db);
    // A file OUTSIDE the export dir that a malicious/hand-edited manifest tries to own.
    const outsideFile = path.join(base, "DO-NOT-DELETE.txt");
    await Bun.write(outsideFile, "outside the root");
    const manifestPath = path.join(dir, "manifest.toml");
    await Bun.write(manifestPath, `${readFileSync(manifestPath, "utf-8")}\n[[files]]\nname = "../DO-NOT-DELETE.txt"\n`);

    await runExport(dir, db); // adopts our manifest; the traversal name must be skipped

    expect(existsSync(outsideFile)).toBe(true); // containment guard held
  });

  test("prune never follows a symlink escaping the export root", async () => {
    const base = exportToTmp();
    const dir = path.join(base, "ds");
    await runExport(dir, db);
    // A directory outside the export root, a victim file in it, and a symlink to it
    // planted inside the export dir — the lexical path check alone would not catch this.
    const outside = path.join(base, "outside");
    mkdirSync(outside, { recursive: true });
    const victim = path.join(outside, "victim.txt");
    await Bun.write(victim, "must survive");
    symlinkSync(outside, path.join(dir, "link"));
    const manifestPath = path.join(dir, "manifest.toml");
    await Bun.write(manifestPath, `${readFileSync(manifestPath, "utf-8")}\n[[files]]\nname = "link/victim.txt"\n`);

    await runExport(dir, db); // must not delete through the symlink

    expect(existsSync(victim)).toBe(true); // realpath containment held
  });

  test("writes freely into a brand-new (never-created) directory", async () => {
    const dir = path.join(exportToTmp(), "fresh-subdir"); // does not exist yet
    expect(existsSync(dir)).toBe(false);
    await runExport(dir, db);
    expect(existsSync(path.join(dir, "manifest.toml"))).toBe(true);
  });
});

describe("DB-only hard boundary", () => {
  const exportSrc = () => readFileSync(path.join(import.meta.dirname, "export.ts"), "utf-8");

  test("export.ts uses no file-read, network, subprocess, or second-DB primitive", () => {
    // The prose docstring names the forbidden *sources* (matrix/, transcripts/, …);
    // guarding the code *primitives* is what actually can't be fooled by comments.
    // Allowed FS touches: stat (existsSync/statSync), mkdir, readdir + rm (safe
    // replacement, #108), Bun.write, and a SINGLE readFileSync of our own prior
    // manifest.toml — reading our own output to know what to prune is not a
    // data-source read, which is what this boundary actually forbids.
    const src = exportSrc();
    for (const primitive of ["fetch(", "new Database", "child_process", "readFile(", "Bun.file(", "require("]) {
      expect(src).not.toContain(primitive);
    }
    // The only file-content read is the prior manifest, never a source artifact.
    const reads = [...src.matchAll(/readFileSync\(([^,)]+)/g)].map((m) => m[1].trim());
    expect(reads).toEqual(["manifestPath"]);
  });

  const importSpecifiers = (src: string): string[] => [
    ...[...src.matchAll(/(?:^|\n)\s*import\b[^;]*?\bfrom\s*["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...src.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]),
  ];

  test("export.ts + its non-stdlib dependency import only DB-safe modules", () => {
    // An import allowlist survives what the primitive scan misses: an aliased import
    // ({ readFile as rf }), a brand-new I/O module (node:https, node:net), or a
    // dynamic import(). The transitive hole GPT-5.6 flagged was `./query.ts`, which
    // pulls in db.ts (opening the global DB); the version comparator now lives in the
    // dependency-free ./version-compare.ts, so we also assert THAT module imports
    // nothing — closing the transitive closure rather than just the direct imports.
    const allowed = new Set(["bun:sqlite", "node:fs", "node:path", "./version-compare.ts"]);
    const exportImports = importSpecifiers(exportSrc());
    expect(exportImports.length).toBeGreaterThan(0);
    for (const spec of exportImports) expect({ spec, allowed: allowed.has(spec) }).toEqual({ spec, allowed: true });

    const vcSrc = readFileSync(path.join(import.meta.dirname, "version-compare.ts"), "utf-8");
    expect(importSpecifiers(vcSrc)).toEqual([]); // pure module — no imports at all
  });

  test("importing export.ts opens no database (behavioral transitive-boundary proof)", () => {
    // db.ts opens `new Database(DB_PATH)` at import time, so if export.ts still
    // transitively imported it, importing export.ts under a DB_PATH in a nonexistent
    // directory would throw "unable to open database file". A clean import proves the
    // module graph reaches no DB — the runtime guarantee behind runExport(db)'s
    // "reads only the passed handle".
    const script =
      `process.env.DB_PATH=${JSON.stringify("/nonexistent-rosetta-dir-xyz/should-not-open.db")};` +
      `await import(${JSON.stringify(path.join(import.meta.dirname, "export.ts"))});` +
      `console.log("IMPORT_OK");`;
    const proc = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    expect(proc.stderr.toString()).not.toContain("unable to open database");
    expect(proc.stdout.toString()).toContain("IMPORT_OK");
    expect(proc.exitCode).toBe(0);
  });
});

// Runs LAST so the cliref rows it inserts into the shared singleton never reach the
// exact-file-set assertions above (which expect no cli-reference/* output). Uses unique
// paths/names so the name-based field view stays deterministic against other files' rows.
describe("runExport — cli-reference overlay (issue #124)", () => {
  const CE = 990100; // entry/page id base, collision-proof
  test("emits six TSVs + byte-exact source md, with entry_source_path not field_path", async () => {
    db.run(
      "INSERT INTO schema_nodes (path,name,type,inspect_type,parent_path) VALUES " +
        "('/ztcert','ztcert','dir','dir','/'),('/ztcert/add','add','cmd','cmd','/ztcert'),('/ztcert/add/ztname','ztname','arg','arg','/ztcert/add')",
    );
    const md = "# Ztcert\n\n## ztcert\n\n**Type:** Directory\n\nprose\n";
    const sha = new Bun.CryptoHasher("sha256").update(md).digest("hex");
    db.run(`INSERT INTO cliref_pages (id,slug,url,toc_name,toc_group,source_title,source_markdown,source_sha256,source_order) VALUES (${CE},'ztcert','u','Ztcert','','Ztcert',?,?,990000)`, [md, sha]);
    db.run(`INSERT INTO cliref_entries (id,page_id,source_heading,source_path,source_type,heading_level,description_markdown,source_order,source_line,source_end_line) VALUES (${CE},${CE},'ztcert','ztcert','Directory',2,'prose',0,3,7)`);
    db.run(`INSERT INTO cliref_fields (id,entry_id,field_kind,name,raw_type,mandatory,unsettable,description_markdown,source_order,source_line) VALUES (${CE},${CE},'Argument','ztname','string',0,0,'The name',0,5)`);
    db.run(`INSERT INTO cliref_flags (id,entry_id,flag,name,description_markdown,source_order,source_line) VALUES (${CE},${CE},'X','disabled','is disabled',0,4)`);
    const nodeId = (db.prepare("SELECT id FROM schema_nodes WHERE path='/ztcert'").get() as { id: number }).id;
    db.run(`INSERT INTO cliref_entry_schema_links (entry_id,schema_node_id,match_kind,match_detail) VALUES (${CE},${nodeId},'exact',NULL)`);

    const dir = exportToTmp();
    const summary = await runExport(dir, db);
    const cli = summary.files.filter((f) => f.name.startsWith("cli-reference/")).map((f) => f.name).sort();
    expect(cli).toEqual([
      "cli-reference/entries.tsv",
      "cli-reference/entry-inspect-links.tsv",
      "cli-reference/field-inspect-links.tsv",
      "cli-reference/fields.tsv",
      "cli-reference/flags.tsv",
      "cli-reference/pages.tsv",
    ]);

    const fields = parseTsv(readFileSync(path.join(dir, "cli-reference/fields.tsv"), "utf-8"));
    expect(fields.columns).toContain("entry_source_path");
    expect(fields.columns).not.toContain("field_path");

    // The field view derives ztname -> /ztcert/add/ztname (unique, so exactly one row).
    const flinks = parseTsv(readFileSync(path.join(dir, "cli-reference/field-inspect-links.tsv"), "utf-8"));
    const mine = flinks.rows.filter((r) => r[flinks.columns.indexOf("field_name")] === "ztname");
    expect(mine.map((r) => r[flinks.columns.indexOf("inspect_path")])).toEqual(["/ztcert/add/ztname"]);

    // source md round-trips byte-for-byte to its manifest sha256.
    const src = readFileSync(path.join(dir, "cli-reference/source/ztcert.md"));
    const hash = new Bun.CryptoHasher("sha256").update(src).digest("hex");
    const manifest = readFileSync(path.join(dir, "manifest.toml"), "utf-8");
    expect(manifest).toContain(`sha256 = "${hash}"`);
    expect(manifest).toContain('name = "cli-reference/source/ztcert.md"');
  });
});
