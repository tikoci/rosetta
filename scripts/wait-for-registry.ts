#!/usr/bin/env bun
/**
 * wait-for-registry.ts — block until an exact package version is servable
 * through the abbreviated install manifest Bun consumes (#202).
 *
 * Exact-version fresh-install path ONLY: `release-smoke.yml`'s bunx-smoke
 * runs this before its pinned `bunx @tikoci/rosetta@<version>`. It must not
 * be pointed at the bare/tag upgrade path — a warm bare `bunx` serves the
 * cache with zero registry requests, so no metadata probe can gate it.
 *
 * Usage:
 *   bun scripts/wait-for-registry.ts <package> <version> [--registry URL] [--timeout-s N] [--interval-s N]
 *
 * Defaults: registry https://registry.npmjs.org/, timeout 900s, interval 5s
 * (the pre-#202 `npm view` loop's budget, preserved unless evidence moves it).
 */
import { DEFAULT_REGISTRY, waitForExactVersion } from "../src/registry-readiness.ts";

function usage(): string {
  return "Usage: bun scripts/wait-for-registry.ts <package> <version> [--registry URL] [--timeout-s N] [--interval-s N]";
}

const argv = process.argv.slice(2);
const positional: string[] = [];
let registry = DEFAULT_REGISTRY;
let timeoutS = 900;
let intervalS = 5;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--registry" || arg === "--timeout-s" || arg === "--interval-s") {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      console.error(`✗ ${arg} needs a value.\n${usage()}`);
      process.exit(1);
    }
    i += 1;
    if (arg === "--registry") {
      registry = value;
    } else if (arg === "--timeout-s") {
      timeoutS = Number(value);
    } else {
      intervalS = Number(value);
    }
  } else if (arg === "--help" || arg === "-h") {
    console.log(usage());
    process.exit(0);
  } else if (arg.startsWith("--")) {
    console.error(`✗ Unknown flag ${arg}.\n${usage()}`);
    process.exit(1);
  } else {
    positional.push(arg);
  }
}

const [pkg, rawVersion] = positional;
if (!pkg || !rawVersion) {
  console.error(`✗ Missing <package> and/or <version>.\n${usage()}`);
  process.exit(1);
}
if (!Number.isFinite(timeoutS) || timeoutS <= 0 || !Number.isFinite(intervalS) || intervalS <= 0) {
  console.error("✗ --timeout-s and --interval-s must be positive numbers.");
  process.exit(1);
}

// Strip a leading v — npm versions are unprefixed (same convention as release-smoke.yml).
const version = rawVersion.replace(/^v/, "");
console.log(`Waiting for ${pkg}@${version} in the abbreviated install manifest at ${registry} ...`);

const outcome = await waitForExactVersion({
  name: pkg,
  version,
  registry,
  timeoutMs: timeoutS * 1000,
  intervalMs: intervalS * 1000,
  onAttempt: (attempt, ok, detail) => {
    if (!ok) console.error(`  [attempt ${attempt}] not ready: ${detail}`);
  },
}).catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});

if (outcome.ready) {
  console.log(`✓ ${pkg}@${version} servable (attempt ${outcome.attempts}, ${(outcome.elapsedMs / 1000).toFixed(1)}s): ${outcome.tarball}`);
  process.exit(0);
}
console.error(
  `::error::registry at ${registry} did not serve ${pkg}@${version} through the abbreviated install manifest within ${timeoutS}s (${outcome.attempts} attempts). Last failure: ${outcome.lastFailure}`,
);
process.exit(1);
