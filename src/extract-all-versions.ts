#!/usr/bin/env bun
/**
 * extract-all-versions.ts — Extract command trees from all RouterOS versions.
 *
 * Discovers RouterOS versions from restraml and extracts each version's
 * command tree into schema_nodes/command_versions.
 *
 * Prefers deep-inspect.{x86,arm64}.json (multi-arch, completion data) when
 * available; falls back to inspect.json (legacy) for older versions.
 *
 * The latest stable version is loaded as the primary (rebuilds schema_nodes
 * and commands tables). All other versions only add to the junction tables.
 *
 * Usage:
 *   bun run src/extract-all-versions.ts [restraml-base-url-or-local-docs-dir]
 */

import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { discoverRemoteVersions as discoverRemoteVersionList, isHttpUrl, RESTRAML_PAGES_URL } from "./restraml.ts";

const SOURCE = process.argv[2];

interface VersionInfo {
  version: string;
  channel: "stable" | "development";
  /** deep-inspect.x86.json path/URL (null if not available) */
  deepX86: string | null;
  /** deep-inspect.arm64.json path/URL (null if not available) */
  deepArm64: string | null;
  /** Legacy inspect.json path/URL (fallback when no deep-inspect) */
  inspectPath: string;
  hasExtra: boolean;
  /** true when at least one deep-inspect file is available */
  hasDeepInspect: boolean;
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

async function discoverRemoteVersions(): Promise<VersionInfo[]> {
  const versionNames = await discoverRemoteVersionList();
  const baseUrl = RESTRAML_PAGES_URL;

  // For each version, check if deep-inspect files exist (HEAD probe).
  // Deep-inspect files are at: <baseUrl>/<version>/extra/deep-inspect.{x86,arm64}.json
  // Fall back to: <baseUrl>/<version>/extra/inspect.json
  const results: VersionInfo[] = [];

  for (const name of versionNames.filter((n) => /^\d+\.\d+/.test(n))) {
    const x86Url = `${baseUrl}/${name}/extra/deep-inspect.x86.json`;
    const arm64Url = `${baseUrl}/${name}/extra/deep-inspect.arm64.json`;
    const inspectUrl = `${baseUrl}/${name}/extra/inspect.json`;

    // Probe deep-inspect availability via HEAD request (fast, no body)
    const [x86Ok, arm64Ok] = await Promise.all([
      fetch(x86Url, { method: "HEAD" }).then((r) => r.ok).catch(() => false),
      fetch(arm64Url, { method: "HEAD" }).then((r) => r.ok).catch(() => false),
    ]);

    const hasDeepInspect = x86Ok || arm64Ok;

    results.push({
      version: name,
      channel: classifyChannel(name),
      deepX86: x86Ok ? x86Url : null,
      deepArm64: arm64Ok ? arm64Url : null,
      inspectPath: inspectUrl,
      hasExtra: true,
      hasDeepInspect,
    });
  }

  return results.sort((a, b) => compareVersions(a.version, b.version));
}

function discoverLocalVersions(docsDir: string): VersionInfo[] {
  const entries = readdirSync(docsDir).filter((name) => /^\d+\.\d+/.test(name));
  return entries
    .map((name) => {
      const dir = resolve(docsDir, name);
      const deepX86Path = resolve(dir, "extra/deep-inspect.x86.json");
      const deepArm64Path = resolve(dir, "extra/deep-inspect.arm64.json");
      const extraPath = resolve(dir, "extra/inspect.json");
      const basePath = resolve(dir, "inspect.json");
      const hasExtra = existsSync(extraPath);
      const inspectPath = hasExtra ? extraPath : basePath;
      const deepX86 = existsSync(deepX86Path) ? deepX86Path : null;
      const deepArm64 = existsSync(deepArm64Path) ? deepArm64Path : null;
      const hasDeepInspect = deepX86 !== null || deepArm64 !== null;

      if (!existsSync(inspectPath) && !hasDeepInspect) return null;

      return {
        version: name,
        channel: classifyChannel(name),
        deepX86,
        deepArm64,
        inspectPath,
        hasExtra,
        hasDeepInspect,
      };
    })
    .filter((v): v is VersionInfo => v !== null)
    .sort((a, b) => compareVersions(a.version, b.version));
}

const localMode = SOURCE && !isHttpUrl(SOURCE);

const versions = localMode
  ? discoverLocalVersions(resolve(SOURCE))
  : await discoverRemoteVersions();

console.log(
  `Found ${versions.length} RouterOS versions${localMode ? ` in ${resolve(SOURCE)}` : " from restraml GitHub"}`,
);

if (versions.length === 0) {
  throw new Error(`No inspect.json files found${localMode ? ` in ${resolve(SOURCE)}` : " from restraml GitHub"}`);
}

// Determine the latest stable version for primary extraction
const latestStable = [...versions].filter((v) => v.channel === "stable").pop();
const latest = latestStable || versions[versions.length - 1];
console.log(`Latest stable: ${latest?.version ?? "none"}`);

// Run extraction for each version
// For versions with deep-inspect: use extract-schema.ts (multi-arch, completion data)
// For versions without: fall back to extract-commands.ts (legacy)
// Primary version (latest stable) rebuilds the main tables; others accumulate only.

const extractSchemaCmd = resolve(import.meta.dir, "extract-schema.ts");
const extractCommandsCmd = resolve(import.meta.dir, "extract-commands.ts");

const deepCount = versions.filter((v) => v.hasDeepInspect).length;
const legacyCount = versions.length - deepCount;
console.log(`Deep-inspect versions: ${deepCount}, legacy inspect.json: ${legacyCount}`);

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

  let proc: ReturnType<typeof Bun.spawnSync>;

  if (v.hasDeepInspect) {
    // Use extract-schema.ts with both arch files
    const schemaFlags = [
      ...(v.deepX86 ? [`--x86=${v.deepX86}`] : []),
      ...(v.deepArm64 ? [`--arm64=${v.deepArm64}`] : []),
      ...flags,
    ];
    console.log(`${isPrimary ? "PRIMARY" : "accumulate"}: ${v.version} (${v.channel}) [deep-inspect]`);

    proc = Bun.spawnSync(["bun", "run", extractSchemaCmd, ...schemaFlags], {
      cwd: resolve(import.meta.dir, ".."),
      stdio: ["inherit", "inherit", "inherit"],
    });
  } else {
    // Legacy fallback: use extract-commands.ts
    console.log(`${isPrimary ? "PRIMARY" : "accumulate"}: ${v.version} (${v.channel}) [legacy inspect.json]`);

    proc = Bun.spawnSync(["bun", "run", extractCommandsCmd, v.inspectPath, ...flags], {
      cwd: resolve(import.meta.dir, ".."),
      stdio: ["inherit", "inherit", "inherit"],
    });
  }

  if (proc.exitCode !== 0) {
    console.error(`FAILED: ${v.version} (exit ${proc.exitCode})`);
    continue;
  }
  extracted++;
}

console.log(`\n${"=".repeat(60)}`);
console.log(`Done. Extracted ${extracted}/${versions.length} versions.`);
console.log(`Primary version: ${latest?.version ?? "none"}`);
