/**
 * setup.ts — Download the RouterOS documentation database and print MCP client config.
 *
 * Called by `rosetta --setup` (compiled binary), `bunx @tikoci/rosetta --setup`,
 * or `bun run src/setup.ts` (dev).
 * Downloads ros-help.db.gz from the latest GitHub Release, decompresses it,
 * validates the DB, and prints config snippets for each MCP client.
 */

import { execSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { gunzipSync } from "bun";
import { detectMode, type InvocationMode, resolveBaseDir, resolveDbPath, resolveVersion, SCHEMA_VERSION } from "./paths.ts";

declare const REPO_URL: string;
const REPLACE_DB_TIMEOUT_MS = 30_000;

const GITHUB_REPO =
  typeof REPO_URL !== "undefined" ? REPO_URL : "tikoci/rosetta";
const RELEASE_VERSION = resolveVersion(import.meta.dirname);

/** Minimum byte counts for a healthy DB. Validation thresholds — keep loose so
 *  shrinking the dataset doesn't break startup, but tight enough to catch a
 *  redirect-to-login HTML page or a partial transfer. */
export const MIN_PAGES = 100;
export const MIN_COMMANDS = 1000;
const MIN_DECOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB
const SQLITE_MAGIC = "SQLite format 3\0";
const DOWNLOAD_LOCK_WAIT_MS = 90_000;
const DOWNLOAD_LOCK_POLL_MS = 250;
const DOWNLOAD_LOCK_STALE_MS = 15 * 60 * 1000;

type DbProbe = {
  schemaVersion: number;
  pages: number;
  commands: number;
  releaseTag: string | null;
};

export type DbFreshnessCheck = {
  /** A redownload should be attempted. */
  redownload: boolean;
  /** If the redownload attempt itself throws, is that fatal? True for a real
   *  schema mismatch (the on-disk shape is unqueryable). False for a
   *  release-tag-only mismatch — the existing DB is schema-current and fully
   *  queryable, so a failed refresh (e.g. offline) should degrade to "keep
   *  using it" rather than crash startup. */
  hardFailOnDownloadError: boolean;
  reason: string | null;
};

/**
 * Decide whether ensureDbReady() should redownload the DB, and whether a
 * failed redownload is fatal.
 *
 * Two independent triggers:
 *   - schemaVersion mismatch: the running code cannot query the on-disk
 *     shape at all — always fatal if recovery fails.
 *   - releaseTag mismatch (same schema, newer content published under a
 *     different version-pinned release — see dbDownloadUrls): the DB the
 *     bunx/global-install user has cached is stale relative to the package
 *     version bun just resolved. Non-fatal if recovery fails; the schema-
 *     current DB already on disk keeps working.
 *
 * Dev-mode DBs (running from a git checkout) are locally extracted and not
 * tied to any published release — their release_tag routinely drifts from
 * package.json's version (e.g. a leftover stamp from an old CI run) and must
 * never trigger a network fetch that would clobber a contributor's local DB.
 */
export function checkDbFreshness(
  probe: DbProbe,
  opts: { schemaVersion: number; runningVersion: string; mode: InvocationMode },
): DbFreshnessCheck {
  const schemaMismatch = probe.schemaVersion !== opts.schemaVersion;
  if (schemaMismatch) {
    return {
      redownload: true,
      hardFailOnDownloadError: true,
      reason: `DB schema mismatch: DB=${probe.schemaVersion}, expected=${opts.schemaVersion}.`,
    };
  }

  const expectedTag = `v${opts.runningVersion}`;
  const releaseMismatch = opts.mode !== "dev" && probe.releaseTag !== null && probe.releaseTag !== expectedTag;
  if (releaseMismatch) {
    return {
      redownload: true,
      hardFailOnDownloadError: false,
      reason: `DB content is stale: DB release=${probe.releaseTag}, running v${opts.runningVersion} expects ${expectedTag}.`,
    };
  }

  return { redownload: false, hardFailOnDownloadError: false, reason: null };
}

type SQLiteStatement = {
  get: (...params: unknown[]) => unknown;
  finalize: () => void;
};

type SQLiteDatabase = {
  prepare: (sql: string) => SQLiteStatement;
  close: () => void;
};

type SQLiteConstructor = new (path: string) => SQLiteDatabase;

type DownloadLockHandle = {
  fd: number;
  path: string;
};

/** Check if a DB file exists and has actual page data.
 *  Opens read-write — see probeDb's note: freshly written WAL-mode files can
 *  fail to open readonly on macOS when the .shm file is missing. */
function dbHasData(dbPath: string): boolean {
  return hasMinimumDbContent(probeDb(dbPath));
}

function looksLikeSqliteFile(dbPath: string): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(dbPath, "r");
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size < SQLITE_MAGIC.length) return false;

    const header = Buffer.alloc(SQLITE_MAGIC.length);
    const bytesRead = readSync(fd, header, 0, header.byteLength, 0);
    return bytesRead === header.byteLength && header.toString("utf8") === SQLITE_MAGIC;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // best-effort cleanup
      }
    }
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
  if (!looksLikeSqliteFile(dbPath)) return null;

  let check: SQLiteDatabase | null = null;
  try {
    const { default: sqlite } = require("bun:sqlite") as { default: SQLiteConstructor };
    check = new sqlite(dbPath);
    const ver = sqliteGet<{ user_version: number }>(check, "PRAGMA user_version");
    const pages = sqliteGet<{ c: number }>(check, "SELECT COUNT(*) AS c FROM pages");
    const cmds = sqliteGet<{ c: number }>(check, "SELECT COUNT(*) AS c FROM commands");
    let releaseTag: string | null = null;
    try {
      const meta = sqliteGet<{ value: string } | null>(check, "SELECT value FROM db_meta WHERE key = 'release_tag'");
      releaseTag = meta?.value ?? null;
    } catch {
      // db_meta missing — pre-v5 schema, leave releaseTag null
    }
    return {
      schemaVersion: ver.user_version,
      pages: pages.c,
      commands: cmds.c,
      releaseTag,
    };
  } catch {
    return null;
  } finally {
    if (check) {
      try {
        check.close();
      } catch {
        // best-effort cleanup; a failed probe should never leave a DB handle open
      }
    }
  }
}

