import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { CLIREF_FIELD_VIEW_SQL } from "./db.ts";
import { resolveEntry } from "./link-cliref.ts";

// A tiny dir/cmd node index (id, type) keyed by path, matching resolveEntry's shape.
const index = new Map<string, Array<{ id: number; type: string }>>([
  ["/ip/address", [{ id: 1, type: "dir" }]],
  ["/ip/address/add", [{ id: 2, type: "cmd" }]],
  ["/caps-man/access-list", [{ id: 3, type: "dir" }]],
  ["/interface/bridge", [{ id: 4, type: "dir" }]],
  ["/tool/graphing/interface", [{ id: 5, type: "dir" }]],
  ["/tool/graphing/queue", [{ id: 6, type: "dir" }]],
]);

describe("resolveEntry", () => {
  test("exact match on a Directory", () => {
    expect(resolveEntry("ip/address", "Directory", index)).toEqual({ schemaNodeId: 1, matchKind: "exact", matchDetail: null });
  });

  test("exact match prefers the type matching the entry kind", () => {
    const poly = new Map([["/x", [{ id: 10, type: "dir" }, { id: 11, type: "cmd" }]]]);
    expect(resolveEntry("x", "Command", poly)?.schemaNodeId).toBe(11);
    expect(resolveEntry("x", "Directory", poly)?.schemaNodeId).toBe(10);
  });

  test("a path present only as the wrong type is not an exact match (no silent fallback)", () => {
    // Only a `dir` exists at /y, but the entry is a Command — must not link the dir.
    // With no alias candidate either, it stays manual-only.
    const only = new Map([["/y", [{ id: 30, type: "dir" }]]]);
    expect(resolveEntry("y", "Command", only)).toBeNull();
    // And an alias search must likewise skip a type-mismatched candidate.
    const aliasMismatch = new Map([["/a/c", [{ id: 31, type: "cmd" }]]]);
    expect(resolveEntry("a/b/c", "Directory", aliasMismatch)).toBeNull();
  });

  test("alias drops an internal module segment", () => {
    const r = resolveEntry("caps-man/acl/access-list", "Directory", index);
    expect(r).toEqual({ schemaNodeId: 3, matchKind: "alias", matchDetail: 'dropped segment "acl"' });
  });

  test("an undocumented droppable segment stays manual-only", () => {
    const unknown = new Map([["/a/c", [{ id: 40, type: "dir" }]]]);
    expect(resolveEntry("a/new-internal-name/c", "Directory", unknown)).toBeNull();
  });

  test("never drops the LAST segment (a genuinely-absent submenu is manual-only, not an alias of its parent)", () => {
    // interface/bridge/msrp would collapse onto /interface/bridge if the leaf were dropped.
    expect(resolveEntry("interface/bridge/msrp", "Directory", index)).toBeNull();
  });

  test("never drops the FIRST segment", () => {
    // dropping "ip" would spuriously match nothing here anyway, but the rule must hold.
    expect(resolveEntry("ip/address", "Directory", new Map([["/address", [{ id: 9, type: "dir" }]]]))).toBeNull();
  });

  test("ambiguous single-segment drop stays manual-only", () => {
    // a/b/c/d: dropping internal "b" -> /a/c/d, dropping internal "c" -> /a/b/d; both
    // resolve to distinct nodes, so the alias is ambiguous and the entry stays unlinked.
    const amb = resolveEntry("a/b/c/d", "Directory", new Map([
      ["/a/c/d", [{ id: 20, type: "dir" }]],
      ["/a/b/d", [{ id: 21, type: "dir" }]],
    ]));
    expect(amb).toBeNull();
  });

  test("no match at all is manual-only", () => {
    expect(resolveEntry("nonexistent/menu", "Directory", index)).toBeNull();
  });
});

// End-to-end: the db.ts view derives the right zero-to-many field links against a small
// real-shaped schema_nodes tree, using the shipped CREATE VIEW (not a hand-written query).
describe("cliref_field_inspect_links view", () => {
  function seed(): Database {
    const db = new Database(":memory:");
    db.run("PRAGMA foreign_keys=ON");
    // Minimal schema_nodes with a certificate dir + two commands + name args.
    db.run("CREATE TABLE schema_nodes (id INTEGER PRIMARY KEY, path TEXT, name TEXT, type TEXT, parent_path TEXT)");
    db.run("CREATE INDEX i1 ON schema_nodes(parent_path, name)");
    const sn = db.prepare("INSERT INTO schema_nodes (id,path,name,type,parent_path) VALUES (?,?,?,?,?)");
    sn.run(1, "/certificate", "certificate", "dir", "/");
    sn.run(2, "/certificate/add", "add", "cmd", "/certificate");
    sn.run(3, "/certificate/sign", "sign", "cmd", "/certificate");
    sn.run(4, "/certificate/add/name", "name", "arg", "/certificate/add");
    sn.run(5, "/certificate/sign/name", "name", "arg", "/certificate/sign");
    // Command-entry case: /ping with a direct arg child.
    sn.run(6, "/ping", "ping", "cmd", "/");
    sn.run(7, "/ping/address", "address", "arg", "/ping");

    db.run("CREATE TABLE cliref_entries (id INTEGER PRIMARY KEY, source_path TEXT)");
    db.run("CREATE TABLE cliref_fields (id INTEGER PRIMARY KEY, entry_id INTEGER, name TEXT, field_kind TEXT)");
    db.run("CREATE TABLE cliref_entry_schema_links (entry_id INTEGER PRIMARY KEY, schema_node_id INTEGER, match_kind TEXT)");
    db.run("INSERT INTO cliref_entries VALUES (1,'certificate'),(2,'ping')");
    db.run("INSERT INTO cliref_fields VALUES (1,1,'name','Argument'),(2,2,'address','Argument'),(3,1,'name','Read-only Argument')");
    db.run("INSERT INTO cliref_entry_schema_links VALUES (1,1,'exact'),(2,6,'exact')");
    db.run(CLIREF_FIELD_VIEW_SQL); // the shipped view — drift-proof, exercised as-is
    return db;
  }

  test("Directory entry field fans out to every child command's arg (many-to-one field)", () => {
    const db = seed();
    const rows = db.query("SELECT schema_node_id FROM cliref_field_inspect_links WHERE field_id=1 ORDER BY schema_node_id").all() as Array<{ schema_node_id: number }>;
    expect(rows.map((r) => r.schema_node_id)).toEqual([4, 5]); // certificate.name -> add/name, sign/name
  });

  test("Command entry field matches its direct arg child", () => {
    const db = seed();
    const rows = db.query("SELECT schema_node_id FROM cliref_field_inspect_links WHERE field_id=2").all() as Array<{ schema_node_id: number }>;
    expect(rows.map((r) => r.schema_node_id)).toEqual([7]); // ping.address -> /ping/address
  });

  test("Read-only Argument rows never imply a settable inspect-arg link", () => {
    const db = seed();
    const rows = db.query("SELECT schema_node_id FROM cliref_field_inspect_links WHERE field_id=3").all();
    expect(rows).toEqual([]);
  });
});
