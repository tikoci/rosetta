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

// All non-draft releases (prerelease OR stable) that carry the DB asset, newest
// first (the releases API returns newest-first by created_at). We hand the WHOLE
// ordered list to downloadDb: it validates each candidate's schema against this
// build and walks down to the newest release that actually MATCHES — so an older
// checkout still resolves a compatible DB even after a newer, higher-schema
// release exists above it. Selecting only the newest tag would fail there.
const jq = `[.[] | select(.draft | not) | select([.assets[].name] | index("${ASSET}")) | .tag_name]`;

let tags: string[] = [];
try {
  const out = (await $`gh api ${`repos/${REPO}/releases?per_page=50`} --jq ${jq}`.text()).trim();
  tags = JSON.parse(out) as string[];
} catch (e) {
  console.error("✗ Could not query GitHub releases via gh.");
  console.error(`  ${e instanceof Error ? e.message : e}`);
  console.error("  Install/authenticate the gh CLI, or fetch a release DB manually (MANUAL.md).");
  process.exit(1);
}

if (tags.length === 0) {
  console.error(`✗ No release ships ${ASSET} yet — nothing to sync.`);
  process.exit(1);
}

const urls = tags.map((tag) => `https://github.com/${REPO}/releases/download/${tag}/${ASSET}`);
console.log(`Releases with ${ASSET} (newest first): ${tags.join(", ")}`);
console.log(`Target schema: v${SCHEMA_VERSION}   Target DB path: ${dbPath}`);

try {
  const probe = await downloadDb(dbPath, console.log, urls);
  console.log(`✓ Synced: schema v${probe.schemaVersion}, ${probe.pages} pages, release ${probe.releaseTag ?? "unknown"}.`);
  process.exit(0);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`✗ Sync failed: ${msg}`);
  if (msg.includes("schema=")) {
    console.error(
      `  None of the ${tags.length} candidate release(s) ship a DB matching this checkout's schema (v${SCHEMA_VERSION}).\n` +
        `  This checkout is likely ahead of any published release DB. Use 'make extract' for a local\n` +
        `  (unstamped) working DB until a matching release is published.`,
    );
  }
  process.exit(1);
}
