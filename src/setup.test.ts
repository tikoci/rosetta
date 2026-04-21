/**
 * setup.test.ts — Tests for DB download helpers.
 *
 * Covers the parts that don't require network: URL construction and DB probing
 * against fixture DBs written to a temp directory. The full download path is
 * validated structurally in release.test.ts.
 */

import sqlite from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "rosetta-setup-test-"));

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

const { probeDb, dbDownloadUrls } = await import("./setup.ts");
const { SCHEMA_VERSION } = await import("./paths.ts");

// ---------------------------------------------------------------------------
// dbDownloadUrls — version pinning + latest fallback
// ---------------------------------------------------------------------------

describe("dbDownloadUrls", () => {
  test("returns pinned + latest for a real version", () => {
    const urls = dbDownloadUrls("0.7.3");
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/releases/download/v0.7.3/ros-help.db.gz");
    expect(urls[1]).toContain("/releases/latest/download/ros-help.db.gz");
  });

  test("preserves the v prefix when supplied", () => {
    const urls = dbDownloadUrls("v0.8.0");
    expect(urls[0]).toContain("/releases/download/v0.8.0/ros-help.db.gz");
  });

  test("returns only /latest/ when version is unknown or dev", () => {
    expect(dbDownloadUrls("unknown")).toEqual([
      expect.stringContaining("/releases/latest/download/ros-help.db.gz"),
    ]);
    expect(dbDownloadUrls("dev")).toEqual([
      expect.stringContaining("/releases/latest/download/ros-help.db.gz"),
    ]);
    expect(dbDownloadUrls("")).toEqual([
      expect.stringContaining("/releases/latest/download/ros-help.db.gz"),
    ]);
  });
});

// ---------------------------------------------------------------------------
// probeDb — schema / pages / commands / release_tag
// ---------------------------------------------------------------------------

describe("probeDb", () => {
  test("returns null for a missing file", () => {
    expect(probeDb(path.join(tmp, "does-not-exist.db"))).toBeNull();
  });

  test("returns null for a non-SQLite file", () => {
    const garbage = path.join(tmp, "garbage.db");
    writeFileSync(garbage, "this is not a SQLite database");
    expect(probeDb(garbage)).toBeNull();
  });

  test("reads schema_version, page count, command count, and release_tag", () => {
    const dbFile = path.join(tmp, "fixture.db");
    const db = new sqlite(dbFile);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    db.run("CREATE TABLE pages (id INTEGER PRIMARY KEY, title TEXT);");
    db.run("CREATE TABLE commands (id INTEGER PRIMARY KEY, path TEXT);");
    db.run("CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");

    const insertPage = db.prepare("INSERT INTO pages (title) VALUES (?)");
    for (let i = 0; i < 7; i++) insertPage.run(`page-${i}`);
    const insertCmd = db.prepare("INSERT INTO commands (path) VALUES (?)");
    for (let i = 0; i < 13; i++) insertCmd.run(`/cmd/${i}`);
    db.run("INSERT INTO db_meta (key, value) VALUES ('release_tag', 'v0.0.0-test');");
    db.close();

    const probe = probeDb(dbFile);
    expect(probe).not.toBeNull();
    expect(probe?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(probe?.pages).toBe(7);
    expect(probe?.commands).toBe(13);
    expect(probe?.releaseTag).toBe("v0.0.0-test");
  });

  test("releaseTag is null when db_meta is absent (pre-v5 schema)", () => {
    const dbFile = path.join(tmp, "no-meta.db");
    const db = new sqlite(dbFile);
    db.run("PRAGMA user_version = 4;");
    db.run("CREATE TABLE pages (id INTEGER PRIMARY KEY);");
    db.run("CREATE TABLE commands (id INTEGER PRIMARY KEY);");
    db.close();

    const probe = probeDb(dbFile);
    expect(probe).not.toBeNull();
    expect(probe?.schemaVersion).toBe(4);
    expect(probe?.releaseTag).toBeNull();
  });
});