function sqliteGet<T>(db: SQLiteDatabase, sql: string): T {
  const stmt = db.prepare(sql);
  try {
    return stmt.get() as T;
  } finally {
    stmt.finalize();
  }
}

export function hasMinimumDbContent(probe: DbProbe | null): probe is DbProbe {
  return !!probe && probe.pages >= MIN_PAGES && probe.commands >= MIN_COMMANDS;
}

export function isUsableDbProbe(probe: DbProbe | null): probe is DbProbe {
  return hasMinimumDbContent(probe) && probe.schemaVersion === SCHEMA_VERSION;
}

function lockPathFor(dbPath: string): string {
  return `${dbPath}.lock`;
}

function formatProbeSummary(probe: DbProbe): string {
  const tagInfo = probe.releaseTag ? ` (release ${probe.releaseTag})` : "";
  return `schema v${probe.schemaVersion}, ${probe.pages} pages, ${probe.commands} commands${tagInfo}`;
}

export function tryAcquireDownloadLock(dbPath: string): DownloadLockHandle | null {
  const lockPath = lockPathFor(dbPath);

  while (true) {
    try {
      const fd = openSync(lockPath, "wx");
      writeFileSync(
        fd,
        `${JSON.stringify({
          pid: process.pid,
          created_at: new Date().toISOString(),
          db_path: dbPath,
        })}\n`,
      );
      return { fd, path: lockPath };
    } catch (e) {
      const code = e instanceof Error && "code" in e ? e.code : undefined;
      if (code !== "EEXIST") throw e;

      let ageMs: number | null = null;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        ageMs = null;
      }

      if (ageMs !== null && ageMs > DOWNLOAD_LOCK_STALE_MS) {
        tryUnlink(lockPath);
        continue;
      }

      return null;
    }
  }
}

