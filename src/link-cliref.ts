#!/usr/bin/env bun

/**
 * link-cliref.ts — Resolve each CLI-Reference entry to its inspect coordinate and
 * populate cliref_entry_schema_links. Issue #124.
 *
 * Runs AFTER both extract-schema.ts (schema_nodes) and extract-cliref.ts (cliref_*).
 * Only the *entry* crosswalk is stored — it carries the non-derivable exact/alias
 * decision. Field→arg links are the cliref_field_inspect_links view, never stored.
 *
 * Resolution, per entry source_path (e.g. "caps-man/acl/access-list"):
 *   1. exact  — /<source_path> is a dir/cmd node in schema_nodes.
 *   2. alias  — dropping exactly one internal source segment yields exactly one
 *               dir/cmd node (the manual leaks internal module names into headings,
 *               e.g. caps-man/acl/access-list → /caps-man/access-list). Ambiguous
 *               (≥2 candidates) stays manual-only — never guess.
 *   3. manual-only — no link row; a first-class entry inspect cannot self-report.
 *
 * Usage:
 *   bun run src/link-cliref.ts            # link against the current DB
 *   bun run src/link-cliref.ts --report   # print exact/alias/manual-only breakdown
 */

import { db, initDb } from "./db.ts";

const REPORT = process.argv.includes("--report");

interface SchemaNode {
  id: number;
  type: string;
}

/** dir/cmd nodes keyed by path (a path may exist as more than one type). */
function loadNodeIndex(): Map<string, SchemaNode[]> {
  const rows = db
    .query("SELECT id, path, type FROM schema_nodes WHERE type IN ('dir', 'cmd')")
    .all() as Array<{ id: number; path: string; type: string }>;
  const index = new Map<string, SchemaNode[]>();
  for (const r of rows) {
    const list = index.get(r.path);
    if (list) list.push({ id: r.id, type: r.type });
    else index.set(r.path, [{ id: r.id, type: r.type }]);
  }
  return index;
}

/** Inspect type an entry of this source_type should prefer when a path is polymorphic. */
function preferredType(sourceType: string): string {
  return sourceType === "Command" ? "cmd" : "dir"; // Directory / Settings Directory → dir
}

function pickNode(nodes: SchemaNode[], sourceType: string): SchemaNode {
  const want = preferredType(sourceType);
  return nodes.find((n) => n.type === want) ?? nodes[0];
}

export interface EntryLink {
  schemaNodeId: number;
  matchKind: "exact" | "alias";
  matchDetail: string | null;
}

export function resolveEntry(
  sourcePath: string,
  sourceType: string,
  index: Map<string, SchemaNode[]>,
): EntryLink | null {
  const exact = index.get(`/${sourcePath}`);
  if (exact) {
    return { schemaNodeId: pickNode(exact, sourceType).id, matchKind: "exact", matchDetail: null };
  }

  // Alias: drop one *internal* segment at a time; collect distinct matching nodes.
  // Only internal segments (never the first/root-menu or last/leaf name) are the
  // spurious module names the manual leaks — dropping the last segment would collapse a
  // genuinely-absent submenu (e.g. interface/bridge/msrp) onto its parent, a false
  // alias; dropping the first would rename the root menu.
  const segments = sourcePath.split("/");
  const candidates = new Map<number, { node: SchemaNode; dropped: string }>();
  for (let i = 1; i < segments.length - 1; i++) {
    const dropped = segments[i];
    const candidatePath = `/${segments.slice(0, i).concat(segments.slice(i + 1)).join("/")}`;
    const nodes = index.get(candidatePath);
    if (nodes) {
      const node = pickNode(nodes, sourceType);
      candidates.set(node.id, { node, dropped });
    }
  }
  if (candidates.size === 1) {
    const { node, dropped } = [...candidates.values()][0];
    return { schemaNodeId: node.id, matchKind: "alias", matchDetail: `dropped segment "${dropped}"` };
  }
  return null; // no match, or ambiguous → manual-only
}

export function linkEntries(): { exact: number; alias: number; manual: number } {
  const index = loadNodeIndex();
  const entries = db
    .query("SELECT id, source_path, source_type FROM cliref_entries")
    .all() as Array<{ id: number; source_path: string; source_type: string }>;

  const insLink = db.prepare(
    "INSERT INTO cliref_entry_schema_links (entry_id, schema_node_id, match_kind, match_detail) VALUES (?, ?, ?, ?)",
  );
  let exact = 0;
  let alias = 0;
  let manual = 0;
  db.transaction(() => {
    db.run("DELETE FROM cliref_entry_schema_links;");
    for (const e of entries) {
      const link = resolveEntry(e.source_path, e.source_type, index);
      if (link === null) {
        manual++;
        continue;
      }
      insLink.run(e.id, link.schemaNodeId, link.matchKind, link.matchDetail);
      if (link.matchKind === "exact") exact++;
      else alias++;
    }
  })();
  return { exact, alias, manual };
}

if (import.meta.main) {
  initDb();
  const { exact, alias, manual } = linkEntries();
  console.log(`Linked cliref entries: ${exact} exact, ${alias} alias, ${manual} manual-only`);
  if (REPORT) {
    const rows = db
      .query(
        `SELECT e.source_path, l.match_kind, l.match_detail
         FROM cliref_entries e JOIN cliref_entry_schema_links l ON l.entry_id = e.id
         WHERE l.match_kind = 'alias' ORDER BY e.source_path`,
      )
      .all() as Array<{ source_path: string; match_kind: string; match_detail: string }>;
    console.log(`\nAlias resolutions (${rows.length}):`);
    for (const r of rows) console.log(`  ${r.source_path}  (${r.match_detail})`);
  }
}
