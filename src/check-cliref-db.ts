#!/usr/bin/env bun

/**
 * check-cliref-db.ts — V-cliref-db-integrity. Structural + semantic invariants for the
 * CLI-Reference overlay on the FULL built DB (issue #127; overlay landed in #124).
 *
 * The per-fixture invariants live in the unit tests; this is the committed gate that runs
 * the same structural checks against the real corpus in CI (qa.yml, db_source=artifact).
 * Size-independent by design — it asserts shape, not counts. Row-count floors live in the
 * db-content gate; the exact/alias/manual-only crosswalk is pinned by link-cliref --check.
 *
 * Checks: PRAGMA integrity_check / foreign_key_check clean; no orphan cliref_* rows; enum /
 * CHECK values valid; (entry_id, source_order) & friends unique; and the field-view
 * semantic invariant — cliref_field_inspect_links contains ONLY settable Argument fields
 * mapped to `arg` schema nodes, and every Read-only Argument has zero view rows.
 *
 * Usage: bun run src/check-cliref-db.ts   # exits 1 on any violation
 */

import { db } from "./db.ts";

const problems: string[] = [];

/** A COUNT(*) that must be zero; otherwise it's a violation. */
function expectZero(label: string, sql: string): void {
  const n = (db.query(sql).get() as { n: number }).n;
  if (n !== 0) problems.push(`${label}: ${n} offending row(s)`);
}

db.run("PRAGMA foreign_keys=ON;");

// The overlay must actually be present — a build that skipped extract-cliref would leave
// the tables at their db.ts-init empty state and pass every "no bad rows" check vacuously.
const entryCount = (db.query("SELECT COUNT(*) AS n FROM cliref_entries").get() as { n: number }).n;
if (entryCount === 0) {
  console.error("V-cliref-db-integrity FAILED: cliref_entries is empty — did extract-cliref run?");
  process.exit(1);
}

// ── Whole-DB structural integrity ──
const integrity = (db.query("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
if (integrity !== "ok") problems.push(`PRAGMA integrity_check returned ${JSON.stringify(integrity)}`);
const fkViolations = db.query("PRAGMA foreign_key_check").all() as unknown[];
if (fkViolations.length > 0) problems.push(`PRAGMA foreign_key_check found ${fkViolations.length} violation(s)`);

// ── Orphans (explicit — belt-and-suspenders beyond the FK declarations) ──
expectZero("orphan cliref_entries.page_id", "SELECT COUNT(*) AS n FROM cliref_entries e WHERE NOT EXISTS (SELECT 1 FROM cliref_pages p WHERE p.id = e.page_id)");
expectZero("orphan cliref_entries.source_parent_id", "SELECT COUNT(*) AS n FROM cliref_entries e WHERE e.source_parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM cliref_entries p WHERE p.id = e.source_parent_id)");
expectZero("orphan cliref_fields.entry_id", "SELECT COUNT(*) AS n FROM cliref_fields f WHERE NOT EXISTS (SELECT 1 FROM cliref_entries e WHERE e.id = f.entry_id)");
expectZero("orphan cliref_flags.entry_id", "SELECT COUNT(*) AS n FROM cliref_flags f WHERE NOT EXISTS (SELECT 1 FROM cliref_entries e WHERE e.id = f.entry_id)");
expectZero("orphan cliref_entry_schema_links.entry_id", "SELECT COUNT(*) AS n FROM cliref_entry_schema_links l WHERE NOT EXISTS (SELECT 1 FROM cliref_entries e WHERE e.id = l.entry_id)");
expectZero("orphan cliref_entry_schema_links.schema_node_id", "SELECT COUNT(*) AS n FROM cliref_entry_schema_links l WHERE NOT EXISTS (SELECT 1 FROM schema_nodes sn WHERE sn.id = l.schema_node_id)");

// ── Enum / CHECK domains (re-asserted independent of the schema CHECKs) ──
expectZero("invalid cliref_entries.source_type", "SELECT COUNT(*) AS n FROM cliref_entries WHERE source_type NOT IN ('Directory', 'Settings Directory', 'Command')");
expectZero("invalid cliref_entries.heading_level", "SELECT COUNT(*) AS n FROM cliref_entries WHERE heading_level NOT BETWEEN 1 AND 6");
expectZero("invalid cliref_fields.field_kind", "SELECT COUNT(*) AS n FROM cliref_fields WHERE field_kind NOT IN ('Argument', 'Read-only Argument')");
expectZero("invalid cliref_fields.mandatory/unsettable", "SELECT COUNT(*) AS n FROM cliref_fields WHERE mandatory NOT IN (0, 1) OR unsettable NOT IN (0, 1)");
expectZero("invalid cliref_entry_schema_links.match_kind", "SELECT COUNT(*) AS n FROM cliref_entry_schema_links WHERE match_kind NOT IN ('exact', 'alias')");
expectZero(
  "inconsistent cliref_entry_schema_links.match_detail",
  "SELECT COUNT(*) AS n FROM cliref_entry_schema_links WHERE (match_kind = 'exact' AND match_detail IS NOT NULL) OR (match_kind = 'alias' AND match_detail IS NULL)",
);

// ── Occurrence-identity uniqueness (source order within each parent) ──
expectZero("duplicate cliref_pages.source_order", "SELECT COUNT(*) AS n FROM (SELECT source_order FROM cliref_pages GROUP BY source_order HAVING COUNT(*) > 1)");
expectZero("duplicate cliref_entries (page_id, source_order)", "SELECT COUNT(*) AS n FROM (SELECT 1 FROM cliref_entries GROUP BY page_id, source_order HAVING COUNT(*) > 1)");
expectZero("duplicate cliref_fields (entry_id, source_order)", "SELECT COUNT(*) AS n FROM (SELECT 1 FROM cliref_fields GROUP BY entry_id, source_order HAVING COUNT(*) > 1)");
expectZero("duplicate cliref_flags (entry_id, source_order)", "SELECT COUNT(*) AS n FROM (SELECT 1 FROM cliref_flags GROUP BY entry_id, source_order HAVING COUNT(*) > 1)");

// ── Field-view semantic invariant (not just an export filter) ──
// The view is the field→inspect-input crosswalk: it must expose ONLY settable Argument
// fields mapped to `arg` schema nodes. A Read-only Argument sharing an input's name is not
// proof of an output-field identity, so it must never gain a view row.
expectZero(
  "view row on a non-settable field",
  "SELECT COUNT(*) AS n FROM cliref_field_inspect_links v JOIN cliref_fields f ON f.id = v.field_id WHERE f.field_kind <> 'Argument'",
);
expectZero(
  "view row pointing at a non-arg schema node",
  "SELECT COUNT(*) AS n FROM cliref_field_inspect_links v JOIN schema_nodes sn ON sn.id = v.schema_node_id WHERE sn.type <> 'arg'",
);

if (problems.length > 0) {
  console.error(`V-cliref-db-integrity FAILED (${problems.length}):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log(`✓ V-cliref-db-integrity OK — ${entryCount} entries: integrity/FK clean, no orphans, enums valid, occurrence identity unique, field view settable-only.`);