export function releaseDownloadLock(lock: DownloadLockHandle | null): void {
  if (!lock) return;
  try {
    closeSync(lock.fd);
  } catch {
    // best-effort cleanup
  }
  tryUnlink(lock.path);
}

export async function waitForUsableDb(
  dbPath: string,
  log: (msg: string) => void = console.log,
  timeoutMs = DOWNLOAD_LOCK_WAIT_MS,
): Promise<boolean> {
  const lockPath = lockPathFor(dbPath);
  const deadline = Date.now() + timeoutMs;
  let announced = false;

  while (Date.now() < deadline) {
    if (!existsSync(lockPath)) {
      return isUsableDbProbe(probeDb(dbPath));
    }

    if (!announced) {
      log(`  Another rosetta process is preparing ${dbPath}; waiting...`);
      announced = true;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await Bun.sleep(Math.min(remaining, DOWNLOAD_LOCK_POLL_MS));
  }

  return false;
}

function tryUnlinkDbSidecars(dbPath: string): void {
  tryUnlink(`${dbPath}-wal`);
  tryUnlink(`${dbPath}-shm`);
}

function cleanupDbArtifacts(dbPath: string): void {
  tryUnlinkDbSidecars(dbPath);
  tryUnlink(dbPath);
}

export function cleanupStaleTempArtifacts(dbPath: string, staleMs = DOWNLOAD_LOCK_STALE_MS): number {
  const dir = path.dirname(dbPath);
  const prefix = `${path.basename(dbPath)}.tmp.`;
  const now = Date.now();
  let removed = 0;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;

    const fullPath = path.join(dir, entry);
    try {
      const ageMs = now - statSync(fullPath).mtimeMs;
      if (ageMs <= staleMs) continue;
    } catch {
      continue;
    }

    try {
      unlinkSync(fullPath);
      removed++;
    } catch {
      // best-effort cleanup
    }
  }

  return removed;
}

export function cleanupAbandonedTempArtifacts(dbPath: string): number {
  if (existsSync(lockPathFor(dbPath))) {
    return cleanupStaleTempArtifacts(dbPath);
  }
  return cleanupStaleTempArtifacts(dbPath, -1);
}

function isReplaceRaceError(e: unknown): boolean {
  const code = e instanceof Error && "code" in e ? e.code : undefined;
  // Windows can return EBUSY, EPERM, or EEXIST when the source or destination is open.
  return code === "EBUSY" || code === "EEXIST" || code === "EPERM";
}

