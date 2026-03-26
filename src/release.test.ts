/**
 * release.test.ts — Release readiness tests.
 *
 * Validates that project files are consistent and release artifacts
 * will be built correctly. No network, no database — just file reads
 * and structural checks.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

function readText(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), "utf-8");
}

// ---------------------------------------------------------------------------
// package.json health
// ---------------------------------------------------------------------------

describe("package.json", () => {
  const pkg = JSON.parse(readText("package.json"));

  test("version is valid semver", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test("name is rosetta", () => {
    expect(pkg.name).toBe("rosetta");
  });

  test("repository URL contains tikoci/rosetta", () => {
    expect(pkg.repository.url).toContain("tikoci/rosetta");
  });

  test("no duplicate scripts that Makefile owns", () => {
    const makefileOwned = ["start", "extract", "assess", "search"];
    for (const name of makefileOwned) {
      expect(pkg.scripts[name]).toBeUndefined();
    }
  });

  test("required scripts exist", () => {
    expect(pkg.scripts.test).toBeDefined();
    expect(pkg.scripts.typecheck).toBeDefined();
    expect(pkg.scripts.lint).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Build constants declarations
// ---------------------------------------------------------------------------

describe("build-time constants", () => {
  test("mcp.ts declares VERSION", () => {
    const src = readText("src/mcp.ts");
    expect(src).toContain("declare const VERSION");
  });

  test("mcp.ts declares IS_COMPILED", () => {
    const src = readText("src/mcp.ts");
    expect(src).toContain("declare const IS_COMPILED");
  });

  test("db.ts declares IS_COMPILED", () => {
    const src = readText("src/db.ts");
    expect(src).toContain("declare const IS_COMPILED");
  });

  test("setup.ts declares REPO_URL and VERSION", () => {
    const src = readText("src/setup.ts");
    expect(src).toContain("declare const REPO_URL");
    expect(src).toContain("declare const VERSION");
  });

  test("build script injects all three constants", () => {
    const src = readText("scripts/build-release.ts");
    expect(src).toContain("VERSION=");
    expect(src).toContain("REPO_URL=");
    expect(src).toContain("IS_COMPILED=");
  });
});

// ---------------------------------------------------------------------------
// Build script structure
// ---------------------------------------------------------------------------

describe("build-release.ts", () => {
  test("script exists", () => {
    expect(existsSync(path.join(ROOT, "scripts/build-release.ts"))).toBe(true);
  });

  test("defines all 4 platform targets", () => {
    const src = readText("scripts/build-release.ts");
    expect(src).toContain("macos-arm64");
    expect(src).toContain("macos-x64");
    expect(src).toContain("windows-x64");
    expect(src).toContain("linux-x64");
  });

  test("uses bun build --compile", () => {
    const src = readText("scripts/build-release.ts");
    expect(src).toContain("--compile");
  });

  test("compresses database", () => {
    const src = readText("scripts/build-release.ts");
    expect(src).toContain("ros-help.db.gz");
  });
});

// ---------------------------------------------------------------------------
// setup.ts URL consistency
// ---------------------------------------------------------------------------

describe("setup.ts", () => {
  test("REPO_URL fallback matches package.json repository", () => {
    const src = readText("src/setup.ts");
    const pkg = JSON.parse(readText("package.json"));

    // Extract the fallback repo string: `? REPO_URL : "tikoci/rosetta"`
    const match = src.match(/REPO_URL\s*:\s*"([^"]+)"/);
    expect(match).not.toBeNull();

    const fallbackRepo = match?.[1];
    expect(pkg.repository.url).toContain(fallbackRepo);
  });

  test("downloads from GitHub Releases URL", () => {
    const src = readText("src/setup.ts");
    expect(src).toContain("github.com/");
    expect(src).toContain("/releases/latest/download/ros-help.db.gz");
  });
});

// ---------------------------------------------------------------------------
// Makefile has release targets
// ---------------------------------------------------------------------------

describe("Makefile", () => {
  const makefile = readText("Makefile");

  test("has preflight target", () => {
    expect(makefile).toContain("preflight:");
  });

  test("has build-release target", () => {
    expect(makefile).toContain("build-release:");
  });

  test("has release target", () => {
    expect(makefile).toContain("release:");
  });

  test("release depends on preflight", () => {
    expect(makefile).toMatch(/^release:.*preflight/m);
  });

  test("release depends on build-release", () => {
    expect(makefile).toMatch(/^release:.*build-release/m);
  });

  test("preflight checks dirty tree", () => {
    expect(makefile).toContain("git diff --quiet");
  });

  test("FORCE flag controls tag behavior", () => {
    expect(makefile).toContain("FORCE");
    expect(makefile).toContain("git tag -f");
    expect(makefile).toContain("--clobber");
  });
});

// ---------------------------------------------------------------------------
// CLI flags in mcp.ts
// ---------------------------------------------------------------------------

describe("CLI flags", () => {
  const src = readText("src/mcp.ts");

  test("supports --version flag", () => {
    expect(src).toContain("--version");
  });

  test("supports --help flag", () => {
    expect(src).toContain("--help");
  });

  test("supports --setup flag", () => {
    expect(src).toContain("--setup");
  });
});
