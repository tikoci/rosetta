/**
 * extract-changelogs.ts — Fetch and parse MikroTik changelogs into the changelogs table.
 *
 * Idempotent: deletes all existing changelog rows, then fetches and inserts.
 * FTS5 index auto-populated via triggers defined in db.ts.
 *
 * Usage:
 *   bun run src/extract-changelogs.ts                     # fetch for all ros_versions
 *   bun run src/extract-changelogs.ts --versions=7.21,7.22,7.22.1  # explicit versions
 *   bun run src/extract-changelogs.ts --probe-patches     # discover patch releases
 */

import { db, initDb } from "./db.ts";

const CHANGELOG_BASE = "https://download.mikrotik.com/routeros";
const FETCH_DELAY_MS = 200; // polite delay between requests

// ── Types ──

type ChangelogEntry = {
  version: string;
  released: string | null;
  category: string;
  is_breaking: number;
  description: string;
  sort_order: number;
};

// ── Parser ──

const HEADER_RE = /^What's new in (\S+) \(([^)]+)\):/i;
const ENTRY_RE = /^([*!])\)/;

/** Parse changelog text into structured entries. */
export function parseChangelog(text: string, expectedVersion?: string): ChangelogEntry[] {
  const lines = text.split("\n");
  const entries: ChangelogEntry[] = [];

  let version: string | null = null;
  let released: string | null = null;
  let currentCategory: string | null = null;
  let currentDesc = "";
  let currentBreaking = 0;
  let sortOrder = 0;

  function flush() {
    if (version && currentCategory !== null && currentDesc) {
      entries.push({
        version,
        released,
        category: currentCategory,
        is_breaking: currentBreaking,
        description: currentDesc.trim(),
        sort_order: sortOrder++,
      });
    }
    currentCategory = null;
    currentDesc = "";
    currentBreaking = 0;
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    // Check for header
    const headerMatch = line.match(HEADER_RE);
    if (headerMatch) {
      flush();
      version = headerMatch[1];
      released = headerMatch[2];
      sortOrder = 0;
      continue;
    }

    // Check for entry start: *) or !)
    const entryMatch = line.match(ENTRY_RE);
    if (entryMatch) {
      flush();
      currentBreaking = entryMatch[1] === "!" ? 1 : 0;

      // Rest of line after "*) " or "!) "
      const rest = line.slice(2).trim();

      // Extract category: text before first " - " within first 40 chars
      const dashIdx = rest.indexOf(" - ");
      if (dashIdx > 0 && dashIdx <= 40) {
        currentCategory = rest.slice(0, dashIdx).trim().toLowerCase();
        currentDesc = rest.slice(dashIdx + 3);
      } else {
        // No clear category separator — use "other"
        currentCategory = "other";
        currentDesc = rest;
      }
      continue;
    }

    // Continuation line — append to current entry
    if (currentCategory !== null && line.trim()) {
      currentDesc += ` ${line.trim()}`;
    }
  }

  // Flush last entry
  flush();

  // If expectedVersion was given but header didn't match, override
  // (some changelogs have slightly different header formats)
  if (expectedVersion && entries.length > 0 && !entries.some((e) => e.version === expectedVersion)) {
    for (const entry of entries) {
      entry.version = expectedVersion;
    }
  }

  return entries;
}

// ── Fetch ──