async function replaceDbFile(tmpPath: string, dbPath: string): Promise<void> {
  const deadline = Date.now() + REPLACE_DB_TIMEOUT_MS;
  let lastError: unknown = null;

  while (Date.now() <= deadline) {
    try {
      renameSync(tmpPath, dbPath);
      return;
    } catch (e) {
      if (!isReplaceRaceError(e)) throw e;
    }

    tryUnlink(dbPath);
    try {
      renameSync(tmpPath, dbPath);
      return;
    } catch (e) {
      if (!isReplaceRaceError(e)) throw e;
      lastError = e;
    }

    await Bun.sleep(250);
  }

  throw lastError;
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
 *   3. Write to <dbPath>.tmp.<pid>, probe it with SQLite, verify schema_version
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
): Promise<DbProbe> {
  let lock = tryAcquireDownloadLock(dbPath);
  if (!lock) {
    const reused = await waitForUsableDb(dbPath, log);
    if (reused) {
      const probe = probeDb(dbPath);
      if (probe) {
        log(`  Reused existing database: ${formatProbeSummary(probe)}`);
        return probe;
      }
    }

    // Re-probe once — the lock may have been released with a healthy DB
    const fallbackProbe = probeDb(dbPath);
    if (isUsableDbProbe(fallbackProbe)) {
      log(`  Reused existing database: ${formatProbeSummary(fallbackProbe)}`);
      return fallbackProbe;
    }

    lock = tryAcquireDownloadLock(dbPath);
    if (!lock) {
      throw new Error(
        `Timed out waiting for another rosetta process to finish preparing ${dbPath}. ` +
          `Close other rosetta clients and retry.`,
      );
    }
  }

  const urls = dbDownloadUrls(RELEASE_VERSION);
  let lastError: Error | null = null;

  try {
    const cleaned = cleanupStaleTempArtifacts(dbPath);
    if (cleaned > 0) {
      log(`  Removed ${cleaned} stale temp DB artifact${cleaned === 1 ? "" : "s"}.`);
    }

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
        cleanupDbArtifacts(tmpPath);
        lastError = new Error("Downloaded DB failed to open with SQLite");
        if (isLast) throw lastError;
        log(`  ${lastError.message} — trying fallback...`);
        continue;
      }
      if (probe.schemaVersion !== SCHEMA_VERSION) {
        cleanupDbArtifacts(tmpPath);
        lastError = new Error(
            `Downloaded DB schema=${probe.schemaVersion} does not match this rosetta build (expected ${SCHEMA_VERSION}). ` +
            `This usually means your MCP client is still using a cached older package version. ` +
          `Restart the MCP client to let bunx re-resolve the latest package, or run: bunx @tikoci/rosetta@latest --refresh`,
        );
        if (isLast) throw lastError;
        log(`  ${lastError.message}`);
        continue;
      }
      if (probe.pages < MIN_PAGES || probe.commands < MIN_COMMANDS) {
        cleanupDbArtifacts(tmpPath);
        lastError = new Error(
          `Downloaded DB content looks incomplete (pages=${probe.pages}, commands=${probe.commands})`,
        );
        if (isLast) throw lastError;
        log(`  ${lastError.message} — trying fallback...`);
        continue;
      }

      // Validation passed — drop stale WAL/SHM and atomically swap.
      try {
        tryUnlinkDbSidecars(tmpPath);
        tryUnlinkDbSidecars(dbPath);
        await replaceDbFile(tmpPath, dbPath);
      } catch (e) {
        const existingProbe = probeDb(dbPath);
        if (hasMinimumDbContent(existingProbe) && existingProbe.schemaVersion === probe.schemaVersion && existingProbe.releaseTag === probe.releaseTag) {
          cleanupDbArtifacts(tmpPath);
          log(`  Another rosetta process already installed the same database.`);
          log(`  Reused existing database: ${formatProbeSummary(existingProbe)}`);
          return existingProbe;
        }

        cleanupDbArtifacts(tmpPath);
        throw e;
      }

      const sizeMB = (decompressed.byteLength / 1024 / 1024).toFixed(1);
      const tagInfo = probe.releaseTag ? ` (release ${probe.releaseTag})` : "";
      log(`  Wrote ${sizeMB} MB to ${dbPath}${tagInfo}`);
      log(`  Validated: schema v${probe.schemaVersion}, ${probe.pages} pages, ${probe.commands} commands.`);
      return probe;
    }

    throw lastError ?? new Error("Database download failed for unknown reasons");
  } finally {
    releaseDownloadLock(lock);
  }
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
  let probe: DbProbe;
  try {
    probe = await downloadDb(dbPath, log);
  } catch (e) {
    log(`✗ Refresh failed: ${e instanceof Error ? e.message : e}`);
    return false;
  }
  const tagInfo = probe.releaseTag ? ` (release ${probe.releaseTag})` : "";
  log(`✓ Database ready${tagInfo}: ${probe.pages} pages, ${probe.commands} commands, schema v${probe.schemaVersion}`);
  return true;
}

export async function runSetup(force = false) {
  const mode = detectMode(import.meta.dirname);
  const dbPath = resolveDbPath(import.meta.dirname);
  let downloadedProbe: DbProbe | null = null;

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
      downloadedProbe = await downloadDb(dbPath);
    } catch (e) {
      console.error(`✗ Database download failed: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
  }

  // ── Validate DB ──
  console.log();
  const probe = downloadedProbe ?? probeDb(dbPath);
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
      `  Package may be out of date. Run: bunx @tikoci/rosetta@latest --refresh`,
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
