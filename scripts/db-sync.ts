#!/usr/bin/env bun

/**
 * db-sync.ts — install the newest CI-built release DB that matches this checkout,
 * into the resolved DB path (#94).
 *
 * Why not `--refresh`? refreshDb() pins its download URL to package.json's
 * version, which in a checkout is a CI-rewritten placeholder (e.g. v0.11.0-rc.0)
 * with no matching release, then falls back to /releases/latest — the newest
 * *stable*, which lags the prerelease line and ships an older schema. This script
 * instead asks GitHub for the newest release (prereleases included) that actually
 * ships ros-help.db.gz, and installs that via the hardened downloadDb() path
 * (lock + schema/content validation + stale-sidecar cleanup + atomic swap), so it
 * is safe to run while an MCP server holds the old file open.
 *
 * Requires `gh` (already used across this repo). Public repo — no auth needed to
 * read releases, but `gh` handles auth transparently if present.
 *
 * Usage:
 *   bun run scripts/db-sync.ts        # → resolved DB path (dev: repo root)
 *   DB_PATH=/path bun run scripts/db-sync.ts
 */

import { $ } from "bun";
import { resolveDbPath, SCHEMA_VERSION } from "../src/paths.ts";
import { downloadDb } from "../src/setup.ts";

const REPO = "tikoci/rosetta";
const ASSET = "ros-help.db.gz";
const dbPath = resolveDbPath(import.meta.dirname);

// Newest non-draft release (prerelease OR stable) that carries the DB asset.
// The releases API returns newest-first by created_at, so first() wins.
const jq = `first(.[] | select(.draft | not) | select([.assets[].name] | index("${ASSET}")) | .tag_name)`;

let tag = "";
try {
  tag = (await $`gh api ${`repos/${REPO}/releases?per_page=50`} --jq ${jq}`.text()).trim();
} catch (e) {
  console.error("✗ Could not query GitHub releases via gh.");
  console.error(`  ${e instanceof Error ? e.message : e}`);
  console.error("  Install/authenticate the gh CLI, or fetch a release DB manually (MANUAL.md).");
  process.exit(1);
}

if (!tag) {
  console.error(`✗ No release ships ${ASSET} yet — nothing to sync.`);
  process.exit(1);
}

const url = `https://github.com/${REPO}/releases/download/${tag}/${ASSET}`;
console.log(`Newest release with ${ASSET}: ${tag}`);
console.log(`Target DB path: ${dbPath}`);

try {
  const probe = await downloadDb(dbPath, console.log, [url]);
  console.log(`✓ Synced: schema v${probe.schemaVersion}, ${probe.pages} pages, release ${probe.releaseTag ?? tag}.`);
  process.exit(0);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`✗ Sync failed: ${msg}`);
  if (msg.includes("schema=")) {
    console.error(
      `  The newest release (${tag}) ships a different schema than this checkout (expected v${SCHEMA_VERSION}).\n` +
        `  This checkout is likely ahead of any published release DB. Use 'make extract' for a local\n` +
        `  (unstamped) working DB until a matching release is published.`,
    );
  }
  process.exit(1);
}