async function fetchChangelog(version: string): Promise<string | null> {
  const url = `${CHANGELOG_BASE}/${encodeURIComponent(version)}/CHANGELOG`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      if (resp.status === 404) return null;
      console.warn(`  ${version}: HTTP ${resp.status}`);
      return null;
    }
    return await resp.text();
  } catch (err) {
    console.warn(`  ${version}: fetch error — ${err}`);
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Version discovery ──

function getKnownVersions(): string[] {
  const rows = db
    .prepare("SELECT version FROM ros_versions ORDER BY version")
    .all() as Array<{ version: string }>;
  return rows.map((r) => r.version);
}

/** Probe patch versions: for each minor (7.X), try 7.X.1, 7.X.2, ... up to first 404. */
async function probePatchVersions(): Promise<string[]> {
  const known = new Set(getKnownVersions());
  const patches: string[] = [];

  // Find all minor versions: extract unique 7.X prefixes
  const minors = new Set<string>();
  for (const v of known) {
    const match = v.match(/^(\d+\.\d+)/);
    if (match) minors.add(match[1]);
  }

  for (const minor of [...minors].sort()) {
    // Probe .1, .2, .3, ... up to 20 (generous ceiling)
    for (let p = 1; p <= 20; p++) {
      const patchVersion = `${minor}.${p}`;
      if (known.has(patchVersion)) {
        patches.push(patchVersion);
        continue;
      }
      // Probe by fetching
      const text = await fetchChangelog(patchVersion);
      if (text) {
        patches.push(patchVersion);
        console.log(`  Discovered patch: ${patchVersion}`);
      } else {
        break; // No more patches for this minor
      }
      await sleep(FETCH_DELAY_MS);
    }
  }

  return patches;
}

// ── Main ──

if (import.meta.main) {

initDb();

// Parse CLI args
const args = process.argv.slice(2);
const versionsArg = args.find((a) => a.startsWith("--versions="));
const probePatches = args.includes("--probe-patches");

let versions: string[];

if (versionsArg) {
  versions = versionsArg.slice("--versions=".length).split(",").map((v) => v.trim()).filter(Boolean);
  console.log(`Changelog extraction: ${versions.length} explicit versions`);
} else if (probePatches) {
  console.log("Changelog extraction: probing patch versions...");
  const known = getKnownVersions();
  const patches = await probePatchVersions();
  // Merge: known + discovered patches (deduplicated)
  const all = new Set([...known, ...patches]);
  versions = [...all];
  console.log(`  ${versions.length} versions (${patches.length} from patch probing)`);
} else {
  versions = getKnownVersions();
  console.log(`Changelog extraction: ${versions.length} versions from ros_versions`);
}

if (versions.length === 0) {
  console.error("No versions to process. Run extract-commands first, or use --versions=");
  process.exit(1);
}

// Idempotent: clear existing data (FTS triggers handle cleanup)
db.run("DELETE FROM changelogs");

const insert = db.prepare(`INSERT OR IGNORE INTO changelogs
  (version, released, category, is_breaking, description, sort_order)
  VALUES (?, ?, ?, ?, ?, ?)`);

const upsertVersion = db.prepare(`INSERT OR IGNORE INTO ros_versions
  (version, channel, extracted_at)
  VALUES (?, ?, datetime('now'))`);

let totalEntries = 0;
let versionsProcessed = 0;
let versionsFailed = 0;

for (const version of versions) {
  const text = await fetchChangelog(version);
  if (!text) {
    versionsFailed++;
    continue;
  }

  const entries = parseChangelog(text, version);
  if (entries.length === 0) {
    console.warn(`  ${version}: no entries parsed`);
    versionsFailed++;
    continue;
  }

  // Ensure version exists in ros_versions
  const channel = version.includes("beta") || version.includes("rc") ? "development" : "stable";
  upsertVersion.run(version, channel);

  // Batch insert in a transaction
  const insertBatch = db.transaction(() => {
    for (const e of entries) {
      insert.run(e.version, e.released, e.category, e.is_breaking, e.description, e.sort_order);
    }
  });
  insertBatch();

  totalEntries += entries.length;
  versionsProcessed++;
  console.log(`  ${version}: ${entries.length} entries${entries.some((e) => e.is_breaking) ? ` (${entries.filter((e) => e.is_breaking).length} breaking)` : ""}`);

  await sleep(FETCH_DELAY_MS);
}

console.log(`\nChangelogs: ${totalEntries} entries from ${versionsProcessed} versions (${versionsFailed} failed/skipped)`);

} // end if (import.meta.main)
