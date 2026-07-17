#!/usr/bin/env bun

/**
 * db-doctor.ts — report whether the resolved ros-help.db can be trusted to
 * ground claims about this checkout (#94).
 *
 * Resolves the DB exactly as the MCP server would (DB_PATH / --db / auto-detect),
 * reads its db_meta provenance, and prints a grounding verdict. Exits non-zero
 * when the verdict is not "ok", so it doubles as a CI/pre-commit gate.
 *
 * Usage:
 *   bun run scripts/db-doctor.ts           # resolved DB (dev: repo-root ros-help.db)
 *   DB_PATH=/path/to/ros-help.db bun run scripts/db-doctor.ts
 *
 * Fix a stale/mismatched DB with `make db-sync` (fetches the latest CI release DB).
 */

import { classifyDbGrounding, detectMode, resolveDbPath, resolveVersion, SCHEMA_VERSION } from "../src/paths.ts";
import { probeDb } from "../src/setup.ts";

const dbPath = resolveDbPath(import.meta.dirname);
const mode = detectMode(import.meta.dirname);
const codeVersion = resolveVersion(import.meta.dirname);

console.log(`rosetta db-doctor`);
console.log(`  code        : v${codeVersion} (schema v${SCHEMA_VERSION}, mode ${mode})`);
console.log(`  resolved DB : ${dbPath}`);

const p = probeDb(dbPath);
if (!p) {
  console.log(`  status      : NO_DB — no readable SQLite database at the resolved path.`);
  console.log(`  fix         : run 'make db-sync' to fetch the latest CI release DB.`);
  process.exit(1);
}

const verdict = classifyDbGrounding({
  pragmaSchema: p.schemaVersion,
  metaSchema: p.metaSchemaVersion,
  releaseTag: p.releaseTag,
  builtAt: p.builtAt,
  sourceCommit: p.sourceCommit,
  codeSchema: SCHEMA_VERSION,
  codeVersion,
  mode,
});

console.log(`  release_tag : ${p.releaseTag ?? "(unstamped)"}`);
console.log(`  source_commit: ${p.sourceCommit ?? "(unstamped)"}`);
console.log(`  built_at    : ${p.builtAt ?? "(unstamped)"}`);
console.log(`  schema      : pragma=${p.schemaVersion} meta=${p.metaSchemaVersion ?? "—"} code=${SCHEMA_VERSION}`);
console.log(`  pages       : ${p.pages}   commands: ${p.commands}`);
console.log(`  status      : ${verdict.status.toUpperCase()}`);
console.log(`  detail      : ${verdict.detail}`);

if (!verdict.ok) {
  console.log(`  fix         : run 'make db-sync' to fetch the latest CI release DB for grounding.`);
  process.exit(1);
}
process.exit(0);
