/**
 * build-release.ts — Cross-compile MCP server binaries for all platforms.
 *
 * Usage: bun run scripts/build-release.ts [version]
 *   version defaults to package.json version prefixed with "v"
 *
 * Produces:
 *   dist/<platform>/mikrotik-docs[.exe]  — compiled binary
 *   dist/mikrotik-docs-<platform>.zip    — release ZIP (binary + README)
 *   dist/ros-help.db.gz                  — compressed database (if DB exists)
 *
 * Then upload with:
 *   gh release create <version> dist/*.zip dist/ros-help.db.gz
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(ROOT, "dist");
const ENTRY = path.join(ROOT, "src/mcp.ts");
const REPO_URL = "tikoci/mikrotik-docs";

// Version from CLI arg or package.json
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf-8"));
const version = process.argv[2] || `v${pkg.version}`;

interface Target {
  name: string;
  bunTarget: string;
  exe: string;
}

const targets: Target[] = [
  { name: "macos-arm64", bunTarget: "bun-darwin-arm64", exe: "mikrotik-docs" },
  { name: "macos-x64", bunTarget: "bun-darwin-x64", exe: "mikrotik-docs" },
  { name: "windows-x64", bunTarget: "bun-windows-x64", exe: "mikrotik-docs.exe" },
  { name: "linux-x64", bunTarget: "bun-linux-x64", exe: "mikrotik-docs" },
];

const defines = [
  `--define`, `VERSION='${JSON.stringify(version)}'`,
  `--define`, `REPO_URL='${JSON.stringify(REPO_URL)}'`,
  `--define`, `IS_COMPILED='true'`,
];

// Clean dist/
if (existsSync(DIST)) rmSync(DIST, { recursive: true });
mkdirSync(DIST, { recursive: true });

console.log(`Building mikrotik-docs ${version}`);
console.log();

// Build README for inclusion in ZIP
const readmeTxt = `mikrotik-docs ${version}
RouterOS documentation MCP server

Quick Start:
  1. Run:  ./mikrotik-docs --setup
     (On macOS: if blocked by Gatekeeper, go to System Settings > Privacy & Security > Allow)
     (On Windows: if SmartScreen warns, click "More info" > "Run anyway")
  2. This downloads the documentation database (~50 MB compressed)
  3. Follow the printed instructions to configure your MCP client
  4. Restart your AI assistant

For more information: https://github.com/${REPO_URL}
`;

// Compile each target
for (const target of targets) {
  const dir = path.join(DIST, target.name);
  mkdirSync(dir, { recursive: true });

  const outfile = path.join(dir, target.exe);
  console.log(`Compiling ${target.name} (${target.bunTarget})...`);

  const cmd = [
    "bun", "build", "--compile",
    "--minify", "--bytecode",
    `--target=${target.bunTarget}`,
    ...defines,
    ENTRY,
    `--outfile`, outfile,
  ].join(" ");

  try {
    execSync(cmd, { cwd: ROOT, stdio: "inherit" });
  } catch {
    console.error(`  ✗ Failed to compile ${target.name}`);
    continue;
  }

  // Write README into target dir
  writeFileSync(path.join(dir, "README.txt"), readmeTxt);

  // Create ZIP
  const zipName = `mikrotik-docs-${target.name}.zip`;
  const zipPath = path.join(DIST, zipName);
  console.log(`  Packaging ${zipName}...`);

  if (target.bunTarget.includes("windows")) {
    // zip from the target directory
    execSync(`zip -j "${zipPath}" "${outfile}" "${path.join(dir, "README.txt")}"`, {
      cwd: ROOT,
      stdio: "inherit",
    });
  } else {
    execSync(`zip -j "${zipPath}" "${outfile}" "${path.join(dir, "README.txt")}"`, {
      cwd: ROOT,
      stdio: "inherit",
    });
  }

  console.log(`  ✓ ${zipName}`);
  console.log();
}

// Compress database if it exists
const dbPath = path.join(ROOT, "ros-help.db");
if (existsSync(dbPath)) {
  console.log("Compressing database...");
  const dbData = readFileSync(dbPath);
  const compressed = Bun.gzipSync(dbData);
  const gzPath = path.join(DIST, "ros-help.db.gz");
  writeFileSync(gzPath, compressed);
  const origMB = (dbData.byteLength / 1024 / 1024).toFixed(1);
  const compMB = (compressed.byteLength / 1024 / 1024).toFixed(1);
  console.log(`  ✓ ros-help.db.gz (${origMB} MB → ${compMB} MB)`);
  console.log();
}

// Summary
console.log("─".repeat(60));
console.log("Release artifacts:");
console.log();
const artifacts = [];
for (const target of targets) {
  const zipName = `mikrotik-docs-${target.name}.zip`;
  if (existsSync(path.join(DIST, zipName))) {
    console.log(`  dist/${zipName}`);
    artifacts.push(`dist/${zipName}`);
  }
}
if (existsSync(path.join(DIST, "ros-help.db.gz"))) {
  console.log(`  dist/ros-help.db.gz`);
  artifacts.push("dist/ros-help.db.gz");
}

console.log();
console.log("To publish:");
console.log(`  gh release create ${version} ${artifacts.join(" ")} --title "${version}" --generate-notes`);
console.log();
