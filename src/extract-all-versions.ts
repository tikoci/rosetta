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
import {
  discoverRemoteVersions as discoverRemoteVersionList,
  fetchWithRetry,
  isHttpUrl,
  RESTRAML_PAGES_URL,
  type RetryOptions,
} from "./restraml.ts";

const SOURCE = process.argv[2];

export interface VersionInfo {
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

/**
 * HEAD-probe a restraml file. Only a 404 means "not published" — a 5xx that outlasts
 * the retries throws, rather than silently downgrading a version from deep-inspect to
 * legacy inspect.json the way the old `.catch(() => false)` did.
 */
export async function probeExists(url: string, retry: RetryOptions = {}): Promise<boolean> {
  const response = await fetchWithRetry(url, { method: "HEAD" }, retry);
  if (response.ok) return true;
  if (response.status === 404) return false;
  throw new Error(`HEAD ${url}: HTTP ${response.status}`);
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
    const [x86Ok, arm64Ok] = await Promise.all([probeExists(x86Url), probeExists(arm64Url)]);

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

/**
 * Run one child extraction per version. The primary rebuilds the main tables; every
 * other version only accumulates. Deep-inspect versions go through extract-schema.ts
 * (multi-arch, completion data), the rest through legacy extract-commands.ts. A failed
 * child doesn't stop the loop — the remaining versions still run so one log shows every
 * failure — but its version is returned for the caller to fail on.
 */
export function extractVersions(
  versions: VersionInfo[],
  primary: VersionInfo | undefined,
  run: (cmd: string[]) => number | null,
): string[] {
  const extractSchemaCmd = resolve(import.meta.dir, "extract-schema.ts");
  const extractCommandsCmd = resolve(import.meta.dir, "extract-commands.ts");
  const failed: string[] = [];

  for (const v of versions) {
    const isPrimary = v === primary;
    const flags = [
      `--version=${v.version}`,
      `--channel=${v.channel}`,
      ...(v.hasExtra ? ["--extra"] : []),
      ...(isPrimary ? [] : ["--accumulate"]),
    ];
    const role = isPrimary ? "PRIMARY" : "accumulate";

    console.log(`\n${"=".repeat(60)}`);

    let cmd: string[];
    if (v.hasDeepInspect) {
      console.log(`${role}: ${v.version} (${v.channel}) [deep-inspect]`);
      cmd = [
        "bun",
        "run",
        extractSchemaCmd,
        ...(v.deepX86 ? [`--x86=${v.deepX86}`] : []),
        ...(v.deepArm64 ? [`--arm64=${v.deepArm64}`] : []),
        ...flags,
      ];
    } else {
      console.log(`${role}: ${v.version} (${v.channel}) [legacy inspect.json]`);
      cmd = ["bun", "run", extractCommandsCmd, v.inspectPath, ...flags];
    }

    const exitCode = run(cmd);
    if (exitCode !== 0) {
      console.error(`FAILED: ${v.version} (exit ${exitCode})`);
      failed.push(v.version);
    }
  }
  return failed;
}

/** Expected versions with no command_versions rows, in expected order. */
export function missingVersions(expected: string[], present: string[]): string[] {
  const have = new Set(present);
  return expected.filter((v) => !have.has(v));
}

async function main() {
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

  const deepCount = versions.filter((v) => v.hasDeepInspect).length;
  const legacyCount = versions.length - deepCount;
  console.log(`Deep-inspect versions: ${deepCount}, legacy inspect.json: ${legacyCount}`);

  const failed = extractVersions(versions, latest, (cmd) =>
    Bun.spawnSync(cmd, { cwd: resolve(import.meta.dir, ".."), stdio: ["inherit", "inherit", "inherit"] }).exitCode,
  );

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Extracted ${versions.length - failed.length}/${versions.length} versions.`);
  console.log(`Primary version: ${latest?.version ?? "none"}`);

  // A partial corpus must never publish (#178): next.116 shipped without 7.15 after
  // one transient 503 failed its child extraction and this script still exited 0.
  if (failed.length > 0) {
    throw new Error(`${failed.length} version(s) failed to extract: ${failed.join(", ")}`);
  }

  // Imported here, not at module top, so tests can import this file without opening the DB.
  const { db, initDb, setDbMeta } = await import("./db.ts");
  initDb();
  const present = db
    .prepare("SELECT DISTINCT ros_version AS v FROM command_versions")
    .all()
    .map((r) => (r as { v: string }).v);
  const missing = missingVersions(versions.map((v) => v.version), present);
  if (missing.length > 0) {
    throw new Error(`Extraction exited 0 but command_versions has no rows for: ${missing.join(", ")}`);
  }
  // qa.yml's db-content gate compares the shipped DB's distinct command_versions
  // count against this, so a later step that drops a version also fails the release.
  setDbMeta("command_versions_expected", String(versions.length));
  console.log(`✓ command_versions covers all ${versions.length} versions`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
