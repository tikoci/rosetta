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

function mustIndex(haystack: string, needle: string): number {
  const idx = haystack.indexOf(needle);
  expect(idx).toBeGreaterThanOrEqual(0);
  return idx;
}

// ---------------------------------------------------------------------------
// package.json health
// ---------------------------------------------------------------------------

describe("package.json", () => {
  const pkg = JSON.parse(readText("package.json"));

  test("version is valid semver, optionally with an alpha/beta/rc prerelease channel suffix", () => {
    // release.yml's "Determine npm release channel" step reads this committed
    // value as the single source of truth: a bare MAJOR.MINOR.PATCH means
    // latest, a -<stage> or -<stage>.N suffix means a prerelease dist-tag.
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-(alpha|beta|rc)(\.\d+)?)?$/);
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
    // Now uses both a version-pinned URL and a /latest/ fallback (see dbDownloadUrls).
    expect(src).toContain("/releases/download/");
    expect(src).toContain("/releases/latest/download/ros-help.db.gz");
  });

  test("validates SQLite magic bytes before writing the canonical DB path", () => {
    const src = readText("src/setup.ts");
    expect(src).toContain("SQLite format 3");
  });

  test("writes to a .tmp file and renames atomically", () => {
    const src = readText("src/setup.ts");
    expect(src).toContain(".tmp.");
    expect(src).toContain("renameSync");
  });

  test("clears stale WAL/SHM siblings on download", () => {
    const src = readText("src/setup.ts");
    expect(src).toContain("-wal");
    expect(src).toContain("-shm");
  });

  test("exports a quiet refreshDb path used by --refresh", () => {
    const src = readText("src/setup.ts");
    expect(src).toContain("export async function refreshDb");
    const mcp = readText("src/mcp.ts");
    expect(mcp).toContain("refreshDb");
  });

  test("serializes package DB preparation with a sidecar lock", () => {
    const src = readText("src/setup.ts");
    expect(src).toContain(".lock");
    expect(src).toContain("tryAcquireDownloadLock");
    expect(src).toContain("waitForUsableDb");
  });

  test("mcp.ts fails hard on persistent schema mismatch (no silent fall-through)", () => {
    const src = readText("src/mcp.ts");
    // Must call process.exit on the unrecoverable schema-mismatch path
    expect(src).toContain("Still incompatible after re-download");
    expect(src).toMatch(/Still incompatible[\s\S]{0,500}(throw new Error|process\.exit\(1\))/);
  });

  test("mcp.ts aborts startup instead of continuing with an empty DB", () => {
    const src = readText("src/mcp.ts");
    expect(src).toContain("Unable to start rosetta without a usable database");
    expect(src).toContain("Database remained incomplete after recovery");
  });

  test("mcp.ts uses checkDbFreshness (schema + release-tag) rather than a schema-only check (#76/#23)", () => {
    const src = readText("src/mcp.ts");
    expect(src).toContain("checkDbFreshness");
    // detectMode is required so dev-mode DBs (release_tag not tied to a
    // publish) never trigger a network redownload on release-tag drift alone.
    expect(src).toContain("detectMode");
  });

  test("mcp.ts degrades gracefully instead of crashing on a non-fatal (release-tag-only) refresh failure", () => {
    const src = readText("src/mcp.ts");
    const warnIdx = mustIndex(src, "Refresh check failed");
    const elseIdx = mustIndex(src, "} else {");
    expect(elseIdx).toBeGreaterThan(warnIdx);
    // The branch between the warning log and the `else` (hard-fail) branch
    // must not throw — a release-tag-only mismatch keeps serving the
    // existing, schema-current DB instead of crashing startup.
    const gracefulBranch = src.slice(warnIdx, elseIdx);
    expect(gracefulBranch).not.toContain("throw");
    expect(gracefulBranch).toContain("p = previous;");
  });

  test("mcp.ts honors ROSETTA_OFFLINE=1 by skipping the network attempt, not by letting it fail slowly", () => {
    const src = readText("src/mcp.ts");
    expect(src).toContain('process.env.ROSETTA_OFFLINE === "1"');

    // The offline short-circuit must sit inside the try block, ahead of the
    // real downloadDb() call, so it reuses the exact same hard-fail-vs-graceful
    // catch branching as a real network failure rather than duplicating it.
    // (downloadDb() is called twice in this file — Case 1 and Case 2 — so
    // search for the occurrence after the offline throw, not the first one.)
    const offlineThrowIdx = mustIndex(src, 'throw new Error("ROSETTA_OFFLINE=1 set; not attempting a network download")');
    const downloadCallIdx = src.indexOf("p = await downloadDb(dbPath, log);", offlineThrowIdx);
    expect(downloadCallIdx).toBeGreaterThan(offlineThrowIdx);
  });

  test("mcp.ts fails fast under ROSETTA_OFFLINE=1 when no DB exists at all (nothing to fall back to)", () => {
    const src = readText("src/mcp.ts");
    const offlineNoDbIdx = mustIndex(
      src,
      "ROSETTA_OFFLINE=1 set and no usable database exists",
    );
    const firstDownloadCallIdx = mustIndex(src, "p = await downloadDb(dbPath, log);");
    // This check must guard the very first download attempt (Case 1: missing/
    // empty DB) — placed before it, not folded into the Case 2 freshness logic.
    expect(offlineNoDbIdx).toBeLessThan(firstDownloadCallIdx);
  });

  test("setup.ts exports checkDbFreshness as a pure, unit-tested decision function", () => {
    const src = readText("src/setup.ts");
    expect(src).toContain("export function checkDbFreshness");
  });

  test("setup.ts cleans temp DB artifacts instead of accumulating stale .tmp files", () => {
    const src = readText("src/setup.ts");
    expect(src).toContain("cleanupStaleTempArtifacts");
    expect(src).toContain("cleanupAbandonedTempArtifacts");
    expect(src).toContain("tryUnlinkDbSidecars(tmpPath)");
  });

  test("setup.ts finalizes probe statements before renaming temp DBs", () => {
    const src = readText("src/setup.ts");
    expect(src).toContain("stmt.finalize()");
    expect(src).toContain("sqliteGet");
  });

  test("no DB open uses { readonly: true } (WAL-shm init trap on macOS)", () => {
    // Freshly-renamed WAL-mode DBs fail to open readonly on macOS until a
    // read-write connection initialises the .shm file. downloadDb explicitly
    // deletes .wal/.shm before the rename, so every subsequent open must be
    // read-write. Regressing this ships a bunx path that can't open its own
    // validated download (see v0.8.0 "DB=unreadable" bug).
    for (const file of ["src/mcp.ts", "src/setup.ts", "src/db.ts"]) {
      // Strip line + block comments before scanning, so the "do NOT pass
      // { readonly: true }" warnings themselves don't trip the check.
      const src = readText(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      expect(src).not.toMatch(/readonly\s*:\s*true/);
    }
  });
});

