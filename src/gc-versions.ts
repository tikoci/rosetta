#!/usr/bin/env bun

/**
 * gc-versions.ts — prune schema_node_presence to active RouterOS channel heads.
 *
 * The GC is intentionally narrow: it deletes only schema_node_presence rows.
 * command_versions, changelogs, schema_nodes, commands, and ros_versions keep
 * their full extracted history.
 */

import type { SQLQueryBindings } from "bun:sqlite";
import { Database } from "bun:sqlite";
import { resolveDbPath } from "./paths.ts";

export const ACTIVE_CHANNELS = ["stable", "long-term", "testing", "development"] as const;
export type ActiveChannel = (typeof ACTIVE_CHANNELS)[number];

export interface VersionChannelRow {
  version: string;
  channel: string | null;
}

export interface SchemaPresenceGcOptions {
  dryRun?: boolean;
}

export interface SchemaPresenceGcStats {
  before_count: number;
  after_count: number;
  deleted_rows: number;
  would_delete_rows: number;
  kept_versions: string[];
  pruned_versions: string[];
  channel_heads: Partial<Record<ActiveChannel, string>>;
  dry_run: boolean;
  skipped: boolean;
  note?: string;
}

interface ParsedVersion {
  valid: boolean;
  major: number;
  minor: number;
  patch: number;
  phase: number;
  phaseNumber: number;
}

function normalizeChannel(channel: string | null): ActiveChannel | null {
  if (!channel) return null;
  const normalized = channel.trim().toLowerCase();
  return ACTIVE_CHANNELS.includes(normalized as ActiveChannel) ? (normalized as ActiveChannel) : null;
}

function parseRouterOsVersion(version: string): ParsedVersion {
  const match = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:(beta|rc)(\d+))?$/);
  if (!match) {
    return { valid: false, major: 0, minor: 0, patch: 0, phase: -3, phaseNumber: 0 };
  }

  const phase = match[4] === "beta" ? -2 : match[4] === "rc" ? -1 : 0;
  return {
    valid: true,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    phase,
    phaseNumber: Number(match[5] ?? 0),
  };
}

/** Compare RouterOS versions semantically: 7.9 < 7.10 < 7.23beta2 < 7.23rc1 < 7.23. */
export function compareRouterOsVersions(a: string, b: string): number {
  const av = parseRouterOsVersion(a);
  const bv = parseRouterOsVersion(b);

  if (!av.valid || !bv.valid) {
    if (av.valid !== bv.valid) return av.valid ? 1 : -1;
    return a.localeCompare(b, undefined, { numeric: true });
  }

  for (const key of ["major", "minor", "patch", "phase", "phaseNumber"] as const) {
    const diff = av[key] - bv[key];
    if (diff !== 0) return diff;
  }

  return 0;
}

export function computeActiveChannelHeads(rows: VersionChannelRow[]): Partial<Record<ActiveChannel, string>> {
  const heads: Partial<Record<ActiveChannel, string>> = {};

  for (const row of rows) {
    const channel = normalizeChannel(row.channel);
    if (!channel) continue;

    const current = heads[channel];
    if (!current || compareRouterOsVersions(row.version, current) > 0) {
      heads[channel] = row.version;
    }
  }

  return heads;
}

function countRows(db: Database, sql: string, params: SQLQueryBindings[] = []): number {
  return (db.prepare(sql).get(...params) as { c: number }).c;
}

function distinctVersions(db: Database, sql: string): string[] {
  const rows = db.prepare(sql).all() as Array<{ version: string }>;
  return rows.map((row) => row.version).sort(compareRouterOsVersions);
}

function countPresenceVersions(db: Database, versions: string[]): number {
  if (versions.length === 0) return 0;
  const placeholders = versions.map(() => "?").join(", ");
  return countRows(db, `SELECT COUNT(*) AS c FROM schema_node_presence WHERE version IN (${placeholders})`, versions);
}

export function gcSchemaNodePresence(
  db: Database,
  options: SchemaPresenceGcOptions = {},
): SchemaPresenceGcStats {
  const dryRun = options.dryRun ?? false;
  const beforeCount = countRows(db, "SELECT COUNT(*) AS c FROM schema_node_presence");
  const versionRows = db.prepare("SELECT DISTINCT version, channel FROM ros_versions").all() as VersionChannelRow[];
  const channelHeads = computeActiveChannelHeads(versionRows);
  const keptVersions = Array.from(new Set(Object.values(channelHeads))).sort(compareRouterOsVersions);

  if (keptVersions.length === 0) {
    return {
      before_count: beforeCount,
      after_count: beforeCount,
      deleted_rows: 0,
      would_delete_rows: 0,
      kept_versions: [],
      pruned_versions: [],
      channel_heads: channelHeads,
      dry_run: dryRun,
      skipped: true,
      note: "No recognized ros_versions channel heads found; schema_node_presence GC skipped.",
    };
  }

  const keptSet = new Set(keptVersions);
  const presenceVersions = distinctVersions(db, "SELECT DISTINCT version FROM schema_node_presence");
  const prunedVersions = presenceVersions.filter((version) => !keptSet.has(version));
  const wouldDeleteRows = countPresenceVersions(db, prunedVersions);

  if (!dryRun && prunedVersions.length > 0) {
    const placeholders = prunedVersions.map(() => "?").join(", ");
    db.run(`DELETE FROM schema_node_presence WHERE version IN (${placeholders})`, prunedVersions);
  }

  const afterCount = countRows(db, "SELECT COUNT(*) AS c FROM schema_node_presence");
  const deletedRows = dryRun ? 0 : beforeCount - afterCount;

  return {
    before_count: beforeCount,
    after_count: afterCount,
    deleted_rows: deletedRows,
    would_delete_rows: wouldDeleteRows,
    kept_versions: keptVersions,
    pruned_versions: prunedVersions,
    channel_heads: channelHeads,
    dry_run: dryRun,
    skipped: false,
    note: dryRun ? "Dry run only; schema_node_presence was not modified." : undefined,
  };
}

function getArgValue(name: string): string | undefined {
  const eq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);

  const idx = process.argv.indexOf(name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : undefined;
}

function usage(): string {
  return [
    "Usage: bun run src/gc-versions.ts [--dry-run] [--verbose] [--db <path>]",
    "",
    "Prunes only schema_node_presence to active RouterOS channel heads.",
    "Conservative fallback: if no stable/long-term/testing/development heads exist, nothing is deleted.",
  ].join("\n");
}

function printStats(stats: SchemaPresenceGcStats, verbose: boolean): void {
  const action = stats.dry_run ? "would delete" : "deleted";
  console.log(
    `schema_node_presence GC: before=${stats.before_count} after=${stats.after_count} ${action}=${stats.dry_run ? stats.would_delete_rows : stats.deleted_rows}`,
  );
  console.log(`kept_versions=${stats.kept_versions.length ? stats.kept_versions.join(",") : "(none)"}`);

  if (stats.note) console.log(`note=${stats.note}`);

  if (verbose) {
    console.log(`pruned_versions=${stats.pruned_versions.length ? stats.pruned_versions.join(",") : "(none)"}`);
    console.log(`channel_heads=${JSON.stringify(stats.channel_heads)}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(usage());
    return;
  }

  const dryRun = process.argv.includes("--dry-run");
  const verbose = process.argv.includes("--verbose");
  const dbPath = getArgValue("--db") ?? resolveDbPath(import.meta.dirname);
  const db = new Database(dbPath);

  try {
    db.run("PRAGMA foreign_keys=ON;");
    const stats = gcSchemaNodePresence(db, { dryRun });
    printStats(stats, verbose);
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
