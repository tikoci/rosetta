#!/usr/bin/env bun
/**
 * extract-all-versions.ts — Extract command trees from all RouterOS versions.
 *
 * Iterates all version directories in the restraml docs dir, extracts their
 * inspect.json (preferring extra/ variant), and populates command_versions.
 *
 * The latest stable version is loaded as the primary commands table.
 *
 * Usage:
 *   bun run src/extract-all-versions.ts [restraml-docs-dir]
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const DOCS_DIR = process.argv[2] || resolve(process.env.HOME || "~", "restraml/docs");

// Discover version directories (match 7.x patterns)
const entries = readdirSync(DOCS_DIR).filter((name) => /^\d+\.\d+/.test(name));

interface VersionInfo {
  version: string;
  channel: "stable" | "development";
  inspectPath: string;
  hasExtra: boolean;
}

function classifyChannel(version: string): "stable" | "development" {
  if (version.includes("beta") || version.includes("rc")) return "development";
  return "stable";
}

function parseVersionKey(version: string): number[] {
  // "7.22beta1" → [7, 22, 0, -2, 1] (beta=-2, rc=-1, release=0)
  const match = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?(?:(beta|rc)(\d+))?$/);
  if (!match) return [0];
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3] ?? 0);
  const preType = match[4] === "beta" ? -2 : match[4] === "rc" ? -1 : 0;
  const preNum = Number(match[5] ?? 0);
  return [major, minor, patch, preType, preNum];
}

function compareVersions(a: string, b: string): number {
  const ka = parseVersionKey(a);
  const kb = parseVersionKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const diff = (ka[i] ?? 0) - (kb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const versions: VersionInfo[] = entries
  .map((name) => {
    const dir = resolve(DOCS_DIR, name);
    const extraPath = resolve(dir, "extra/inspect.json");
    const basePath = resolve(dir, "inspect.json");
    const hasExtra = existsSync(extraPath);
    const inspectPath = hasExtra ? extraPath : basePath;

    if (!existsSync(inspectPath)) return null;

    return {
      version: name,
      channel: classifyChannel(name),
      inspectPath,
      hasExtra,
    };
  })
  .filter((v): v is VersionInfo => v !== null)
  .sort((a, b) => compareVersions(a.version, b.version));

console.log(`Found ${versions.length} RouterOS versions in ${DOCS_DIR}`);

// Determine the latest stable version for primary extraction
const latestStable = [...versions].filter((v) => v.channel === "stable").pop();
const latest = latestStable || versions[versions.length - 1];
console.log(`Latest stable: ${latest?.version ?? "none"}`);

// Run extraction for each version
// First pass: accumulate all non-primary versions
// Second pass: primary version (replaces commands table)

const extractCmd = resolve(import.meta.dir, "extract-commands.ts");

let extracted = 0;
for (const v of versions) {
  const isPrimary = v === latest;
  const flags = [
    `--version=${v.version}`,
    `--channel=${v.channel}`,
    ...(v.hasExtra ? ["--extra"] : []),
    ...(isPrimary ? [] : ["--accumulate"]),
  ];

  console.log(`\n${"=".repeat(60)}`);
  console.log(`${isPrimary ? "PRIMARY" : "accumulate"}: ${v.version} (${v.channel})`);

  const proc = Bun.spawnSync(["bun", "run", extractCmd, v.inspectPath, ...flags], {
    cwd: resolve(import.meta.dir, ".."),
    stdio: ["inherit", "inherit", "inherit"],
  });

  if (proc.exitCode !== 0) {
    console.error(`FAILED: ${v.version} (exit ${proc.exitCode})`);
    continue;
  }
  extracted++;
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Done. Extracted ${extracted}/${versions.length} versions.`);
console.log(`Primary version: ${latest?.version ?? "none"}`);
