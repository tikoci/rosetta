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

  test("name is @tikoci/rosetta", () => {
    expect(pkg.name).toBe("@tikoci/rosetta");
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

  test("bin points to JS shim", () => {
    expect(pkg.bin.rosetta).toBe("bin/rosetta.js");
  });

  test("files includes bin/, src/, matrix/", () => {
    expect(pkg.files).toContain("bin/");
    expect(pkg.files).toContain("src/");
    expect(pkg.files).toContain("matrix/");
  });
});

// ---------------------------------------------------------------------------
// npm bin shim
// ---------------------------------------------------------------------------

describe("bin/rosetta.js", () => {
  test("shim exists", () => {
    expect(existsSync(path.join(ROOT, "bin/rosetta.js"))).toBe(true);
  });

  test("has node shebang", () => {
    const src = readText("bin/rosetta.js");
    expect(src.startsWith("#!/usr/bin/env node")).toBe(true);
  });

  test("detects Bun runtime", () => {
    const src = readText("bin/rosetta.js");
    expect(src).toContain('typeof Bun !== "undefined"');
  });

  test("falls back to spawning bun for Node", () => {
    const src = readText("bin/rosetta.js");
    expect(src).toContain('spawn("bun"');
  });
});

// ---------------------------------------------------------------------------
// Build constants declarations
// ---------------------------------------------------------------------------

describe("build-time constants", () => {
  test("mcp.ts imports resolveVersion from paths.ts", () => {
    const src = readText("src/mcp.ts");
    expect(src).toContain("resolveVersion");
  });

  test("mcp.ts does not have hardcoded version fallback", () => {
    const src = readText("src/mcp.ts");
    expect(src).not.toContain('"0.2.0"');
    expect(src).not.toContain("\"dev\"");
  });

  test("paths.ts declares IS_COMPILED and VERSION", () => {
    const src = readText("src/paths.ts");
    expect(src).toContain("declare const IS_COMPILED");
    expect(src).toContain("declare const VERSION");
  });

  test("setup.ts declares REPO_URL and imports resolveVersion", () => {
    const src = readText("src/setup.ts");
    expect(src).toContain("declare const REPO_URL");
    expect(src).toContain("resolveVersion");
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

  test("has extract-videos target", () => {
    expect(makefile).toContain("extract-videos:");
  });

  test("extract-videos is in PHONY", () => {
    // PHONY uses line continuation; check block before first blank line after .PHONY
    const phonyStart = makefile.indexOf(".PHONY:");
    const phonyEnd = makefile.indexOf("\n\n", phonyStart);
    const phonyBlock = makefile.slice(phonyStart, phonyEnd);
    expect(phonyBlock).toContain("extract-videos");
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
// CI release workflow
// ---------------------------------------------------------------------------

describe("release.yml", () => {
  test("workflow file exists", () => {
    expect(existsSync(path.join(ROOT, ".github/workflows/release.yml"))).toBe(
      true,
    );
  });

  test("has required inputs", () => {
    const src = readText(".github/workflows/release.yml");
    expect(src).toContain("html_url:");
    expect(src).toContain("version:");
  });

  test("tolerates Confluence zip with absolute path root entry", () => {
    const src = readText(".github/workflows/release.yml");
    // Confluence exports include a bare "/" entry → unzip exits 2
    expect(src).toMatch(/unzip.*\|\|.*\$\?.*-eq.*2/);
  });

  test("runs extraction pipeline", () => {
    const src = readText(".github/workflows/release.yml");
    expect(src).toContain("extract-html.ts");
    expect(src).toContain("extract-properties.ts");
    expect(src).toContain("extract-commands.ts");
    expect(src).toContain("extract-devices.ts");
    expect(src).toContain("extract-test-results.ts");
    expect(src).toContain("extract-changelogs.ts");
    expect(src).toContain("link-commands.ts");
  });

  test("runs quality gate before release", () => {
    const src = readText(".github/workflows/release.yml");
    expect(src).toContain("bun run typecheck");
    expect(src).toContain("bun test");
    expect(src).toContain("bun run lint");
  });

  test("creates GitHub Release", () => {
    const src = readText(".github/workflows/release.yml");
    expect(src).toContain("gh release create");
  });

  test("publishes to npm", () => {
    const src = readText(".github/workflows/release.yml");
    expect(src).toContain("npm publish");
    expect(src).toContain("NPM_TOKEN");
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

// ---------------------------------------------------------------------------
// HTTP transport structural checks — catch per-session breakage at build time
// ---------------------------------------------------------------------------

describe("HTTP transport structure", () => {
  const src = readText("src/mcp.ts");

  test("uses per-session transport routing (not single shared transport)", () => {
    // The single-transport pattern was: `await server.connect(httpTransport)` at module level
    // followed by `httpTransport.handleRequest(req)`. The per-session pattern has a
    // transports Map and creates transport/server per session.
    expect(src).toContain("new Map");
    expect(src).toContain("transports.set");
    expect(src).toContain("transports.get");
  });

  test("creates new McpServer per session, not one shared instance", () => {
    // createServer() factory must exist and be called per-session
    expect(src).toContain("function createServer()");
    expect(src).toContain("createServer()");
  });

  test("checks isInitializeRequest before creating transport", () => {
    expect(src).toContain("isInitializeRequest");
  });

  test("registers onsessioninitialized callback", () => {
    expect(src).toContain("onsessioninitialized");
  });

  test("cleans up transport on close", () => {
    expect(src).toContain("transport.onclose");
    expect(src).toContain("transports.delete");
  });

  test("passes parsedBody to handleRequest after consuming body", () => {
    // Once we req.json() for isInitializeRequest check, the body is consumed.
    // Must pass parsedBody so the transport doesn't try to re-parse.
    expect(src).toContain("parsedBody");
  });

  test("handles missing session ID on non-initialize requests", () => {
    expect(src).toContain("No valid session ID provided");
  });

  test("handles invalid session ID with 404", () => {
    expect(src).toContain("Session not found");
  });
});

// ---------------------------------------------------------------------------
// Container / entrypoint checks
// ---------------------------------------------------------------------------

describe("container entrypoint", () => {
  test("entrypoint script exists", () => {
    expect(existsSync(path.join(ROOT, "scripts/container-entrypoint.sh"))).toBe(true);
  });

  test("defaults to --http mode", () => {
    const src = readText("scripts/container-entrypoint.sh");
    expect(src).toContain("--http");
  });

  test("defaults to 0.0.0.0 host binding", () => {
    const src = readText("scripts/container-entrypoint.sh");
    expect(src).toContain("0.0.0.0");
  });

  test("supports TLS via env vars", () => {
    const src = readText("scripts/container-entrypoint.sh");
    expect(src).toContain("TLS_CERT_PATH");
    expect(src).toContain("TLS_KEY_PATH");
  });
});

// ---------------------------------------------------------------------------
// Dockerfile structure
// ---------------------------------------------------------------------------

describe("Dockerfile.release", () => {
  test("copies entrypoint script", () => {
    const src = readText("Dockerfile.release");
    expect(src).toContain("container-entrypoint.sh");
    expect(src).toContain("ENTRYPOINT");
  });

  test("copies database into image", () => {
    const src = readText("Dockerfile.release");
    expect(src).toContain("ros-help.db");
  });

  test("exposes port 8080", () => {
    const src = readText("Dockerfile.release");
    expect(src).toContain("EXPOSE 8080");
  });

  test("injects build constants", () => {
    const src = readText("Dockerfile.release");
    expect(src).toContain("IS_COMPILED");
    expect(src).toContain("VERSION");
    expect(src).toContain("REPO_URL");
  });
});
