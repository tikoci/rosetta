/**
 * setup.ts — Download the RouterOS documentation database and print MCP client config.
 *
 * Called by `rosetta --setup` (compiled binary), `bunx @tikoci/rosetta --setup`,
 * or `bun run src/setup.ts` (dev).
 * Downloads ros-help.db.gz from the latest GitHub Release, decompresses it,
 * validates the DB, and prints config snippets for each MCP client.
 */

import { execSync } from "node:child_process";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { gunzipSync } from "bun";
import { detectMode, resolveBaseDir, resolveDbPath, resolveVersion, SCHEMA_VERSION } from "./paths.ts";

declare const REPO_URL: string;

const GITHUB_REPO =
  typeof REPO_URL !== "undefined" ? REPO_URL : "tikoci/rosetta";
const RELEASE_VERSION = resolveVersion(import.meta.dirname);

/** Minimum byte counts for a healthy DB. Validation thresholds — keep loose so
 *  shrinking the dataset doesn't break startup, but tight enough to catch a
 *  redirect-to-login HTML page or a partial transfer. */
const MIN_PAGES = 100;
const MIN_COMMANDS = 1000;
const MIN_DECOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB
const SQLITE_MAGIC = "SQLite format 3\0";

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

/** Open a DB and return its key health metrics. Returns null on error.
 *  Exported so tests can validate fixture DBs without depending on network.
 *  Note: do NOT pass { readonly: true } — freshly written SQLite WAL-mode files
 *  fail to open readonly on macOS until a read-write connection initialises the
 *  WAL shared-memory file.  probeDb always operates on a temp or new file so
 *  read-write access is safe. */
export function probeDb(dbPath: string): {
  schemaVersion: number;
  pages: number;
  commands: number;
  releaseTag: string | null;
} | null {
  try {
    const { default: sqlite } = require("bun:sqlite");
    const check = new sqlite(dbPath);
    const ver = check.prepare("PRAGMA user_version").get() as { user_version: number };
    const pages = check.prepare("SELECT COUNT(*) AS c FROM pages").get() as { c: number };
    const cmds = check.prepare("SELECT COUNT(*) AS c FROM commands").get() as { c: number };
    let releaseTag: string | null = null;
    try {
      const meta = check.prepare("SELECT value FROM db_meta WHERE key = 'release_tag'").get() as { value: string } | null;
      releaseTag = meta?.value ?? null;
    } catch {
      // db_meta missing — pre-v5 schema, leave releaseTag null
    }
    check.close();
    return {
      schemaVersion: ver.user_version,
      pages: pages.c,
      commands: cmds.c,
      releaseTag,
    };
  } catch {
    return null;
  }
}

/** Build the version-pinned download URL. Falls back to /latest/ when no version.
 *  Exported for test coverage. */
export function dbDownloadUrls(version: string): string[] {
  const latest = `https://github.com/${GITHUB_REPO}/releases/latest/download/ros-help.db.gz`;
  // version may be "0.7.3" (from package.json) or "v0.7.3" (compiled-in). Normalize.
  const tag = version.startsWith("v") ? version : `v${version}`;
  if (!version || version === "unknown" || version === "dev") {
    return [latest];
  }
  const pinned = `https://github.com/${GITHUB_REPO}/releases/download/${tag}/ros-help.db.gz`;
  return [pinned, latest];
}

/**
 * Download ros-help.db.gz from GitHub Releases atomically:
 *   1. Try version-pinned URL first, fall back to /latest/ on 404.
 *   2. Decompress in memory, verify SQLite magic bytes + minimum size.
 *   3. Write to <dbPath>.tmp.<pid>, open it read-only, verify schema_version
 *      matches the running code and pages/commands counts look healthy.
 *   4. Atomically rename .tmp → dbPath, then delete stale .db-wal / .db-shm.
 *
 * On any validation failure the existing DB is left untouched and we throw —
 * the caller decides whether to fail hard or fall back. Never produces a
 * half-written DB file at the canonical path.
 */
