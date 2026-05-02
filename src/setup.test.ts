/**
 * setup.test.ts — Tests for DB download helpers.
 *
 * Covers the parts that don't require network: URL construction and DB probing
 * against fixture DBs written to a temp directory. The full download path is
 * validated structurally in release.test.ts.
 */

import sqlite from "bun:sqlite";
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tmp = mkdtempSync(path.join(tmpdir(), "rosetta-setup-test-"));

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
});

const {
  cleanupStaleTempArtifacts,
  dbDownloadUrls,
  probeDb,
  releaseDownloadLock,
  tryAcquireDownloadLock,
  waitForUsableDb,
} = await import("./setup.ts");
const { SCHEMA_VERSION } = await import("./paths.ts");

function writeUsableDb(dbFile: string, releaseTag = "v0.0.0-test"): void {
  const db = new sqlite(dbFile);
  db.run(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  db.run("CREATE TABLE pages (id INTEGER PRIMARY KEY, title TEXT);");
  db.run("CREATE TABLE commands (id INTEGER PRIMARY KEY, path TEXT);");
  db.run("CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");

  const insertPage = db.prepare("INSERT INTO pages (title) VALUES (?)");
  for (let i = 0; i < 100; i++) insertPage.run(`page-${i}`);

  const insertCmd = db.prepare("INSERT INTO commands (path) VALUES (?)");
  for (let i = 0; i < 1000; i++) insertCmd.run(`/cmd/${i}`);

  db.run("INSERT INTO db_meta (key, value) VALUES ('release_tag', ?);", [releaseTag]);
  db.close();
}

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
// download lock helpers — serialize package-mode DB preparation
// ---------------------------------------------------------------------------

describe("download lock helpers", () => {
  test("lock is exclusive until released", () => {
    const dbFile = path.join(tmp, "locked.db");
    const first = tryAcquireDownloadLock(dbFile);
    expect(first).not.toBeNull();
    const second = tryAcquireDownloadLock(dbFile);
    expect(second).toBeNull();

    releaseDownloadLock(first);

    const third = tryAcquireDownloadLock(dbFile);
    expect(third).not.toBeNull();
    releaseDownloadLock(third);
  });

  test("waitForUsableDb returns false when lock goes away without a healthy DB", async () => {
    const dbFile = path.join(tmp, "wait-false.db");
    const lock = tryAcquireDownloadLock(dbFile);
    expect(lock).not.toBeNull();

    const waiter = waitForUsableDb(dbFile, () => {}, 2_000);
    setTimeout(() => releaseDownloadLock(lock), 100);

    expect(await waiter).toBe(false);
  });

  test("waitForUsableDb returns true when another process finishes the DB", async () => {
    const dbFile = path.join(tmp, "wait-true.db");
    const lock = tryAcquireDownloadLock(dbFile);
    expect(lock).not.toBeNull();

    writeUsableDb(dbFile, "v0.0.0-wait");
    const waiter = waitForUsableDb(dbFile, () => {}, 2_000);
    setTimeout(() => releaseDownloadLock(lock), 100);

    expect(await waiter).toBe(true);
    const probe = probeDb(dbFile);
    expect(probe?.releaseTag).toBe("v0.0.0-wait");
    expect(probe?.pages).toBe(100);
    expect(probe?.commands).toBe(1000);
  });

  test("waitForUsableDb does not create a missing canonical DB while waiting", async () => {
    const dbFile = path.join(tmp, "wait-no-create.db");
    const lock = tryAcquireDownloadLock(dbFile);
    expect(lock).not.toBeNull();

    const waiter = waitForUsableDb(dbFile, () => {}, 2_000);
    await Bun.sleep(100);
    expect(existsSync(dbFile)).toBe(false);

    releaseDownloadLock(lock);
    expect(await waiter).toBe(false);
    expect(existsSync(dbFile)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// probeDb — schema / pages / commands / release_tag
// ---------------------------------------------------------------------------

describe("probeDb", () => {
  test("returns null for a missing file", () => {
    const missing = path.join(tmp, "does-not-exist.db");
    expect(probeDb(missing)).toBeNull();
    expect(existsSync(missing)).toBe(false);
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

  test("opens a freshly-renamed WAL-mode DB with no .shm sibling", () => {
    // Reproduces the exact state downloadDb leaves the DB in: journal_mode=WAL
    // on disk, but the .wal/.shm siblings are deleted just before the rename.
    // On macOS, opening such a file with { readonly: true } fails with
    // "unable to open database file" because SQLite cannot create the shm
    // from a read-only handle. probeDb intentionally opens read-write.
    const dbFile = path.join(tmp, "wal-no-shm.db");
    const seed = new sqlite(dbFile);
    seed.exec("PRAGMA journal_mode = WAL");
    seed.run(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    seed.run("CREATE TABLE pages (id INTEGER PRIMARY KEY);");
    seed.run("CREATE TABLE commands (id INTEGER PRIMARY KEY);");
    seed.run("INSERT INTO pages (id) VALUES (1), (2), (3);");
    seed.run("INSERT INTO commands (id) VALUES (1), (2);");
    seed.close();

    // Simulate downloadDb's post-rename cleanup — WAL file on disk marks WAL
    // mode in the header, but the transient .wal/.shm are gone.
    for (const suffix of ["-wal", "-shm"]) {
      const p = dbFile + suffix;
      if (existsSync(p)) unlinkSync(p);
    }

    const probe = probeDb(dbFile);
    expect(probe).not.toBeNull();
    expect(probe?.schemaVersion).toBe(SCHEMA_VERSION);
    expect(probe?.pages).toBe(3);
    expect(probe?.commands).toBe(2);
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

describe("cleanupStaleTempArtifacts", () => {
  test("removes stale temp DB files and sidecars", () => {
    const dbFile = path.join(tmp, "cleanup.db");
    const artifacts = [
      `${dbFile}.tmp.111`,
      `${dbFile}.tmp.111-wal`,
      `${dbFile}.tmp.111-shm`,
    ];

    for (const artifact of artifacts) {
      writeFileSync(artifact, "x");
    }

    expect(cleanupStaleTempArtifacts(dbFile, -1)).toBe(3);
    for (const artifact of artifacts) {
      expect(existsSync(artifact)).toBe(false);
    }
  });
});
