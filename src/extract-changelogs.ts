/**
 * extract-changelogs.ts — Fetch and parse MikroTik changelogs into the changelogs table.
 *
 * Idempotent: on a passing verdict, atomically replaces all changelog rows.
 * A failing verdict exits 1 with the table untouched. FTS5 index
 * auto-populated via triggers defined in db.ts.
 *
 * Usage:
 *   bun run src/extract-changelogs.ts                     # fetch for all ros_versions
 *   bun run src/extract-changelogs.ts --versions=7.21,7.22,7.22.1  # explicit versions
 *   bun run src/extract-changelogs.ts --probe-patches     # discover patch releases
 */

import { db, initDb } from "./db.ts";
import { fetchTextWithRetry, type RetryOptions } from "./restraml.ts";

const CHANGELOG_BASE = "https://download.mikrotik.com/routeros";
const FETCH_DELAY_MS = 200; // polite delay between requests

// Same shared 5xx/429/network retry as extract-test-results (#218): a changelog
// is a few KB, so 30s without a byte is already a sick host.
const FETCH_RETRY: RetryOptions = { timeoutMs: 30_000 };

// Fail-loud thresholds, same shape as extract-test-results (#218). A healthy
// run has 0 hard errors and ~2% genuine 404s (2/98 in next.123: 7.11.3,
// 7.12.2). Before these, a host outage turned every version into a skip, the
// table was wiped and committed empty, and the run exited 0.
export const MAX_HARD_ERROR_RATE = 0.10;
export const MAX_MISSING_RATE = 0.15;

// Consecutive hard errors that mean the host is down rather than flaky: stop
// fetching instead of spending 4 attempts × 30s on each of ~100 versions.
export const MAX_CONSECUTIVE_HARD_ERRORS = 5;
const VERSION_CHANNELS = ["stable", "long-term", "testing", "development"] as const;

// Oldest RouterOS v7 versions that use the current changelog header/entry format.
// Keep these in default extraction even though command tree retention starts later.
export const LEGACY_FORMATTED_V7_BASE_VERSIONS = ["7.1.1", "7.2", "7.3", "7.4", "7.5", "7.6", "7.7", "7.8"];

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

/** `missing` is a genuine 404 (no changelog for that version); `error` is a
 *  transport failure or non-404 status that survived retries. */
export type ChangelogFetchResult =
  | { status: "ok"; text: string }
  | { status: "missing" }
  | { status: "error"; detail: string };

export async function fetchChangelog(version: string, retry: RetryOptions = {}): Promise<ChangelogFetchResult> {
  const url = `${CHANGELOG_BASE}/${encodeURIComponent(version)}/CHANGELOG`;
  try {
    const resp = await fetchTextWithRetry(url, {}, { ...FETCH_RETRY, ...retry });
    if (resp.ok) return { status: "ok", text: resp.text };
    if (resp.status === 404) return { status: "missing" };
    return { status: "error", detail: `HTTP ${resp.status}` };
  } catch (err) {
    return { status: "error", detail: `fetch failed: ${(err as Error).message}` };
  }
}

/** End-of-run counts for the fail-loud verdict. */
export interface ChangelogOutcome {
  /** Versions the run was asked to fetch. */
  versionCount: number;
  totalEntries: number;
  hardErrors: number;
  /** 404s plus fetched changelogs that parsed to 0 entries. */
  missing: number;
  /** The run stopped early on MAX_CONSECUTIVE_HARD_ERRORS. */
  abandoned: boolean;
}

