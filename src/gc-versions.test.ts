import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  compareRouterOsVersions,
  computeActiveChannelHeads,
  gcSchemaNodePresence,
} from "./gc-versions.ts";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys=ON;");

  db.run(`CREATE TABLE ros_versions (
    version TEXT NOT NULL,
    arch TEXT NOT NULL DEFAULT 'x86',
    channel TEXT,
    extra_packages INTEGER NOT NULL DEFAULT 0,
    extracted_at TEXT NOT NULL,
    PRIMARY KEY (version, arch)
  );`);

  db.run(`CREATE TABLE schema_nodes (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    UNIQUE(path, type)
  );`);

  db.run(`CREATE TABLE schema_node_presence (
    node_id INTEGER NOT NULL REFERENCES schema_nodes(id),
    version TEXT NOT NULL,
    PRIMARY KEY (node_id, version)
  );`);

  db.run(`CREATE TABLE command_versions (
    command_path TEXT NOT NULL,
    ros_version TEXT NOT NULL,
    PRIMARY KEY (command_path, ros_version)
  );`);

  for (let i = 1; i <= 3; i++) {
    db.run("INSERT INTO schema_nodes (id, path, name, type) VALUES (?, ?, ?, 'cmd')", [
      i,
      `/node-${i}`,
      `node-${i}`,
    ]);
  }

  return db;
}

function insertVersion(db: Database, version: string, channel: string | null, arch = "x86"): void {
  db.run(
    `INSERT INTO ros_versions (version, arch, channel, extra_packages, extracted_at)
     VALUES (?, ?, ?, 1, '2026-04-26T00:00:00Z')`,
    [version, arch, channel],
  );
}

function insertPresence(db: Database, version: string, nodeIds = [1, 2]): void {
  for (const nodeId of nodeIds) {
    db.run("INSERT INTO schema_node_presence (node_id, version) VALUES (?, ?)", [nodeId, version]);
  }
}

function insertCommandVersion(db: Database, version: string): void {
  db.run("INSERT INTO command_versions (command_path, ros_version) VALUES (?, ?)", ["/ip/address/add", version]);
}

function count(db: Database, sql: string): number {
  return (db.prepare(sql).get() as { c: number }).c;
}

describe("RouterOS semantic version sorting", () => {
  test("sorts numeric releases and prereleases semantically", () => {
    const versions = ["7.23", "7.9", "7.23rc1", "7.10", "7.23beta2", "7.23beta10", "7.22.1"];

    expect(versions.sort(compareRouterOsVersions)).toEqual([
      "7.9",
      "7.10",
      "7.22.1",
      "7.23beta2",
      "7.23beta10",
      "7.23rc1",
      "7.23",
    ]);
  });
});

describe("computeActiveChannelHeads", () => {
  test("keeps the newest version per recognized active channel", () => {
    const heads = computeActiveChannelHeads([
      { version: "7.9", channel: "stable" },
      { version: "7.10", channel: "stable" },
      { version: "7.22", channel: "long-term" },
      { version: "7.23beta2", channel: "testing" },
      { version: "7.23rc1", channel: "testing" },
      { version: "7.24beta1", channel: "development" },
      { version: "9.99", channel: "legacy" },
      { version: "10.0", channel: null },
    ]);

    expect(heads).toEqual({
      stable: "7.10",
      "long-term": "7.22",
      testing: "7.23rc1",
      development: "7.24beta1",
    });
  });
});

describe("gcSchemaNodePresence", () => {
  test("dry-run reports candidates without mutating schema_node_presence", () => {
    const db = createTestDb();
    try {
      insertVersion(db, "7.9", "stable");
      insertVersion(db, "7.10", "stable");
      insertPresence(db, "7.9");
      insertPresence(db, "7.10");

      const stats = gcSchemaNodePresence(db, { dryRun: true });

      expect(stats.dry_run).toBe(true);
      expect(stats.before_count).toBe(4);
      expect(stats.after_count).toBe(4);
      expect(stats.deleted_rows).toBe(0);
      expect(stats.would_delete_rows).toBe(2);
      expect(stats.kept_versions).toEqual(["7.10"]);
      expect(stats.pruned_versions).toEqual(["7.9"]);
      expect(count(db, "SELECT COUNT(*) AS c FROM schema_node_presence")).toBe(4);
    } finally {
      db.close();
    }
  });

  test("de-duplicates ros_versions by version when arches differ", () => {
    const db = createTestDb();
    try {
      insertVersion(db, "7.21", "stable", "x86");
      insertVersion(db, "7.22", "stable", "x86");
      insertVersion(db, "7.22", "stable", "arm64");
      insertPresence(db, "7.21");
      insertPresence(db, "7.22");

      const stats = gcSchemaNodePresence(db);

      expect(stats.kept_versions).toEqual(["7.22"]);
      expect(stats.pruned_versions).toEqual(["7.21"]);
      expect(stats.deleted_rows).toBe(2);
      expect(count(db, "SELECT COUNT(*) AS c FROM schema_node_presence WHERE version = '7.22'")).toBe(2);
      expect(count(db, "SELECT COUNT(*) AS c FROM schema_node_presence WHERE version = '7.21'")).toBe(0);
    } finally {
      db.close();
    }
  });

  test("skips safely when no recognized channel heads can be computed", () => {
    const db = createTestDb();
    try {
      insertVersion(db, "7.9", "legacy");
      insertVersion(db, "7.10", null);
      insertPresence(db, "7.9");
      insertPresence(db, "7.10");

      const stats = gcSchemaNodePresence(db);

      expect(stats.skipped).toBe(true);
      expect(stats.deleted_rows).toBe(0);
      expect(stats.kept_versions).toEqual([]);
      expect(stats.note).toContain("skipped");
      expect(count(db, "SELECT COUNT(*) AS c FROM schema_node_presence")).toBe(4);
    } finally {
      db.close();
    }
  });

  test("prunes only schema_node_presence and leaves command_versions untouched", () => {
    const db = createTestDb();
    try {
      insertVersion(db, "7.20", "stable");
      insertVersion(db, "7.22", "stable");
      insertVersion(db, "7.23beta1", "development");
      for (const version of ["7.20", "7.22", "7.23beta1"]) {
        insertPresence(db, version);
        insertCommandVersion(db, version);
      }

      const stats = gcSchemaNodePresence(db);

      expect(stats.kept_versions).toEqual(["7.22", "7.23beta1"]);
      expect(stats.pruned_versions).toEqual(["7.20"]);
      expect(stats.deleted_rows).toBe(2);
      expect(count(db, "SELECT COUNT(*) AS c FROM schema_node_presence")).toBe(4);
      expect(count(db, "SELECT COUNT(*) AS c FROM command_versions")).toBe(3);
      expect(count(db, "SELECT COUNT(*) AS c FROM command_versions WHERE ros_version = '7.20'")).toBe(1);
    } finally {
      db.close();
    }
  });
});
