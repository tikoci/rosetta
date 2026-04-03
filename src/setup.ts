/**
 * setup.ts — Download the RouterOS documentation database and print MCP client config.
 *
 * Called by `rosetta --setup` (compiled binary), `bunx @tikoci/rosetta --setup`,
 * or `bun run src/setup.ts` (dev).
 * Downloads ros-help.db.gz from the latest GitHub Release, decompresses it,
 * validates the DB, and prints config snippets for each MCP client.
 */

import { execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { gunzipSync } from "bun";
import { detectMode, resolveBaseDir, resolveDbPath, resolveVersion } from "./paths.ts";

declare const REPO_URL: string;

const GITHUB_REPO =
  typeof REPO_URL !== "undefined" ? REPO_URL : "tikoci/rosetta";
const RELEASE_VERSION = resolveVersion(import.meta.dirname);

/** Check if a DB file exists and has actual page data */
function dbHasData(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  try {
    const { default: sqlite } = require("bun:sqlite");
    const check = new sqlite(dbPath, { readonly: true });
    const row = check.prepare("SELECT COUNT(*) AS c FROM pages").get() as { c: number };
    check.close();
    return row.c > 0;
  } catch {
    return false;
  }
}

/** Download ros-help.db.gz from GitHub Releases, decompress, and write to dbPath */
export async function downloadDb(
  dbPath: string,
  log: (msg: string) => void = console.log,
) {
  const url = `https://github.com/${GITHUB_REPO}/releases/latest/download/ros-help.db.gz`;
  log(`Downloading database from GitHub Releases...`);
  log(`  ${url}`);

  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const totalMB = contentLength ? (Number(contentLength) / 1024 / 1024).toFixed(1) : "?";
  log(`  Downloading ${totalMB} MB (compressed)...`);

  const compressed = new Uint8Array(await response.arrayBuffer());
  log(`  Decompressing...`);

  const decompressed = gunzipSync(compressed);
  writeFileSync(dbPath, decompressed);

  const sizeMB = (decompressed.byteLength / 1024 / 1024).toFixed(1);
  log(`  Wrote ${sizeMB} MB to ${dbPath}`);
}

export async function runSetup(force = false) {
  const mode = detectMode(import.meta.dirname);
  const dbPath = resolveDbPath(import.meta.dirname);

  console.log(`rosetta ${RELEASE_VERSION}`);
  console.log(`  ${link("https://github.com/tikoci/rosetta")}`);
  console.log();

  // ── Download DB if needed ──
  const needsDownload = force || !dbHasData(dbPath);
  if (!needsDownload) {
    console.log(`Database already exists: ${dbPath}`);
    console.log(`  (use --setup --force to re-download)`);
  } else {
    await downloadDb(dbPath);
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
    const retryCmd = mode === "compiled" ? "rosetta" : mode === "package" ? "bunx @tikoci/rosetta" : "bun run src/setup.ts";
    console.error(`  Try re-downloading with: ${retryCmd} --setup --force`);
    process.exit(1);
  }

  // ── Print config snippets ──
  console.log();
  console.log("─".repeat(60));
  console.log("Configure your MCP client:");
  console.log("─".repeat(60));

  if (mode === "compiled") {
    printCompiledConfig(process.execPath);
  } else if (mode === "package") {
    printPackageConfig();
  } else {
    printDevConfig(resolveBaseDir(import.meta.dirname));
  }
}

/** Try to resolve the absolute path to bunx (for clients that don't inherit PATH) */
function resolveBunxPath(): string | null {
  try {
    return execSync("which bunx", { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

function printCompiledConfig(serverCmd: string) {
  const cmdJson = JSON.stringify(serverCmd);

  // Claude Desktop
  const isMac = process.platform === "darwin";
  const configPath = isMac
    ? "~/Library/Application\\ Support/Claude/claude_desktop_config.json"
    : "%APPDATA%\\Claude\\claude_desktop_config.json";

  console.log();
  console.log("▸ Claude Desktop");
  console.log(`  Edit: ${configPath}`);
  console.log();
  console.log(`  {`);
  console.log(`    "mcpServers": {`);
  console.log(`      "rosetta": {`);
  console.log(`        "command": ${cmdJson}`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }`);
  console.log();
  console.log(`  Then restart Claude Desktop.`);

  // Claude Code
  console.log();
  console.log("▸ Claude Code");
  console.log(`  claude mcp add rosetta ${serverCmd}`);

  // VS Code Copilot
  console.log();
  console.log("▸ VS Code Copilot (User Settings JSON)");
  console.log();
  console.log(`  "mcp": {`);
  console.log(`    "servers": {`);
  console.log(`      "rosetta": {`);
  console.log(`        "command": ${cmdJson}`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }`);
  console.log();

  // Copilot CLI
  console.log("▸ GitHub Copilot CLI");
  console.log(`  Inside a copilot session, type /mcp add:`);
  console.log(`    Name: routeros-rosetta  |  Type: STDIO  |  Command: ${serverCmd}`);
  console.log();

  // OpenAI Codex
  console.log("▸ OpenAI Codex");
  console.log(`  codex mcp add rosetta -- ${serverCmd}`);
  console.log();

  printHttpConfig(`${serverCmd} --http`);
}

function printPackageConfig() {
  // Resolve full path to bunx — Claude Desktop doesn't inherit shell PATH
  const bunxFullPath = resolveBunxPath();

  // Claude Desktop
  const isMac = process.platform === "darwin";
  const configPath = isMac
    ? "~/Library/Application\\ Support/Claude/claude_desktop_config.json"
    : "%APPDATA%\\Claude\\claude_desktop_config.json";

  const bunxCmd = bunxFullPath ? JSON.stringify(bunxFullPath) : "\"bunx\"";
  console.log();
  console.log("▸ Claude Desktop");
  console.log(`  Edit: ${configPath}`);
  console.log();
  console.log(`  {`);
  console.log(`    "mcpServers": {`);
  console.log(`      "rosetta": {`);
  console.log(`        "command": ${bunxCmd},`);
  console.log(`        "args": ["@tikoci/rosetta"]`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }`);
  console.log();
  if (bunxFullPath) {
    console.log(`  Note: Full path used because Claude Desktop may not inherit shell PATH.`);
    console.log();
  }
  console.log(`  Then restart Claude Desktop.`);

  // Claude Code (inherits PATH — short form is fine)
  console.log();
  console.log("▸ Claude Code");
  console.log(`  claude mcp add rosetta -- bunx @tikoci/rosetta`);

  // VS Code Copilot (inherits PATH)
  console.log();
  console.log("▸ VS Code Copilot (User Settings JSON)");
  console.log();
  console.log(`  "mcp": {`);
  console.log(`    "servers": {`);
  console.log(`      "rosetta": {`);
  console.log(`        "command": "bunx",`);
  console.log(`        "args": ["@tikoci/rosetta"]`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }`);
  console.log();

  // Copilot CLI (inherits PATH)
  console.log("▸ GitHub Copilot CLI");
  console.log(`  Inside a copilot session, type /mcp add:`);
  console.log(`    Name: routeros-rosetta  |  Type: STDIO  |  Command: bunx @tikoci/rosetta`);
  console.log();

  // OpenAI Codex (inherits PATH)
  console.log("▸ OpenAI Codex");
  console.log(`  codex mcp add rosetta -- bunx @tikoci/rosetta`);
  console.log();

  printHttpConfig("bunx @tikoci/rosetta --http");
}

function printDevConfig(baseDir: string) {
  const cwdJson = JSON.stringify(baseDir);

  // Claude Desktop
  const isMac = process.platform === "darwin";
  const configPath = isMac
    ? "~/Library/Application\\ Support/Claude/claude_desktop_config.json"
    : "%APPDATA%\\Claude\\claude_desktop_config.json";

  console.log();
  console.log("▸ Claude Desktop");
  console.log(`  Edit: ${configPath}`);
  console.log();
  console.log(`  {`);
  console.log(`    "mcpServers": {`);
  console.log(`      "rosetta": {`);
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
  console.log(`  claude mcp add rosetta -- bun run src/mcp.ts`);

  // VS Code Copilot
  console.log();
  console.log("▸ VS Code Copilot");
  console.log(`  The repo includes .vscode/mcp.json — just open the folder in VS Code.`);
  console.log();

  // Copilot CLI
  console.log("▸ GitHub Copilot CLI");
  console.log(`  Inside a copilot session, type /mcp add:`);
  console.log(`    Name: routeros-rosetta  |  Type: STDIO  |  Command: bun run src/mcp.ts`);
  console.log();

  // OpenAI Codex
  console.log("▸ OpenAI Codex");
  console.log(`  codex mcp add rosetta -- bun run src/mcp.ts`);
  console.log();

  printHttpConfig(`bun run src/mcp.ts --http`);
}

function printHttpConfig(startCmd: string) {
  console.log("─".repeat(60));
  console.log("Streamable HTTP transport (for HTTP-only MCP clients):");
  console.log("─".repeat(60));
  console.log();
  console.log("▸ Start in HTTP mode");
  console.log(`  ${startCmd}`);
  console.log(`  ${startCmd} --port 9090`);
  console.log(`  ${startCmd} --host 0.0.0.0          # LAN access`);
  console.log(`  ${startCmd} --tls-cert cert.pem --tls-key key.pem  # HTTPS`);
  console.log();
  console.log("▸ URL-based MCP clients (OpenAI, etc.)");
  console.log(`  { "url": "http://localhost:8080/mcp" }`);
  console.log();
  console.log("  For LAN access, replace localhost with the server's IP address.");
  console.log("  Use a reverse proxy (nginx, caddy) for production HTTPS.");
  console.log();

  printMikroTikConfig();
}

/** Format a clickable terminal hyperlink using OSC 8 escape sequences. */
function link(url: string, display?: string): string {
  return `\x1b]8;;${url}\x07${display ?? url}\x1b]8;;\x07`;
}

function printMikroTikConfig() {
  console.log("─".repeat(60));
  console.log("MikroTik /app container (RouterOS 7.22+, x86 or ARM64):");
  console.log("─".repeat(60));
  console.log();
  console.log("  Run directly on your MikroTik router — any MCP client on");
  console.log("  the network can connect to the URL shown in the router UI.");
  console.log();
  console.log("  Requires: container package + device-mode enabled.");
  console.log(`  See: ${link("https://github.com/tikoci/rosetta#install-on-mikrotik-app", "README — Install on MikroTik")}`);
  console.log();
}


// Run directly
if (import.meta.main) {
  const force = process.argv.includes("--force");
  runSetup(force).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