/** Returns an error message when the run must fail, null when it may proceed. */
export function evaluateChangelogOutcome(o: ChangelogOutcome): string | null {
  if (o.abandoned) {
    return `extract-changelogs: ${MAX_CONSECUTIVE_HARD_ERRORS} consecutive versions failed ` +
      `with transport/HTTP errors — download.mikrotik.com may be blocking or down; ` +
      `refusing to ship partial changelogs`;
  }
  if (o.totalEntries === 0) {
    return `extract-changelogs: 0 changelog entries for ${o.versionCount} versions ` +
      `(${o.hardErrors} unreachable, ${o.missing} missing or unparsed) — ` +
      `refusing to ship an empty changelogs table`;
  }
  if (o.versionCount > 0 && o.hardErrors / o.versionCount > MAX_HARD_ERROR_RATE) {
    return `extract-changelogs: ${o.hardErrors}/${o.versionCount} versions failed with ` +
      `transport/HTTP errors (over the ${MAX_HARD_ERROR_RATE * 100}% threshold) — ` +
      `refusing to ship partial changelogs`;
  }
  if (o.versionCount > 0 && o.missing / o.versionCount > MAX_MISSING_RATE) {
    return `extract-changelogs: ${o.missing}/${o.versionCount} versions 404'd or parsed ` +
      `to 0 entries (over the ${MAX_MISSING_RATE * 100}% threshold) — the URL scheme or ` +
      `changelog format may have changed; refusing to ship partial changelogs`;
  }
  return null;
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

export function buildChangelogVersionSet(knownVersions: string[], channelHeadVersions: string[] = []): string[] {
  const all = new Set([...knownVersions, ...channelHeadVersions, ...LEGACY_FORMATTED_V7_BASE_VERSIONS]);
  return [...all];
}

/** NEWESTa7.<channel> answers "<version> <unix build time>" (e.g. "7.25 1792678320");
 *  the whole line as a version 404'd, so 7.25 stable never got its changelog. */
export function parseChannelHead(body: string): string {
  return body.trim().split(/\s+/)[0] ?? "";
}

async function fetchCurrentChannelVersions(): Promise<string[]> {
  const versions = new Set<string>();
  for (const channel of VERSION_CHANNELS) {
    try {
      const resp = await fetch(`https://upgrade.mikrotik.com/routeros/NEWESTa7.${channel}`);
      if (!resp.ok) {
        console.warn(`  channel ${channel}: HTTP ${resp.status}`);
        continue;
      }
      const version = parseChannelHead(await resp.text());
      if (version) {
        versions.add(version);
      }
    } catch (err) {
      console.warn(`  channel ${channel}: fetch error — ${err}`);
    }
  }
  return [...versions];
}

async function getDefaultVersions(): Promise<string[]> {
  const channelHeads = await fetchCurrentChannelVersions();
  return buildChangelogVersionSet(getKnownVersions(), channelHeads);
}

/** Probe patch versions: for each minor (7.X), try 7.X.1, 7.X.2, ... up to first 404. */
async function probePatchVersions(): Promise<string[]> {
  const known = new Set(await getDefaultVersions());
  const patches: string[] = [];

  // Find all minor versions: extract unique 7.X prefixes
  const minors = new Set<string>();
  for (const v of known) {
    const match = v.match(/^(\d+\.\d+)/);
    if (match) minors.add(match[1]);
  }

  for (const minor of [...minors].sort()) {
    // Probe .1 through .20 per minor — up to ~920 requests total at 200ms each (~3 min)
    for (let p = 1; p <= 20; p++) {
      const patchVersion = `${minor}.${p}`;
      if (known.has(patchVersion)) {
        patches.push(patchVersion);
        continue;
      }
      // Probe by fetching; anything but a changelog ends this minor's probe
      const result = await fetchChangelog(patchVersion);
      if (result.status === "error") console.warn(`  ${patchVersion}: ${result.detail} — stopping probe for ${minor}`);
      if (result.status === "ok") {
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
  const known = await getDefaultVersions();
  const patches = await probePatchVersions();
  // Merge: known + discovered patches (deduplicated)
  const all = new Set([...known, ...patches]);
  versions = [...all];
  console.log(`  ${versions.length} versions (${patches.length} from patch probing)`);
} else {
  versions = await getDefaultVersions();
  console.log(`Changelog extraction: ${versions.length} versions from ros_versions + channel heads + legacy v7 baseline`);
}

if (versions.length === 0) {
  console.error("No versions to process. Run extract-commands first, or use --versions=");
  process.exit(1);
}

// Fetch all changelogs into memory first, then delete+insert in one transaction.
// This avoids leaving the table partially populated if a network failure occurs mid-run.
const fetched: Array<{ version: string; entries: ChangelogEntry[] }> = [];
let hardErrors = 0;
let missing = 0;
let consecutiveHardErrors = 0;
let abandoned = false;

for (const version of versions) {
  const result = await fetchChangelog(version);
  if (result.status === "error") {
    console.warn(`  ${version}: ${result.detail}`);
    hardErrors++;
    if (++consecutiveHardErrors >= MAX_CONSECUTIVE_HARD_ERRORS) {
      abandoned = true;
      break;
    }
    continue;
  }
  consecutiveHardErrors = 0;
  if (result.status === "missing") {
    console.warn(`  ${version}: 404`);
    missing++;
    continue;
  }

  const entries = parseChangelog(result.text, version);
  if (entries.length === 0) {
    console.warn(`  ${version}: no entries parsed`);
    missing++;
    continue;
  }

  fetched.push({ version, entries });
  console.log(`  ${version}: ${entries.length} entries${entries.some((e) => e.is_breaking) ? ` (${entries.filter((e) => e.is_breaking).length} breaking)` : ""}`);

  await sleep(FETCH_DELAY_MS);
}

const totalEntries = fetched.reduce((sum, f) => sum + f.entries.length, 0);
const verdict = evaluateChangelogOutcome({
  versionCount: versions.length,
  totalEntries,
  hardErrors,
  missing,
  abandoned,
});
if (verdict) {
  console.error(verdict);
  process.exit(1);
}

// Atomic: delete all + insert all in one transaction
const insert = db.prepare(`INSERT OR IGNORE INTO changelogs
  (version, released, category, is_breaking, description, sort_order)
  VALUES (?, ?, ?, ?, ?, ?)`);

const upsertVersion = db.prepare(`INSERT OR IGNORE INTO ros_versions
  (version, channel, extracted_at)
  VALUES (?, ?, datetime('now'))`);

const commitAll = db.transaction(() => {
  db.run("DELETE FROM changelogs");
  for (const { version, entries } of fetched) {
    const channel = version.includes("beta") || version.includes("rc") ? "development" : "stable";
    upsertVersion.run(version, channel);
    for (const e of entries) {
      insert.run(e.version, e.released, e.category, e.is_breaking, e.description, e.sort_order);
    }
  }
});
commitAll();

console.log(`\nChangelogs: ${totalEntries} entries from ${fetched.length} versions (${missing} missing/unparsed, ${hardErrors} errors)`);

} // end if (import.meta.main)
