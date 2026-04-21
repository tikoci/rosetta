#!/usr/bin/env bun

/**
 * stamp-db-meta.ts — write release provenance into ros-help.db's db_meta table.
 *
 * Called from .github/workflows/release.yml after extraction, before building
 * release artifacts. Lets the running rosetta show "DB v0.7.3 from 2026-04-19"
 * at startup and powers the freshness-check path in mcp.ts.
 *
 * Usage:
 *   bun run scripts/stamp-db-meta.ts \
 *     --release-tag v0.7.3 \
 *     --source-commit abc123 \
 *     [--db ros-help.db]
 *
 * Idempotent — running twice with the same args produces the same DB.
 */

import sqlite from "bun:sqlite";
import { existsSync } from "node:fs";

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

const releaseTag = getArg("--release-tag");
const sourceCommit = getArg("--source-commit") ?? "";
const dbPath = getArg("--db") ?? "ros-help.db";

if (!releaseTag) {
  console.error("Usage: stamp-db-meta.ts --release-tag <tag> [--source-commit <sha>] [--db <path>]");
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const db = new sqlite(dbPath);
db.run("PRAGMA foreign_keys=ON;");
db.run(`CREATE TABLE IF NOT EXISTS db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

const builtAt = new Date().toISOString();
const schemaVersion = String(
  (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
);

const upsert = db.prepare(
  "INSERT INTO db_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value;",
);
upsert.run("release_tag", releaseTag);
upsert.run("built_at", builtAt);
upsert.run("source_commit", sourceCommit);
upsert.run("schema_version", schemaVersion);

console.log(`✓ Stamped db_meta in ${dbPath}:`);
console.log(`    release_tag    = ${releaseTag}`);
console.log(`    built_at       = ${builtAt}`);
console.log(`    source_commit  = ${sourceCommit || "(none)"}`);
console.log(`    schema_version = ${schemaVersion}`);

db.close();
