#!/usr/bin/env bun
/**
 * extract-commands.ts — Load RouterOS command tree from inspect.json into SQLite.
 *
 * Walks the nested JSON tree and flattens it into a `commands` table with:
 *   path, name, type (dir|cmd|arg), parent_path, description
 *
 * Also populates command_versions for version tracking.
 *
 * Usage:
 *   bun run src/extract-commands.ts [inspect.json-path-or-url] [--version=7.22] [--channel=stable] [--extra]
 *   bun run src/extract-commands.ts --accumulate [inspect.json-path] [--version=X]
 *
 * In default mode: replaces commands table and sets as primary version.
 * With --accumulate: only adds to command_versions, does not touch commands table.
 */

import { db, initDb } from "./db.ts";
import { loadJson, RESTRAML_PAGES_URL } from "./restraml.ts";

// Parse flags
const cliArgs = process.argv.slice(2);
const accumulate = cliArgs.includes("--accumulate");
const extraPackages = cliArgs.includes("--extra");
const positional = cliArgs.filter((a) => !a.startsWith("--"));
const flagArgs = Object.fromEntries(
  cliArgs.filter((a) => a.startsWith("--") && a.includes("=")).map((a) => {
    const [k, ...v] = a.slice(2).split("=");
    return [k, v.join("=")];
  }),
);

const DEFAULT_INSPECT_URL = `${RESTRAML_PAGES_URL}/7.22.1/extra/inspect.json`;
const INSPECT_SOURCE = positional[0] || DEFAULT_INSPECT_URL;

// Derive version from path if not explicitly set
function deriveVersion(filepath: string): string {
  const match = filepath.match(/\/(\d+\.\d+(?:\.\d+)?(?:beta\d+|rc\d+)?)\//);
  return match?.[1] ?? "unknown";
}

function deriveChannel(version: string): string {
  if (version.includes("beta") || version.includes("rc")) return "development";
  const parts = version.split(".");
  if (parts.length === 3) return "stable";
  return "stable";
}

const version = flagArgs.version || deriveVersion(INSPECT_SOURCE);
const channel = flagArgs.channel || deriveChannel(version);

console.log(`Loading inspect.json from ${INSPECT_SOURCE}...`);
console.log(`Version: ${version}, Channel: ${channel}, Extra: ${extraPackages}, Accumulate: ${accumulate}`);
const inspectData = await loadJson<Record<string, unknown>>(INSPECT_SOURCE);

interface CommandRow {
  path: string;
  name: string;
  type: string;
  parentPath: string | null;
  description: string | null;
}

const rows: CommandRow[] = [];

function walk(obj: Record<string, unknown>, parentPath: string) {
  for (const [key, value] of Object.entries(obj)) {
    if (key === "_type" || key === "desc") continue;
    if (typeof value !== "object" || value === null) continue;

    const node = value as Record<string, unknown>;
    const nodeType = node._type as string | undefined;
    if (!nodeType) continue;

    const currentPath = parentPath ? `${parentPath}/${key}` : `/${key}`;
    const desc = typeof node.desc === "string" ? node.desc : null;

    // Normalize "path" type to "dir" — inspect.json uses both
    const normalizedType = nodeType === "path" ? "dir" : nodeType;

    rows.push({
      path: currentPath,
      name: key,
      type: normalizedType,
      parentPath: parentPath || null,
      description: desc,
    });

    // Recurse into children (dirs, paths, and cmds have children)
    if (normalizedType === "dir" || normalizedType === "cmd") {
      walk(node, currentPath);
    }
  }
}

walk(inspectData, "");

console.log(`Parsed ${rows.length} command tree entries`);
const dirs = rows.filter((r) => r.type === "dir").length;
const cmds = rows.filter((r) => r.type === "cmd").length;
const args = rows.filter((r) => r.type === "arg").length;
console.log(`  dirs: ${dirs}, cmds: ${cmds}, args: ${args}`);

// Initialize DB and insert
initDb();

// Register this version
db.run(
  `INSERT OR REPLACE INTO ros_versions (version, channel, extra_packages, extracted_at)
   VALUES (?, ?, ?, datetime('now'))`,
  [version, channel, extraPackages ? 1 : 0],
);

if (!accumulate) {
  // Primary mode: replace commands table entirely, set ros_version
  db.run("DELETE FROM commands;");

  const insert = db.prepare(`
    INSERT OR IGNORE INTO commands (path, name, type, parent_path, description, ros_version)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const insertCommands = db.transaction(() => {
    for (const r of rows) {
      insert.run(r.path, r.name, r.type, r.parentPath, r.description, version);
    }
  });
  insertCommands();

  const total = (db.prepare("SELECT COUNT(*) as c FROM commands").get() as { c: number }).c;
  console.log(`\nInserted ${total} commands into database (primary: ${version})`);
}

// Always populate command_versions for this version
db.run("DELETE FROM command_versions WHERE ros_version = ?", [version]);

const insertVersion = db.prepare(`
  INSERT OR IGNORE INTO command_versions (command_path, ros_version)
  VALUES (?, ?)
`);

const insertVersions = db.transaction(() => {
  for (const r of rows) {
    insertVersion.run(r.path, version);
  }
});
insertVersions();

const versionCount = (
  db.prepare("SELECT COUNT(*) as c FROM command_versions WHERE ros_version = ?").get(version) as { c: number }
).c;
console.log(`Recorded ${versionCount} command_versions entries for ${version}`);

const totalVersions = (db.prepare("SELECT COUNT(DISTINCT ros_version) as c FROM command_versions").get() as { c: number }).c;
console.log(`Total versions tracked: ${totalVersions}`);

if (!accumulate) {
  // Sample: show the /ip/firewall subtree
  console.log("\nSample: /ip/firewall children:");
  const children = db
    .prepare("SELECT path, type FROM commands WHERE parent_path = '/ip/firewall' ORDER BY path")
    .all() as Array<{ path: string; type: string }>;
  for (const c of children) {
    console.log(`  ${c.type.padEnd(4)} ${c.path}`);
  }

  // Show top-level dirs
  console.log("\nTop-level directories:");
  const topLevel = db
    .prepare("SELECT path FROM commands WHERE parent_path = '' AND type = 'dir' ORDER BY path")
    .all() as Array<{ path: string }>;
  for (const t of topLevel) {
    console.log(`  ${t.path}`);
  }
}