// ---------------------------------------------------------------------------
// db_meta provenance + stamp script
// ---------------------------------------------------------------------------

describe("db_meta provenance", () => {
  test("stamp-db-meta.ts script exists and accepts --release-tag", () => {
    const src = readText("scripts/stamp-db-meta.ts");
    expect(src).toContain("--release-tag");
    expect(src).toContain("CREATE TABLE IF NOT EXISTS db_meta");
  });

  test("release.yml stamps db_meta after extraction", () => {
    const yml = readText(".github/workflows/release.yml");
    expect(yml).toContain("scripts/stamp-db-meta.ts");
    expect(yml).toContain("--release-tag");
    expect(yml).toContain("--source-commit");
  });

  test("db.ts exposes setDbMeta / getDbMeta helpers", () => {
    const src = readText("src/db.ts");
    expect(src).toContain("export function setDbMeta");
    expect(src).toContain("export function getDbMeta");
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

  test("has verify target", () => {
    expect(makefile).toContain("verify:");
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

  test("has extract-dude target", () => {
    expect(makefile).toContain("extract-dude:");
  });

  test("has extract-dude-from-cache target", () => {
    expect(makefile).toContain("extract-dude-from-cache:");
  });

  test("has extract-skills target", () => {
    expect(makefile).toContain("extract-skills:");
  });

  test("has extract-skills-from-cache target", () => {
    expect(makefile).toContain("extract-skills-from-cache:");
  });

  test("extract-skills is in PHONY", () => {
    const phonyStart = makefile.indexOf(".PHONY:");
    const phonyEnd = makefile.indexOf("\n\n", phonyStart);
    const phonyBlock = makefile.slice(phonyStart, phonyEnd);
    expect(phonyBlock).toContain("extract-skills");
  });

  test("has gc-versions target with EXTRA_FLAGS passthrough", () => {
    expect(makefile).toContain("gc-versions:");
    expect(makefile).toContain("src/gc-versions.ts $(EXTRA_FLAGS)");
  });

  test("gc-versions is in PHONY", () => {
    const phonyStart = makefile.indexOf(".PHONY:");
    const phonyEnd = makefile.indexOf("\n\n", phonyStart);
    const phonyBlock = makefile.slice(phonyStart, phonyEnd);
    expect(phonyBlock).toContain("gc-versions");
  });

  test("extract-dude is in PHONY", () => {
    const phonyStart = makefile.indexOf(".PHONY:");
    const phonyEnd = makefile.indexOf("\n\n", phonyStart);
    const phonyBlock = makefile.slice(phonyStart, phonyEnd);
    expect(phonyBlock).toContain("extract-dude");
  });

  test("extract target includes Dude cache import", () => {
    expect(makefile).toMatch(/^extract:.*extract-dude-from-cache/m);
  });

  test("extract target includes skills", () => {
    expect(makefile).toMatch(/^extract:.*extract-skills/m);
  });

  test("extract-full target includes skills", () => {
    expect(makefile).toMatch(/^extract-full:.*extract-skills/m);
  });

  test("extract-full target includes Dude cache import", () => {
    expect(makefile).toMatch(/^extract-full:.*extract-dude-from-cache/m);
  });

  test("has extract-docusaurus and extract-docusaurus-from-cache targets", () => {
    expect(makefile).toContain("extract-docusaurus:");
    expect(makefile).toContain("extract-docusaurus-from-cache:");
  });

  test("extract-docusaurus is in PHONY", () => {
    const phonyStart = makefile.indexOf(".PHONY:");
    const phonyEnd = makefile.indexOf("\n\n", phonyStart);
    const phonyBlock = makefile.slice(phonyStart, phonyEnd);
    expect(phonyBlock).toContain("extract-docusaurus");
  });

  test("extract/extract-full use extract-docusaurus, not the legacy Confluence pipeline", () => {
    // T-0035: extract-docusaurus.ts replaces extract-html.ts's role in the default
    // pipeline. extract-html.ts survives only via extract-legacy-confluence, for
    // rebuilding historical pre-migration release DBs (DESIGN.md).
    expect(makefile).toMatch(/^extract: extract-docusaurus\b/m);
    expect(makefile).toMatch(/^extract-full: extract-docusaurus\b/m);
    expect(makefile).not.toMatch(/^extract:.*extract-html\b/m);
    expect(makefile).not.toMatch(/^extract-full:.*extract-html\b/m);
  });

  test("has extract-legacy-confluence target wrapping extract-html + extract-properties", () => {
    expect(makefile).toMatch(/^extract-legacy-confluence:.*extract-html.*extract-properties/m);
  });

  test("preflight checks dirty tree", () => {
    expect(makefile).toContain("git diff --quiet");
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
    expect(src).not.toContain("html_url:");
    expect(src).not.toContain("extract-html.ts");
    expect(src).not.toContain("extract-properties.ts");
    expect(src).toContain("version:");
    expect(src).toContain("republish_assets:");
    expect(src).not.toContain("inputs.force");
  });

  describe("npm prerelease channel", () => {
    const src = readText(".github/workflows/release.yml");
    const channelIdx = mustIndex(src, "Determine npm release channel");
    const changelogGateIdx = mustIndex(
      src,
      "Verify CHANGELOG promotion for latest-channel release",
    );
    const preflightIdx = mustIndex(src, "Verify npm publish access");
    const resolveVersionIdx = mustIndex(src, "Resolve release version");
    const installIdx = mustIndex(src, "bun install");

    test("channel detection runs before any preflight/publish step reads package.json's version", () => {
      expect(installIdx).toBeLessThan(channelIdx);
      expect(channelIdx).toBeLessThan(changelogGateIdx);
      expect(channelIdx).toBeLessThan(preflightIdx);
      expect(channelIdx).toBeLessThan(resolveVersionIdx);
    });

    test("parses a MAJOR.MINOR.PATCH-<stage> or -<stage>.N package.json version into channel/stage outputs", () => {
      const channelBlock = src.slice(channelIdx, changelogGateIdx);
      expect(channelBlock).toContain(
        "^([0-9]+\\.[0-9]+\\.[0-9]+)-([A-Za-z]+)(\\.[0-9]+)?$",
      );
      expect(channelBlock).toContain("channel=prerelease");
      expect(channelBlock).toContain("channel=latest");
      expect(channelBlock).toContain("stage=$STAGE");
    });

    test("validates the parsed stage against the alpha/beta/rc allowlist, not arbitrary strings", () => {
      const channelBlock = src.slice(channelIdx, changelogGateIdx);
      expect(channelBlock).toContain("alpha|beta|rc) ;;");
      expect(channelBlock).toMatch(/::error::Unrecognized prerelease stage/);
      expect(channelBlock).toContain("exit 1");
    });

    test("a version matching neither the prerelease nor the bare-semver shape fails loudly instead of silently falling through to latest", () => {
      const channelBlock = src.slice(channelIdx, changelogGateIdx);
      // Bare-latest branch must be gated on a strict semver regex, not a bare `else`
      // catch-all — otherwise a typo'd prerelease shape (e.g. "0.11.0-alpha1" with
      // no separator, or a 4-part version) would silently publish as `latest`.
      expect(channelBlock).toMatch(
        /elif \[\[ "\$PKG_VERSION" =~ \^\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]; then/,
      );
      expect(channelBlock).toMatch(
        /::error::package\.json version '\$PKG_VERSION' doesn't match a recognized shape/,
      );
    });

    test("rewrites package.json's version in-place with a run-number suffix for prerelease, workspace-only (not committed)", () => {
      const channelBlock = src.slice(channelIdx, changelogGateIdx);
      expect(channelBlock).toContain(`\${BASE}-\${STAGE}.\${GITHUB_RUN_NUMBER}`);
      expect(channelBlock).toContain("fs.writeFileSync('package.json'");
      expect(channelBlock).not.toContain("git add package.json");
      expect(channelBlock).not.toContain("git commit");
    });

    test("republish_assets: true skips the package.json rewrite and requires an exact inputs.version for prerelease republishes", () => {
      const channelBlock = src.slice(channelIdx, changelogGateIdx);
      expect(channelBlock).toMatch(/if \[ "\$REPUBLISH_ASSETS" = "true" \]/);
      expect(channelBlock).toMatch(
        /republish_assets=true with a prerelease package\.json version.*requires inputs\.version/,
      );
      expect(channelBlock).toContain(
        "package.json version left as committed",
      );
    });

    test("republish_assets and version inputs are read via env:, not interpolated directly into the shell script (template-injection guard)", () => {
      const channelBlock = src.slice(channelIdx, changelogGateIdx);
      expect(channelBlock).toContain(`REPUBLISH_ASSETS: \${{ inputs.republish_assets }}`);
      expect(channelBlock).toContain(`INPUT_VERSION: \${{ inputs.version }}`);
      expect(channelBlock).not.toMatch(/\[ .*"\$\{\{ inputs\./);
    });

    test("latest-channel CHANGELOG gate fails without a matching [<version>] heading, skips for prerelease and republish", () => {
      const gateIdx2 = mustIndex(src, "Verify npm publish access");
      const gateBlock = src.slice(changelogGateIdx, gateIdx2);
      expect(gateBlock).toContain('if: inputs.republish_assets != true');
      expect(gateBlock).toContain('steps.channel.outputs.channel');
      expect(gateBlock).toContain('grep -qF "## [$PKG_VERSION]" CHANGELOG.md');
      expect(gateBlock).toMatch(/::error::CHANGELOG\.md has no/);
    });

    test("npm publish uses --tag <stage> for prerelease and adds a next dist-tag; latest is unchanged bare publish", () => {
      const publishIdx = mustIndex(src, "Publish to npm");
      const bunxSmokeIdx = mustIndex(src, "bunx-smoke:");
      const publishBlock = src.slice(publishIdx, bunxSmokeIdx);
      expect(publishBlock).toContain(
        `npm publish --access public --tag "\${{ needs.build.outputs.stage }}"`,
      );
      // Reads PKG_NAME from package.json dynamically rather than hardcoding
      // the package name, so a rename can't silently drift out of sync.
      expect(publishBlock).toContain(
        "PKG_NAME=$(node -p \"require('./package.json').name\")",
      );
      expect(publishBlock).toContain(
        `npm dist-tag add "\${PKG_NAME}@\${NPM_VERSION}" next`,
      );
      expect(publishBlock).toContain(
        "npm publish --access public --registry https://registry.npmjs.org/",
      );
    });

    test("OCI tags align with npm scheme: version+sha always, floating stage/next for prerelease, latest only for latest channel, republish never moves floating tags", () => {
      const ociIdx = mustIndex(src, "Build and push OCI images");
      const smokeIdx = mustIndex(src, "Smoke test published OCI images");
      const ociBlock = src.slice(ociIdx, smokeIdx);
      expect(ociBlock).toContain(`tags+=(--tag "\${registry}:\${VERSION}" --tag "\${registry}:sha-\${SHORT_SHA}")`);
      expect(ociBlock).toContain(`tags+=(--tag "\${registry}:\${STAGE}" --tag "\${registry}:next")`);
      expect(ociBlock).toContain(`tags+=(--tag "\${registry}:latest")`);
      // republish_assets is read via env: (template-injection guard), not
      // interpolated directly into the `if [ ... ]` shell test.
      expect(ociBlock).toContain(`REPUBLISH_ASSETS: \${{ inputs.republish_assets }}`);
      expect(ociBlock).toMatch(/if \[ "\$REPUBLISH_ASSETS" != "true" \]/);
    });

    test("GitHub Release is created with --prerelease for prerelease channel runs", () => {
      const releaseIdx = mustIndex(src, "Create or update GitHub Release");
      const publishIdx = mustIndex(src, "Publish to npm");
      const releaseBlock = src.slice(releaseIdx, publishIdx);
      expect(releaseBlock).toContain("PRERELEASE_FLAGS=(--prerelease)");
      expect(releaseBlock).toContain('needs.build.outputs.channel');
      expect(releaseBlock).toContain(`"\${PRERELEASE_FLAGS[@]}"`);
    });

    test("docs_date and republish_assets inputs are read via env: in the GitHub Release step (template-injection guard)", () => {
      const releaseIdx = mustIndex(src, "Create or update GitHub Release");
      const publishIdx = mustIndex(src, "Publish to npm");
      const releaseBlock = src.slice(releaseIdx, publishIdx);
      expect(releaseBlock).toContain(`DOCS_DATE: \${{ inputs.docs_date }}`);
      expect(releaseBlock).toContain(`REPUBLISH_ASSETS: \${{ inputs.republish_assets }}`);
      expect(releaseBlock).toMatch(/if \[ "\$REPUBLISH_ASSETS" = "true" \]/);
      expect(releaseBlock).not.toContain(`DOCS_DATE="\${{ inputs.docs_date }}"`);
    });
  });

  test("runs test coverage in release CI and uploads it as a workflow artifact", () => {
    const src = readText(".github/workflows/release.yml");
    const fastFailIdx = mustIndex(src, "Run tests (fast-fail)");
    const buildxIdx = mustIndex(src, "Set up Docker Buildx");
    const coverageBlock = src.slice(fastFailIdx, buildxIdx);

    expect(coverageBlock).toContain("bun test --coverage");
    expect(coverageBlock).toContain("--coverage-reporter=lcov");
    expect(coverageBlock).toContain("## Test coverage");
    expect(coverageBlock).toContain("Upload coverage artifact");
    expect(coverageBlock).toContain("coverage/lcov.info");
  });

  test("coverage step always closes its summary code fence, even when bun test fails (PIPESTATUS, not implicit pipefail)", () => {
    const src = readText(".github/workflows/release.yml");
    const fastFailIdx = mustIndex(src, "Run tests (fast-fail)");
    const uploadIdx = mustIndex(src, "Upload coverage artifact");
    const coverageBlock = src.slice(fastFailIdx, uploadIdx);

    expect(coverageBlock).toContain("set +e");
    const statusIdx = mustIndex(coverageBlock, `status=\${PIPESTATUS[0]}`);
    const closeFenceIdx = coverageBlock.lastIndexOf("echo '```'");
    const exitIdx = mustIndex(coverageBlock, 'exit "$status"');

    expect(statusIdx).toBeLessThan(closeFenceIdx);
    expect(closeFenceIdx).toBeLessThan(exitIdx);
  });

  test("runs extraction pipeline", () => {
    const src = readText(".github/workflows/release.yml");
    expect(src).toContain("extract-docusaurus.ts");
    expect(src).toContain("extract-commands.ts");
    expect(src).toContain("extract-devices.ts");
    expect(src).toContain("extract-test-results.ts");
    expect(src).toContain("extract-changelogs.ts");
    expect(src).toContain("extract-skills.ts");
    expect(src).toContain("link-commands.ts");
  });

  test("Docusaurus extraction step proves the docs-count invariant, not just a manual/local run", () => {
    const src = readText(".github/workflows/release.yml");
    const extractIdx = mustIndex(src, "Extract Docusaurus pages, properties, callouts");
    const commandTreeIdx = mustIndex(src, "Extract command tree");
    const extractBlock = src.slice(extractIdx, commandTreeIdx);

    expect(extractBlock).toContain("extract-docusaurus.ts --check-counts --strict");
  });

  test("imports Dude wiki from cache", () => {
    const src = readText(".github/workflows/release.yml");
    expect(src).toContain("extract-dude-from-cache");
  });

  test("extracts agent skills in CI", () => {
    const src = readText(".github/workflows/release.yml");
    const skillsIdx = mustIndex(src, "Extract agent skills from GitHub");
    const linkIdx = mustIndex(src, "Link commands to pages");
    const skillsBlock = src.slice(skillsIdx, linkIdx);

    expect(skillsBlock).toContain("extract-skills.ts");
    expect(skillsBlock).toContain("GITHUB_TOKEN");
    expect(skillsBlock).toContain("$" + "{{ github.token }}");
  });

  test("runs the fast-fail quality gate in the build job (contract/eval moved to the qa job)", () => {
    const src = readText(".github/workflows/release.yml");
    expect(src).toContain("bun run typecheck");
    expect(src).toContain("bun test");
    expect(src).toContain("bun run lint");
    // The real-DB contract suite is no longer inlined here — it runs once, in
    // qa.yml, against the artifact DB. Asserted in the qa.yml describe block.
    expect(src).not.toContain("ROSETTA_REAL_DB_TESTS=1 bun test src/mcp-contract.test.ts");
  });

  test("runs early quality gate before Docusaurus extraction", () => {
    const src = readText(".github/workflows/release.yml");
    const installIdx = mustIndex(src, "bun install");
    const typecheckIdx = mustIndex(src, "Type check (fast-fail)");
    const lintIdx = mustIndex(src, "Lint (fast-fail)");
    const earlyTestIdx = mustIndex(src, "Run tests (fast-fail)");
    const extractIdx = mustIndex(src, "Extract Docusaurus pages, properties, callouts");

    expect(installIdx).toBeLessThan(typecheckIdx);
    expect(typecheckIdx).toBeLessThan(lintIdx);
    expect(lintIdx).toBeLessThan(earlyTestIdx);
    expect(earlyTestIdx).toBeLessThan(extractIdx);
  });

  test("preflights npm publish access before release side effects", () => {
    const src = readText(".github/workflows/release.yml");
    const preflightIdx = mustIndex(src, "Verify npm publish access");
    const extractIdx = mustIndex(src, "Extract Docusaurus pages, properties, callouts");
    const ociIdx = mustIndex(src, "Build and push OCI images");
    const releaseIdx = mustIndex(src, "Create or update GitHub Release");
    const publishIdx = mustIndex(src, "Publish to npm");
    const preflightBlock = src.slice(preflightIdx, extractIdx);

    expect(preflightIdx).toBeLessThan(extractIdx);
    expect(preflightIdx).toBeLessThan(ociIdx);
    expect(preflightIdx).toBeLessThan(releaseIdx);
    expect(preflightIdx).toBeLessThan(publishIdx);
    expect(preflightBlock).toContain("NODE_AUTH_TOKEN");
    expect(preflightBlock).toContain("npm whoami");
    expect(preflightBlock).toContain("npm access list collaborators");
    expect(preflightBlock).toContain("read-write access");
    expect(preflightBlock).toContain("npm view");
  });

  test("keeps post-extraction DB-wipe guard after extraction", () => {
    const src = readText(".github/workflows/release.yml");
    const linkIdx = mustIndex(src, "Link commands to pages");
    const guardIdx = mustIndex(src, "Run tests (DB-wipe guard)");
    const buildIdx = mustIndex(src, "Build release artifacts");

    expect(guardIdx).toBeGreaterThan(linkIdx);
    expect(guardIdx).toBeLessThan(buildIdx);
    expect(src.slice(guardIdx, buildIdx)).toContain("bun test");
  });

  test("runs schema_node_presence GC after link and before stats/build", () => {
    const src = readText(".github/workflows/release.yml");
    const linkIdx = mustIndex(src, "Link commands to pages");
    const gcIdx = mustIndex(src, "GC schema node presence versions");
    const statsIdx = mustIndex(src, "Collect DB stats");
    const buildIdx = mustIndex(src, "Build release artifacts");

    expect(gcIdx).toBeGreaterThan(linkIdx);
    expect(gcIdx).toBeLessThan(statsIdx);
    expect(gcIdx).toBeLessThan(buildIdx);
    expect(src.slice(gcIdx, statsIdx)).toContain("make gc-versions EXTRA_FLAGS=--verbose");
  });

  // The MCP contract suite and the Phase 0/1 retrieval evals are no longer
  // inlined in release.yml — Phase B (#42) moved them into the single qa.yml
  // definition, which release.yml's `qa` job calls with db_source=artifact.
  // The qa.yml describe block below asserts they run there; here we only prove
  // release.yml delegates to them (and no longer carries a copy).
  test("delegates contract + retrieval evals to the qa job, not an inline copy", () => {
    const src = readText(".github/workflows/release.yml");
    expect(src).not.toContain("MCP retrieval eval (Phase 0)");
    expect(src).not.toContain("MCP retrieval eval (Phase 1, self-supervised, non-blocking)");
    expect(src).not.toContain("bun run src/eval/retrieval.ts");
    expect(src).not.toContain("bun run src/eval/self-supervised.ts");
    // The delegation itself: a qa job that calls the reusable workflow.
    expect(src).toContain("uses: ./.github/workflows/qa.yml");
  });

  test("creates GitHub Release", () => {
    const src = readText(".github/workflows/release.yml");
    expect(src).toContain("gh release create");
  });

  test("republish_assets controls immutable npm skips and release clobbering", () => {
    const src = readText(".github/workflows/release.yml");
    expect(src).toContain("republish_assets:");
    expect(src).toContain("Does NOT re-publish npm");
    expect(src).not.toContain("inputs.force");
    expect(src).not.toContain("force=true");

    // republish_assets is read via an env-mapped $REPUBLISH_ASSETS, not
    // interpolated directly into the shell script (template-injection guard).
    const republishBranchIdx = src.search(
      /if \[ "\$REPUBLISH_ASSETS" = "true" \]; then/,
    );
    expect(republishBranchIdx).toBeGreaterThanOrEqual(0);
    const clobberIdx = mustIndex(src, "gh release upload");
    expect(src.slice(clobberIdx, clobberIdx + 120)).toContain("--clobber");
    expect(republishBranchIdx).toBeLessThan(clobberIdx);
    expect(src).toContain('elif gh release view "$VERSION"');
    expect(src).toContain("updated before npm publish retry");

    expect(src).toContain("if: inputs.republish_assets != true");
    expect(src).toContain("if: inputs.republish_assets == true");
    expect(src).toMatch(
      /Publish to npm[\s\S]{0,120}if: inputs\.republish_assets != true/,
    );
    expect(src).toMatch(
      /bunx-smoke:[\s\S]{0,120}if: inputs\.republish_assets != true/,
    );
  });

  test("bump-version job and its auto-commit are gone entirely — version bumps are a manual step for every channel", () => {
    const src = readText(".github/workflows/release.yml");
    expect(src).not.toContain("bump-version:");
    expect(src).not.toContain("git push origin HEAD:main");
    expect(src).not.toContain("Bumped version:");
    expect(src).not.toContain("Promoted [Unreleased]");
  });

  test("publishes to npm", () => {
    const src = readText(".github/workflows/release.yml");
    expect(src).toContain("npm publish --access public --registry https://registry.npmjs.org/");
    expect(src).toContain("NPM_TOKEN");
  });

  test("bunx-smoke covers windows with bash steps and a runner temp log", () => {
    const src = readText(".github/workflows/release.yml");
    const bunxIdx = mustIndex(src, "bunx-smoke:");
    const bunxBlock = src.slice(bunxIdx);

    expect(bunxBlock).toContain("windows-latest");
    expect(bunxBlock).toContain("shell: bash");
    expect(bunxBlock).toContain("RUNNER_TEMP");
    expect(bunxBlock).not.toContain("mktemp");
  });

  test("gates the DB before any publish side effect via the qa job (regression: v0.7.6 shipped 3 pages)", () => {
    const src = readText(".github/workflows/release.yml");
    // The degenerate-DB guard (the DB-content floors) is no longer inlined here —
    // it's the db-content gate in qa.yml, which the `qa` job runs against the
    // artifact build uploaded. Assert release.yml delegates and that publish is
    // fenced behind qa so nothing ships past a red gate.
    expect(src).not.toContain("Validate DB has expected content");
    expect(src).not.toMatch(/PAGES.*-lt 200/);

    // publish depends on BOTH build (the artifact) and qa (the gates).
    expect(src).toMatch(/publish:\s*\n\s*needs:\s*\[build,\s*qa\]/);

    // The qa job that fences it: uses the reusable workflow against the artifact.
    const qaIdx = mustIndex(src, "\n  qa:");
    const publishIdx = mustIndex(src, "\n  publish:");
    const qaBlock = src.slice(qaIdx, publishIdx);
    expect(qaBlock).toContain("uses: ./.github/workflows/qa.yml");
    expect(qaBlock).toContain("db_source: artifact");
    expect(qaBlock).toContain("artifact_name: ros-help-db");

    // build must exist and hand the DB + resolved package.json downstream before qa/publish.
    const buildIdx = mustIndex(src, "\n  build:");
    expect(buildIdx).toBeLessThan(qaIdx);
    expect(src).toContain("name: Upload built DB artifact");
    expect(src).toContain("name: Upload resolved package.json");
  });

  test("publish restores the resolved package.json + DB artifact and needs both build and qa", () => {
    const src = readText(".github/workflows/release.yml");
    const publishIdx = mustIndex(src, "\n  publish:");
    const bunxIdx = mustIndex(src, "\n  bunx-smoke:");
    const publishBlock = src.slice(publishIdx, bunxIdx);

    // Downloads the exact DB qa validated and the run-numbered package.json.
    expect(publishBlock).toContain("name: Download built DB artifact");
    expect(publishBlock).toContain("name: Download resolved package.json");
    expect(publishBlock).toContain("actions/download-artifact");
    // Side-effect steps still live here, keyed off build's job outputs.
    expect(publishBlock).toContain("needs.build.outputs.version");
    expect(publishBlock).toContain("docker buildx build");
    expect(publishBlock).toContain("gh release create");
    expect(publishBlock).toContain("npm publish --access public");
  });

  test("bunx-smoke depends on publish and reads the published version from its output", () => {
    const src = readText(".github/workflows/release.yml");
    const bunxIdx = mustIndex(src, "\n  bunx-smoke:");
    const upgradeIdx = mustIndex(src, "\n  bunx-upgrade-smoke:");
    const bunxBlock = src.slice(bunxIdx, upgradeIdx);
    expect(bunxBlock).toMatch(/needs:\s*publish/);
    expect(bunxBlock).toContain("needs.publish.outputs.version");
    // The old monolithic job name is gone entirely.
    expect(src).not.toContain("build-and-release");
  });

  test("build job captures the previously-published version per dist-tag (for bunx-upgrade-smoke)", () => {
    const src = readText(".github/workflows/release.yml");
    const buildIdx = mustIndex(src, "\n  build:");
    const qaIdx = mustIndex(src, "\n  qa:");
    const buildBlock = src.slice(buildIdx, qaIdx);

    expect(buildBlock).toContain(`previous_version: \${{ steps.previous_version.outputs.previous_version }}`);
    expect(buildBlock).toContain("id: previous_version");
    // Must resolve against the SAME dist-tag this run publishes to (latest,
    // or the prerelease stage) — not just "any GitHub Release" — otherwise
    // the seeded upgrade-smoke DB wouldn't represent a real user's path.
    expect(buildBlock).toContain(`npm view "@tikoci/rosetta@\${NPM_TAG}" version`);
  });

  test("bunx-upgrade-smoke seeds a stale DB from the previous version, then proves a bare bunx auto-refreshes it (#76/#23/#78)", () => {
    const src = readText(".github/workflows/release.yml");
    const upgradeIdx = mustIndex(src, "\n  bunx-upgrade-smoke:");
    const upgradeBlock = src.slice(upgradeIdx);

    // Skipped (not failed) when there's no prior publish on this channel yet.
    expect(upgradeBlock).toMatch(/if: inputs\.republish_assets != true && needs\.build\.outputs\.previous_version != ''/);
    expect(upgradeBlock).toMatch(/needs:\s*\[build,\s*publish\]/);

    // Seeds with the OLD version, then invokes the NEW version bare (no --refresh).
    expect(upgradeBlock).toContain(`bunx "@tikoci/rosetta@\${PREV_NPM_VER}" --refresh`);
    expect(upgradeBlock).toContain(`bunx "@tikoci/rosetta@\${NPM_VER}" --http`);
    // The new version must never be invoked with --refresh — that would prove
    // nothing about auto-refresh, since --refresh forces a download regardless.
    expect(upgradeBlock).not.toContain(`"@tikoci/rosetta@\${NPM_VER}" --refresh`);

    // Asserts on the startup banner (ensureDbReady), not just "server answered" —
    // that's the only signal that actually proves the DB content refreshed.
    expect(upgradeBlock).toContain(`grep -F "release v\${NPM_VER}" "$LOG"`);

    // Also exercises the graceful-degradation half against a real bunx install.
    expect(upgradeBlock).toContain("ROSETTA_OFFLINE=1");
    expect(upgradeBlock).toContain(`grep -F "ROSETTA_OFFLINE=1" "$LOG"`);
  });
});

// ---------------------------------------------------------------------------
// qa.yml — dispatchable / callable definition of the release-locked quality
// gates (issue #40 Phase A; #42 Phase B). As of Phase B this is the SINGLE
// definition: release.yml's `qa` job calls it (db_source=artifact) instead of
// carrying inline copies. These anchors pin the dispatch surface, the artifact
// (release) path, and that the DB-content floors live here and only here.
// ---------------------------------------------------------------------------

describe("qa.yml", () => {
  test("workflow file exists", () => {
    expect(existsSync(path.join(ROOT, ".github/workflows/qa.yml"))).toBe(true);
  });

  test("is dispatchable and callable, but not push/PR-triggered (no test.yml/codeql duplication)", () => {
    const src = readText(".github/workflows/qa.yml");
    expect(src).toContain("workflow_dispatch:");
    expect(src).toContain("workflow_call:");
    // Heavy gates must stay off the PR/push path — that's test.yml's job.
    const onBlock = src.slice(mustIndex(src, "\non:"), mustIndex(src, "\npermissions:"));
    expect(onBlock).not.toContain("pull_request");
    expect(onBlock).not.toMatch(/\bpush:/);
  });

  test("never publishes — read-only permissions, no npm/OCI/release commands", () => {
    const src = readText(".github/workflows/qa.yml");
    expect(src).toContain("permissions:\n  contents: read");
    expect(src).not.toContain("packages: write");
    // Concrete publish/push commands (not prose) must be absent — this is a
    // rehearsal, never a release.
    expect(src).not.toContain("npm publish --");
    expect(src).not.toContain("docker buildx build");
    expect(src).not.toContain("gh release create");
  });

  test("exposes the focused-rehearsal dispatch menu (test_scope / db_source / eval_self_blocking / full_versions)", () => {
    const src = readText(".github/workflows/qa.yml");
    for (const scope of [
      "all",
      "contract",
      "eval-golden",
      "eval-self",
      "db-content",
      "db-meta",
      "docusaurus-count",
      "device-map",
    ]) {
      expect(src).toContain(`- ${scope}`);
    }
    expect(src).toContain("- local-build");
    expect(src).toContain("- published");
    expect(src).toContain("eval_self_blocking:");
    expect(src).toContain("full_versions:");
  });

  test("validates inputs up front so a typo'd scope fails loudly instead of a vacuous green run", () => {
    const src = readText(".github/workflows/qa.yml");
    expect(src).toContain("name: Validate inputs");
    // Allowlist enforced via case; unknown values error out.
    expect(src).toMatch(/::error::Unknown test_scope/);
    expect(src).toMatch(/::error::Unknown db_source/);
    // The one valid-but-empty combination is rejected too.
    expect(src).toContain("test_scope=docusaurus-count requires db_source=local-build");
    // Validation runs before anything expensive (setup-bun / install / build).
    expect(mustIndex(src, "name: Validate inputs")).toBeLessThan(
      mustIndex(src, "Build DB (local-build)"),
    );
  });

  test("acquires the on-disk DB only AFTER the fixture-DB tests (so the :memory: wipe guard can't trip)", () => {
    const src = readText(".github/workflows/qa.yml");
    const fixtureTestsIdx = mustIndex(src, "Run tests (fixture DB)");
    const buildIdx = mustIndex(src, "Build DB (local-build)");
    const downloadIdx = mustIndex(src, "Download published DB");
    expect(fixtureTestsIdx).toBeLessThan(buildIdx);
    expect(fixtureTestsIdx).toBeLessThan(downloadIdx);
  });

  test("local-build reuses the Makefile pipeline (encodes extract-devices → extract-hardware-catalog order)", () => {
    const src = readText(".github/workflows/qa.yml");
    expect(src).toContain("make extract-full");
    expect(src).toContain("make extract\n");
    // db_meta stamped so the db-content / db-meta gates have real values to assert.
    expect(src).toContain("scripts/stamp-db-meta.ts");
  });

  // Phase B (#42) collapsed the two copies into one: qa.yml is now the SOLE
  // definition of the DB-content floors, and release.yml calls it (db_source=
  // artifact) instead of carrying its own copy. So this is no longer a cross-file
  // drift guard — it just pins that the single definition still enforces every
  // floor, including the hardware-overlay floors (PR #41 / issue #38). release.yml
  // is asserted NOT to contain floors over in the release.yml describe block.
  test("is the single definition of the DB-content floors (incl. hardware overlay floors)", () => {
    const qa = readText(".github/workflows/qa.yml");
    for (const re of [
      /PAGES.*-lt 200/,
      /COMMANDS.*-lt 1000/,
      /DEVICES.*-lt 100/,
      /PROPERTIES.*-lt 1000/,
      /HARDWARE_CATALOG.*-lt 200/,
      /DEVICE_ALIASES.*-lt 600/,
    ]) {
      expect(qa).toMatch(re);
    }
  });

  test("supports db_source=artifact for the release path — downloads the build artifact and floors it", () => {
    const src = readText(".github/workflows/qa.yml");
    // artifact is a valid (workflow_call-only) source with a downloader step.
    expect(src).toContain("local-build|published|artifact)");
    expect(src).toContain("name: Download build artifact (artifact)");
    expect(src).toContain("actions/download-artifact");
    expect(src).toContain("artifact_name:");
    // db-content must run for a built DB under `all`, whether local-build OR the
    // release artifact — otherwise the release path would skip the floors.
    expect(src).toMatch(
      /Validate DB has expected content[\s\S]*?inputs\.db_source == 'local-build' \|\| inputs\.db_source == 'artifact'/,
    );
  });

  test("eval-self is non-blocking by default, flipped to a hard gate by eval_self_blocking", () => {
    const src = readText(".github/workflows/qa.yml");
    expect(src).toMatch(
      /continue-on-error:\s*\$\{\{\s*!inputs\.eval_self_blocking\s*\}\}/,
    );
  });

  test("wires every VALIDATION.md gate this rehearses", () => {
    const src = readText(".github/workflows/qa.yml");
    expect(src).toContain("ROSETTA_REAL_DB_TESTS=1 bun test src/mcp-contract.test.ts");
    expect(src).toContain("bun run src/eval/retrieval.ts");
    expect(src).toContain("bun run src/eval/self-supervised.ts");
    expect(src).toContain("--check-counts --strict");
    expect(src).toContain("make device-map-check");
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

  test("supports --refresh flag", () => {
    expect(src).toContain("--refresh");
  });

  test("browse mode bootstraps database before importing browse.ts", () => {
    expect(src).toContain('if (args[0] === "browse")');
    expect(src).toContain("await ensureDbReady");
  });

  test("top-level CLI bootstrap has a catch that exits non-zero on startup errors", () => {
    expect(src).toContain("})().catch((err) => {");
    expect(src).toContain("process.exit(1)");
  });
});

// ---------------------------------------------------------------------------
// Browse TUI structural checks — catch pager/navigation regressions at build time
// ---------------------------------------------------------------------------

describe("browse TUI structure", () => {
  const src = readText("src/browse.ts");
  const changelogPrefix = 'await selectFromPager(`  ' + "$" + '{bold("Changelogs")}';

  test("defines helper to route pager digit selections back into current context", () => {
    expect(src).toContain("async function selectFromPager");
    expect(src).toContain("handleNumberSelect(result.selected - 1)");
  });

  test("re-rendered result views preserve pager selection", () => {
    expect(src).toContain('await selectFromPager(renderSearchResults(ctx.response), ctx.results.length)');
    expect(src).toContain('await selectFromPager(renderCommandTree(ctx.path, children), children.length)');
    expect(src).toContain('await selectFromPager(renderCallouts(ctx.results), ctx.results.length)');
    expect(src).toContain('await selectFromPager(renderChangelogs(ctx.results), ctx.results.length)');
  });

  test("initial changelog and page-callout views push context before pager selection", () => {
    expect(src).toContain('pushCtx({ type: "changelogs", results });');
    expect(src).toContain(changelogPrefix);
    expect(src).toContain('pushCtx({ type: "callouts", query: "", results: pageCallouts });');
    expect(src).toContain('await selectFromPager(renderCallouts(pageCallouts), pageCallouts.length);');
  });

  test("page-scoped [p] and [cal] work on both page and sections contexts", () => {
    // Pages with headings push type:"sections" not type:"page", so both handlers
    // must check for sections context to make the hints visible on the page work.
    expect(src).toContain('ctx.type === "page" || ctx.type === "sections"');
    // Both handlers must appear at least twice (one per fix)
    const matches = src.split('ctx.type === "page" || ctx.type === "sections"').length - 1;
    expect(matches).toBeGreaterThanOrEqual(2);
  });

  test("pager keystrokes cleared from readline buffer before re-prompt", () => {
    // readline's data handler stays active while pager runs in raw mode, so
    // pager keystrokes accumulate in rl.line and appear after the next prompt.
    // The REPL line handler must clear rl.line/cursor before calling rl.prompt().
    expect(src).toContain('rlBuf.line = ""');
    expect(src).toContain("rlBuf.cursor = 0");
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
