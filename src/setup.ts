/**
 * setup.ts — Download the RouterOS documentation database and print MCP client config.
 *
 * Called by `mikrotik-docs --setup` (compiled binary) or `bun run src/setup.ts` (dev).
 * Downloads ros-help.db.gz from the latest GitHub Release, decompresses it,
 * validates the DB, and prints config snippets for each MCP client.
 */

import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "bun";

declare const REPO_URL: string;
declare const VERSION: string;

const GITHUB_REPO =
  typeof REPO_URL !== "undefined" ? REPO_URL : "tikoci/mikrotik-docs";
const RELEASE_VERSION =
  typeof VERSION !== "undefined" ? VERSION : "dev";

/** Where the binary (or dev project root) lives */
function getBaseDir(): string {
  // If IS_COMPILED is defined, use the executable's directory
  // Otherwise use project root (one level up from src/)
  try {
    // @ts-expect-error IS_COMPILED defined at build time
    if (typeof IS_COMPILED !== "undefined" && IS_COMPILED) {
      return path.dirname(process.execPath);
    }
  } catch {
    // not compiled
  }
  return path.resolve(import.meta.dirname, "..");
}

/** The binary/script path for MCP config */
function getServerCommand(): string {
  try {
    // @ts-expect-error IS_COMPILED defined at build time
    if (typeof IS_COMPILED !== "undefined" && IS_COMPILED) {
      return process.execPath;
    }
  } catch {
    // not compiled
  }
  // Dev mode — bun run src/mcp.ts
  return path.resolve(import.meta.dirname, "mcp.ts");
}

export async function runSetup(force = false) {
  const baseDir = getBaseDir();
  const dbPath = path.join(baseDir, "ros-help.db");
  const serverCmd = getServerCommand();
  const isCompiled = serverCmd === process.execPath;

  console.log(`mikrotik-docs ${RELEASE_VERSION}`);
  console.log();

  // ── Download DB if needed ──
  if (existsSync(dbPath) && !force) {
    console.log(`Database already exists: ${dbPath}`);
    console.log(`  (use --setup --force to re-download)`);
  } else {
    const url = `https://github.com/${GITHUB_REPO}/releases/latest/download/ros-help.db.gz`;
    console.log(`Downloading database from GitHub Releases...`);
    console.log(`  ${url}`);
    console.log();

    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) {
      console.error(`Download failed: ${response.status} ${response.statusText}`);
      console.error();
      console.error(`If this is a new installation, the database may not be published yet.`);
      console.error(`Build it from source: make extract (requires HTML export + Bun)`);
      process.exit(1);
    }

    const contentLength = response.headers.get("content-length");
    const totalMB = contentLength ? (Number(contentLength) / 1024 / 1024).toFixed(1) : "?";
    console.log(`  Downloading ${totalMB} MB (compressed)...`);

    const compressed = new Uint8Array(await response.arrayBuffer());
    console.log(`  Decompressing...`);

    const decompressed = gunzipSync(compressed);
    writeFileSync(dbPath, decompressed);

    const sizeMB = (decompressed.byteLength / 1024 / 1024).toFixed(1);
    console.log(`  Wrote ${sizeMB} MB to ${dbPath}`);
  }

  // ── Validate DB ──
  console.log();
  try {
    const { default: sqlite } = await import("bun:sqlite");
    const db = new sqlite(dbPath, { readonly: true });
    const row = db.prepare("SELECT COUNT(*) AS c FROM pages").get() as { c: number };
    const cmdRow = db.prepare("SELECT COUNT(*) AS c FROM commands WHERE type='cmd'").get() as { c: number };
    db.close();
    console.log(`✓ Database ready (${row.c} pages, ${cmdRow.c} commands)`);
  } catch (e) {
    console.error(`✗ Database validation failed: ${e}`);
    console.error(`  Try re-downloading with: ${isCompiled ? path.basename(serverCmd) : "bun run src/setup.ts"} --setup --force`);
    process.exit(1);
  }

  // ── Print config snippets ──
  console.log();
  console.log("─".repeat(60));
  console.log("Configure your MCP client:");
  console.log("─".repeat(60));

  if (isCompiled) {
    printCompiledConfig(serverCmd);
  } else {
    printDevConfig(baseDir);
  }
}

function printCompiledConfig(serverCmd: string) {
  const cmdJson = JSON.stringify(serverCmd);

  // Claude Desktop
  const isMac = process.platform === "darwin";
  const configPath = isMac
    ? "~/Library/Application Support/Claude/claude_desktop_config.json"
    : "%APPDATA%\\Claude\\claude_desktop_config.json";

  console.log();
  console.log("▸ Claude Desktop");
  console.log(`  Edit: ${configPath}`);
  console.log();
  console.log(`  {`);
  console.log(`    "mcpServers": {`);
  console.log(`      "mikrotik-docs": {`);
  console.log(`        "command": ${cmdJson}`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }`);
  console.log();
  console.log(`  Then restart Claude Desktop.`);

  // Claude Code
  console.log();
  console.log("▸ Claude Code");
  console.log(`  claude mcp add mikrotik-docs ${serverCmd}`);

  // VS Code Copilot
  console.log();
  console.log("▸ VS Code Copilot (User Settings JSON)");
  console.log();
  console.log(`  "mcp": {`);
  console.log(`    "servers": {`);
  console.log(`      "mikrotik-docs": {`);
  console.log(`        "command": ${cmdJson}`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }`);
  console.log();
}

function printDevConfig(baseDir: string) {
  const cwdJson = JSON.stringify(baseDir);

  // Claude Desktop
  const isMac = process.platform === "darwin";
  const configPath = isMac
    ? "~/Library/Application Support/Claude/claude_desktop_config.json"
    : "%APPDATA%\\Claude\\claude_desktop_config.json";

  console.log();
  console.log("▸ Claude Desktop");
  console.log(`  Edit: ${configPath}`);
  console.log();
  console.log(`  {`);
  console.log(`    "mcpServers": {`);
  console.log(`      "mikrotik-docs": {`);
  console.log(`        "command": "bun",`);
  console.log(`        "args": ["run", "src/mcp.ts"],`);
  console.log(`        "cwd": ${cwdJson}`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }`);
  console.log();
  console.log(`  Then restart Claude Desktop.`);

  // Claude Code
  console.log();
  console.log("▸ Claude Code");
  console.log(`  claude mcp add mikrotik-docs -- bun run src/mcp.ts`);

  // VS Code Copilot
  console.log();
  console.log("▸ VS Code Copilot");
  console.log(`  The repo includes .vscode/mcp.json — just open the folder in VS Code.`);
  console.log();
}

// Run directly
if (import.meta.main) {
  const force = process.argv.includes("--force");
  await runSetup(force);
}