export async function downloadDb(
  dbPath: string,
  log: (msg: string) => void = console.log,
) {
  const urls = dbDownloadUrls(RELEASE_VERSION);
  let lastError: Error | null = null;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const isLast = i === urls.length - 1;
    log(`Downloading database from GitHub Releases...`);
    log(`  ${url}`);

    let response: Response;
    try {
      response = await fetch(url, { redirect: "follow" });
    } catch (e) {
      lastError = e as Error;
      log(`  Network error: ${e}`);
      if (isLast) throw lastError;
      continue;
    }

    if (response.status === 404 && !isLast) {
      log(`  Not found at this URL, trying fallback...`);
      continue;
    }
    if (!response.ok) {
      lastError = new Error(`Download failed: ${response.status} ${response.statusText}`);
      if (isLast) throw lastError;
      log(`  ${lastError.message} — trying fallback...`);
      continue;
    }

    const contentLength = response.headers.get("content-length");
    const totalMB = contentLength ? (Number(contentLength) / 1024 / 1024).toFixed(1) : "?";
    log(`  Downloading ${totalMB} MB (compressed)...`);

    const compressed = new Uint8Array(await response.arrayBuffer());
    log(`  Decompressing...`);

    let decompressed: Uint8Array;
    try {
      decompressed = gunzipSync(compressed);
    } catch (e) {
      lastError = new Error(`Gunzip failed (corrupt download or HTML error page): ${e}`);
      if (isLast) throw lastError;
      log(`  ${lastError.message}`);
      continue;
    }

    // Validate magic bytes and minimum size before touching the filesystem.
    if (decompressed.byteLength < MIN_DECOMPRESSED_BYTES) {
      lastError = new Error(
        `Decompressed DB too small: ${decompressed.byteLength} bytes (expected ≥ ${MIN_DECOMPRESSED_BYTES})`,
      );
      if (isLast) throw lastError;
      log(`  ${lastError.message}`);
      continue;
    }
    const header = new TextDecoder().decode(decompressed.subarray(0, SQLITE_MAGIC.length));
    if (header !== SQLITE_MAGIC) {
      lastError = new Error("Downloaded payload is not a SQLite database (magic bytes mismatch)");
      if (isLast) throw lastError;
      log(`  ${lastError.message}`);
      continue;
    }

    // Write to a temp file next to the canonical DB path, validate, then rename.
    const tmpPath = `${dbPath}.tmp.${process.pid}`;
    try {
      writeFileSync(tmpPath, decompressed);
    } catch (e) {
      lastError = new Error(`Write to ${tmpPath} failed: ${e}`);
      throw lastError;
    }

    const probe = probeDb(tmpPath);
    if (!probe) {
      tryUnlink(tmpPath);
      lastError = new Error("Downloaded DB failed to open with SQLite");
      if (isLast) throw lastError;
      log(`  ${lastError.message} — trying fallback...`);
      continue;
    }
    if (probe.schemaVersion !== SCHEMA_VERSION) {
      tryUnlink(tmpPath);
      lastError = new Error(
        `Downloaded DB schema=${probe.schemaVersion} does not match this rosetta build (expected ${SCHEMA_VERSION}). ` +
          `This usually means the cached package version is older than the published DB. ` +
          `Run \`bun pm cache rm\` and relaunch to pick up the latest package.`,
      );
      if (isLast) throw lastError;
      log(`  ${lastError.message}`);
      continue;
    }
    if (probe.pages < MIN_PAGES || probe.commands < MIN_COMMANDS) {
      tryUnlink(tmpPath);
      lastError = new Error(
        `Downloaded DB content looks incomplete (pages=${probe.pages}, commands=${probe.commands})`,
      );
      if (isLast) throw lastError;
      log(`  ${lastError.message} — trying fallback...`);
      continue;
    }

    // Validation passed — drop stale WAL/SHM and atomically swap.
    tryUnlink(`${dbPath}-wal`);
    tryUnlink(`${dbPath}-shm`);
    renameSync(tmpPath, dbPath);

    const sizeMB = (decompressed.byteLength / 1024 / 1024).toFixed(1);
    const tagInfo = probe.releaseTag ? ` (release ${probe.releaseTag})` : "";
    log(`  Wrote ${sizeMB} MB to ${dbPath}${tagInfo}`);
    log(`  Validated: schema v${probe.schemaVersion}, ${probe.pages} pages, ${probe.commands} commands.`);
    return;
  }

  throw lastError ?? new Error("Database download failed for unknown reasons");
}

/** Remove a file if it exists, swallowing all errors. */
function tryUnlink(p: string): void {
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    // best-effort cleanup
  }
}

/**
 * Quiet refresh — download + validate + report stats. No MCP-config printing.
 * Used by `--refresh` (and indirectly by mcp.ts when auto-recovering from a
 * stale DB at startup). Returns true on success, false on failure.
 */
export async function refreshDb(log: (msg: string) => void = console.log): Promise<boolean> {
  const dbPath = resolveDbPath(import.meta.dirname);
  try {
    await downloadDb(dbPath, log);
  } catch (e) {
    log(`✗ Refresh failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
  const probe = probeDb(dbPath);
  if (!probe) {
    log(`✗ Post-download probe failed`);
    return false;
  }
  const tagInfo = probe.releaseTag ? ` (release ${probe.releaseTag})` : "";
  log(`✓ Database ready${tagInfo}: ${probe.pages} pages, ${probe.commands} commands, schema v${probe.schemaVersion}`);
  return true;
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
    console.log(`  (use --refresh or --setup --force to re-download)`);
  } else {
    try {
      await downloadDb(dbPath);
    } catch (e) {
      console.error(`✗ Database download failed: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  }

  // ── Validate DB ──
  console.log();
  const probe = probeDb(dbPath);
  if (!probe) {
    console.error(`✗ Database validation failed: cannot open ${dbPath}`);
    const retryCmd = mode === "compiled" ? "rosetta" : mode === "package" ? "bunx @tikoci/rosetta" : "bun run src/setup.ts";
    console.error(`  Try re-downloading with: ${retryCmd} --refresh`);
    process.exit(1);
  }
  if (probe.schemaVersion !== SCHEMA_VERSION) {
    console.error(
      `✗ DB schema version is ${probe.schemaVersion}, expected ${SCHEMA_VERSION}.`,
    );
    console.error(
      `  Cached package may be out of date. Run \`bun pm cache rm\` and relaunch.`,
    );
    process.exit(1);
  }
  const tagInfo = probe.releaseTag ? ` (release ${probe.releaseTag})` : "";
  console.log(
    `✓ Database ready${tagInfo}: ${probe.pages} pages, ${probe.commands} commands, schema v${probe.schemaVersion}`,
  );

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
