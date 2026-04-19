/**
 * schema-roundtrip.test.ts — Tests for extract-schema.ts importer.
 *
 * Tests cover:
 *   - Fixture import into in-memory DB
 *   - Arch-specific node detection (x86-only, arm64-only, shared)
 *   - dir_role derivation (list, namespace, hybrid)
 *   - desc_raw parsing (string, enum, time, range, script)
 *   - _completion data landing in _attrs
 *   - schema_node_presence row counts
 *   - Legacy commands table regeneration
 *   - parseDesc() unit tests
 */

import { Database } from "bun:sqlite";
import { beforeAll, describe, expect, test } from "bun:test";
import type { FlatNode } from "./extract-schema.ts";
import { importSchemaNodes, mergeArchNodes, parseDesc, walk } from "./extract-schema.ts";

// ---------------------------------------------------------------------------
// In-memory DB with schema_nodes tables — mirrors initDb() schema
// ---------------------------------------------------------------------------

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.run("PRAGMA journal_mode=WAL;");
  db.run("PRAGMA foreign_keys=ON;");

  // Minimal pages table for FK
  db.run(`CREATE TABLE pages (id INTEGER PRIMARY KEY, title TEXT);`);

  // schema_nodes
  db.run(`CREATE TABLE schema_nodes (
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

  db.run(`CREATE INDEX idx_sn_parent ON schema_nodes(parent_path);`);
  db.run(`CREATE INDEX idx_sn_type ON schema_nodes(type);`);
  db.run(`CREATE INDEX idx_sn_path ON schema_nodes(path);`);

  db.run(`CREATE TABLE schema_node_presence (
    node_id INTEGER NOT NULL REFERENCES schema_nodes(id),
    version TEXT NOT NULL,
    PRIMARY KEY (node_id, version)
  );`);

  db.run(`CREATE INDEX idx_snp_version ON schema_node_presence(version);`);

  // Legacy compat tables
  db.run(`CREATE TABLE commands (
    id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, type TEXT NOT NULL,
    parent_path TEXT, page_id INTEGER,
    description TEXT, ros_version TEXT
  );`);

  db.run(`CREATE TABLE command_versions (
    command_path TEXT NOT NULL, ros_version TEXT NOT NULL,
    PRIMARY KEY (command_path, ros_version)
  );`);

  db.run(`CREATE TABLE ros_versions (
    version TEXT NOT NULL, arch TEXT NOT NULL DEFAULT 'x86',
    channel TEXT, extra_packages INTEGER NOT NULL DEFAULT 0,
    extracted_at TEXT NOT NULL, generated_at TEXT,
    crash_paths_tested TEXT, crash_paths_crashed TEXT,
    crash_paths_safe TEXT, completion_stats TEXT,
    source_url TEXT, api_transport TEXT,
    enrichment_duration_ms INTEGER, _attrs TEXT,
    PRIMARY KEY (version, arch)
  );`);

  return db;
}

// ---------------------------------------------------------------------------
// Load fixtures
// ---------------------------------------------------------------------------

let x86Data: Record<string, unknown>;
let arm64Data: Record<string, unknown>;

beforeAll(async () => {
  x86Data = await Bun.file("fixtures/deep-inspect.x86.sample.json").json();
  arm64Data = await Bun.file("fixtures/deep-inspect.arm64.sample.json").json();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseDesc", () => {
  test("string value", () => {
    const r = parseDesc("string value");
    expect(r.dataType).toBe("string");
    expect(r.maxLength).toBeNull();
  });

  test("string value, max length N", () => {
    const r = parseDesc("string value, max length 255");
    expect(r.dataType).toBe("string");
    expect(r.maxLength).toBe(255);
  });

  test("script", () => {
    const r = parseDesc("script");
    expect(r.dataType).toBe("script");
  });

  test("time interval", () => {
    const r = parseDesc("time interval");
    expect(r.dataType).toBe("time");
    expect(r.rangeMin).toBeNull();
  });

  test("time interval with range", () => {
    const r = parseDesc("00:00:00.100..00:30:00    (time interval)");
    expect(r.dataType).toBe("time");
    expect(r.rangeMin).toBe("00:00:00.100");
    expect(r.rangeMax).toBe("00:30:00");
  });

  test("simple enum", () => {
    const r = parseDesc("auto|disabled|enabled");
    expect(r.dataType).toBe("enum");
    expect(r.enumValues).not.toBeNull();
    expect(JSON.parse(r.enumValues as string)).toEqual(["auto", "disabled", "enabled"]);
    expect(r.enumMulti).toBeNull();
  });

  test("enum with multi marker and type tag", () => {
    const r = parseDesc("ftp|reboot|read|write|policy|test|password|sniff|sensitive|romon[,Permission*]");
    expect(r.dataType).toBe("enum");
    expect(r.enumMulti).toBe(1);
    expect(r.typeTag).toBe("Permission");
    expect(r.enumValues).not.toBeNull();
    const vals = JSON.parse(r.enumValues as string);
    expect(vals).toContain("ftp");
    expect(vals).toContain("romon");
    expect(vals.length).toBe(10);
  });

  test("null desc returns all nulls", () => {
    const r = parseDesc(null);
    expect(r.dataType).toBeNull();
  });

  test("unknown desc returns all nulls", () => {
    const r = parseDesc("something custom");
    expect(r.dataType).toBeNull();
  });

  test("integer range", () => {
    const r = parseDesc("0..4294967295    (integer)");
    expect(r.dataType).toBe("integer");
    expect(r.rangeMin).toBe("0");
    expect(r.rangeMax).toBe("4294967295");
  });
});

describe("fixture import", () => {
  test("walk produces expected node counts", () => {
    const x86Nodes: FlatNode[] = [];
    const arm64Nodes: FlatNode[] = [];
    walk(x86Data, "", x86Nodes);
    walk(arm64Data, "", arm64Nodes);

    // x86 has /system/check-disk, /system/console, /system/console/screen (3 extra)
    // arm64 has /interface/wifi-qcom, wifi-qcom/info, wifi-qcom/info/interface (3 extra)
    // Both have /app/add and /app/add/copy-from
    expect(x86Nodes.length).toBe(33);
    expect(arm64Nodes.length).toBe(33);
  });

  test("arch diff detection", () => {
    const x86Nodes: FlatNode[] = [];
    const arm64Nodes: FlatNode[] = [];
    walk(x86Data, "", x86Nodes);
    walk(arm64Data, "", arm64Nodes);

    const merged = mergeArchNodes(x86Nodes, arm64Nodes);

    const x86Only = merged.filter((n) => n.arch === "x86");
    const arm64Only = merged.filter((n) => n.arch === "arm64");
    const shared = merged.filter((n) => n.arch === null);

    expect(x86Only.length).toBe(3);
    expect(arm64Only.length).toBe(3);
    expect(shared.length).toBe(30);
    expect(merged.length).toBe(36);

    // Verify specific arch-only paths
    const x86Paths = x86Only.map((n) => n.path).sort();
    expect(x86Paths).toContain("/system/check-disk");
    expect(x86Paths).toContain("/system/console");
    expect(x86Paths).toContain("/system/console/screen");

    const arm64Paths = arm64Only.map((n) => n.path).sort();
    expect(arm64Paths).toContain("/interface/wifi-qcom");
    expect(arm64Paths).toContain("/interface/wifi-qcom/info");
    expect(arm64Paths).toContain("/interface/wifi-qcom/info/interface");
  });

  test("completion data preserved in merge", () => {
    const x86Nodes: FlatNode[] = [];
    const arm64Nodes: FlatNode[] = [];
    walk(x86Data, "", x86Nodes);
    walk(arm64Data, "", arm64Nodes);

    const merged = mergeArchNodes(x86Nodes, arm64Nodes);
    const withCompletion = merged.filter((n) => n.completion !== null);
    expect(withCompletion.length).toBe(4);

    // Check disabled arg completion shape
    const disabled = withCompletion.find((n) => n.path === "/ip/address/add/disabled");
    expect(disabled).toBeDefined();
    expect(disabled?.completion).toHaveProperty("no");
    expect(disabled?.completion).toHaveProperty("yes");
    expect(disabled?.completion?.no.style).toBe("arg");

    // Check copy-from with desc
    const copyFrom = withCompletion.find((n) => n.path === "/app/add/copy-from");
    expect(copyFrom).toBeDefined();
    expect(copyFrom?.completion?.["my-app"].desc).toBe("My custom app");
  });

  test("full import into in-memory DB via importSchemaNodes", () => {
    const testDb = createTestDb();
    const x86Nodes: FlatNode[] = [];
    const arm64Nodes: FlatNode[] = [];
    walk(x86Data, "", x86Nodes);
    walk(arm64Data, "", arm64Nodes);
    const merged = mergeArchNodes(x86Nodes, arm64Nodes);

    importSchemaNodes(testDb, merged, "7.99-fixture", {
      accumulate: false,
      extraPackages: false,
      channel: "stable",
      x86Source: "fixtures/deep-inspect.x86.sample.json",
      arm64Source: "fixtures/deep-inspect.arm64.sample.json",
    });

    // Verify counts
    const count = (sql: string) => (testDb.prepare(sql).get() as { c: number }).c;
    expect(count("SELECT COUNT(*) as c FROM schema_nodes")).toBe(36);
    expect(count("SELECT COUNT(*) as c FROM schema_nodes WHERE _arch IS NULL")).toBe(30);
    expect(count("SELECT COUNT(*) as c FROM schema_nodes WHERE _arch = 'x86'")).toBe(3);
    expect(count("SELECT COUNT(*) as c FROM schema_nodes WHERE _arch = 'arm64'")).toBe(3);
    expect(count("SELECT COUNT(*) as c FROM schema_nodes WHERE _attrs IS NOT NULL")).toBe(4);

    // Verify dir_role
    const ipAddr = testDb.prepare("SELECT dir_role FROM schema_nodes WHERE path = '/ip/address'").get() as { dir_role: string };
    expect(ipAddr.dir_role).toBe("list"); // has cmds: add, set, remove, print

    const ip = testDb.prepare("SELECT dir_role FROM schema_nodes WHERE path = '/ip'").get() as { dir_role: string };
    expect(ip.dir_role).toBe("namespace"); // only has dir children

    const system = testDb.prepare("SELECT dir_role FROM schema_nodes WHERE path = '/system'").get() as { dir_role: string };
    // /system has both dirs (console, script) and cmds (shutdown, check-disk)
    expect(system.dir_role).toBe("hybrid");

    // Verify desc parsing
    const comment = testDb.prepare("SELECT data_type, max_length FROM schema_nodes WHERE path = '/ip/address/add/comment'").get() as { data_type: string; max_length: number };
    expect(comment.data_type).toBe("string");
    expect(comment.max_length).toBe(255);

    const policy = testDb.prepare("SELECT data_type, enum_values, enum_multi, type_tag FROM schema_nodes WHERE path = '/system/script/add/policy'").get() as { data_type: string; enum_values: string; enum_multi: number; type_tag: string };
    expect(policy.data_type).toBe("enum");
    expect(policy.enum_multi).toBe(1);
    expect(policy.type_tag).toBe("Permission");
    expect(JSON.parse(policy.enum_values)).toContain("ftp");

    const interval = testDb.prepare("SELECT data_type, range_min, range_max FROM schema_nodes WHERE path = '/interface/monitor/interval'").get() as { data_type: string; range_min: string; range_max: string };
    expect(interval.data_type).toBe("time");
    expect(interval.range_min).toBe("00:00:00.100");
    expect(interval.range_max).toBe("00:30:00");

    const source = testDb.prepare("SELECT data_type FROM schema_nodes WHERE path = '/system/script/add/source'").get() as { data_type: string };
    expect(source.data_type).toBe("script");

    // Verify completion round-trip
    const disabled = testDb.prepare("SELECT _attrs FROM schema_nodes WHERE path = '/ip/address/add/disabled'").get() as { _attrs: string };
    const attrs = JSON.parse(disabled._attrs);
    expect(attrs.completion).toBeDefined();
    expect(attrs.completion.no.style).toBe("arg");
    expect(attrs.completion.yes.preference).toBe(96);

    const copyFrom = testDb.prepare("SELECT _attrs FROM schema_nodes WHERE path = '/app/add/copy-from'").get() as { _attrs: string };
    const cfAttrs = JSON.parse(copyFrom._attrs);
    expect(cfAttrs.completion["my-app"].desc).toBe("My custom app");
    expect(cfAttrs.completion["dns-doh"].desc).toBe("DNS over HTTPS");

    // Verify legacy compat: commands table regenerated
    expect(count("SELECT COUNT(*) as c FROM commands")).toBe(36);

    // Verify schema_node_presence
    expect(count("SELECT COUNT(*) as c FROM schema_node_presence")).toBe(36);

    // Verify command_versions compat
    expect(count("SELECT COUNT(*) as c FROM command_versions")).toBe(36);

    // Verify parent_id self-join: dir → dir
    const ipAddrParent = testDb.prepare(`
      SELECT p.path AS parent FROM schema_nodes c
      JOIN schema_nodes p ON p.id = c.parent_id
      WHERE c.path = '/ip/address'
    `).get() as { parent: string } | null;
    expect(ipAddrParent?.parent).toBe("/ip");

    // Verify parent_id self-join: arg → cmd (the fix — previously type='dir' filter broke this)
    const disabledParent = testDb.prepare(`
      SELECT p.path AS parent, p.type AS parent_type FROM schema_nodes c
      JOIN schema_nodes p ON p.id = c.parent_id
      WHERE c.path = '/ip/address/add/disabled'
    `).get() as { parent: string; parent_type: string } | null;
    expect(disabledParent?.parent).toBe("/ip/address/add");
    expect(disabledParent?.parent_type).toBe("cmd");

    testDb.close();
  });
});

describe("schema_node_presence", () => {
  test("presence populated for all nodes via importSchemaNodes", () => {
    const testDb = createTestDb();
    const x86Nodes: FlatNode[] = [];
    const arm64Nodes: FlatNode[] = [];
    walk(x86Data, "", x86Nodes);
    walk(arm64Data, "", arm64Nodes);
    const merged = mergeArchNodes(x86Nodes, arm64Nodes);

    importSchemaNodes(testDb, merged, "7.99-fixture", {
      accumulate: false,
      extraPackages: false,
      channel: "stable",
      x86Source: "fixtures/deep-inspect.x86.sample.json",
      arm64Source: "fixtures/deep-inspect.arm64.sample.json",
    });

    const count = (testDb.prepare("SELECT COUNT(*) as c FROM schema_node_presence").get() as { c: number }).c;
    expect(count).toBe(36);

    // Verify specific node presence
    const wifiQcom = testDb.prepare(`
      SELECT snp.version FROM schema_node_presence snp
      JOIN schema_nodes sn ON sn.id = snp.node_id
      WHERE sn.path = '/interface/wifi-qcom'
    `).all() as Array<{ version: string }>;
    expect(wifiQcom.length).toBe(1);
    expect(wifiQcom[0].version).toBe("7.99-fixture");

    testDb.close();
  });
});
