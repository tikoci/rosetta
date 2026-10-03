/**
 * db-lifecycle.ts — ownership and cleanup of package-managed DB generations (#151).
 *
 * Package mode keeps one DB per exact version (`~/.rosetta/ros-help-<semver>.db`).
 * These files are rollback-journal mode and opened read-only, so SQLite's own
 * file locks prove liveness:
 *   - every client holds a read transaction on a separate owner connection for
 *     its whole lifetime (the OS drops the lock on any exit, including kill -9);
 *   - a collector may delete a generation only while holding BEGIN EXCLUSIVE,
 *     which it cannot get while any owner is alive.
 *
 * Deleting or renaming a live DB is unsafe in every open mode on macOS
 * (SQLITE_IOERR_VNODE), and WAL-mode clients are invisible to this probe, so
 * WAL files are never touched here. The legacy shared `ros-help.db` (WAL,
 * written by ≤0.11.2 on every startup) is retired only after 14 quiet days.
 */

import { Database } from "bun:sqlite";
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, renameSync, statSync, unlinkSync, utimesSync } from "node:fs";
import path from "node:path";
import { MANAGED_DB_PATTERN } from "./paths.ts";

export const LEGACY_DB_NAME = "ros-help.db";
export const LEGACY_IDLE_MS = 14 * 24 * 60 * 60 * 1000;
const RETIRING_MARKER = ".retiring-";

/** Owner connection, held open (with its read transaction) until process exit. */
let owner: Database | null = null;

/** SQLite header bytes 18/19: 1 = rollback journal, 2 = WAL. Read raw so probing never opens a WAL DB. */
export function journalModeFromHeader(dbPath: string): "rollback" | "wal" | null {
  let fd: number | null = null;
  try {
    fd = openSync(dbPath, "r");
    const header = Buffer.alloc(20);
    if (readSync(fd, header, 0, 20, 0) < 20) return null;
    if (header.subarray(0, 16).toString("latin1") !== "SQLite format 3\0") return null;
    if (header[18] === 1 && header[19] === 1) return "rollback";
    if (header[18] === 2 || header[19] === 2) return "wal";
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/** Convert a private staging file to rollback-journal mode before it is published. */
export function convertToRollbackJournal(dbPath: string): void {
  const conn = new Database(dbPath);
  try {
    conn.run("PRAGMA journal_mode=DELETE");
  } finally {
    conn.close();
  }
}

function errorCode(e: unknown): string {
  return e instanceof Error && "code" in e ? String(e.code) : "";
}

/** Another connection holds a lock. Same-process conflicts surface as IOERR_LOCK rather than BUSY. */
function isLockConflict(e: unknown): boolean {
  const code = errorCode(e);
  return code.startsWith("SQLITE_BUSY") || code === "SQLITE_IOERR_LOCK";
}

/** The file disappeared under us — another collector retired it first. */
function isVanished(e: unknown): boolean {
  const code = errorCode(e);
  return code === "ENOENT" || code.startsWith("SQLITE_CANTOPEN");
}

/** Errors that mean "a collector retired this file while we were opening it". */
function isRetirementError(e: unknown): boolean {
  const code = errorCode(e);
  return code === "ENOENT" || code === "SQLITE_IOERR_VNODE" || code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_CANTOPEN")
    || (e instanceof Error && e.message === "inode changed during open");
}

/**
 * Take a lifetime read lock on a managed generation. Returns false when the file
 * was retired mid-acquisition — the caller re-resolves (re-downloads) and retries.
 * Any other failure is thrown.
 */
export function acquireOwnership(
  dbPath: string,
  hooks: { afterOpen?: () => void; afterLock?: () => void } = {},
): boolean {
  if (owner) return true;
  let conn: Database | null = null;
  try {
    const before = statSync(dbPath).ino;
    // Mark as most recently used first, so a concurrent collector keeps it.
    const now = new Date();
    utimesSync(dbPath, now, now);
    conn = new Database(dbPath, { readonly: true });
    hooks.afterOpen?.();
    conn.run("PRAGMA busy_timeout=2000");
    conn.run("BEGIN");
    conn.query("SELECT count(*) FROM sqlite_master").get();
    hooks.afterLock?.();
    if (statSync(dbPath).ino !== before) throw new Error("inode changed during open");
    owner = conn;
    return true;
  } catch (e) {
    try {
      conn?.close();
    } catch {
      // partial handle from a retired file
    }
    if (isRetirementError(e)) return false;
    throw e;
  }
}

/** Test hook: drop this process's owner lock. */
export function releaseOwnership(): void {
  owner?.close();
  owner = null;
}

/**
 * Lock probes wait briefly: another collector holds EXCLUSIVE for milliseconds,
 * a live owner holds its read lock for its whole lifetime. Never creates a
 * missing file — a probe racing a deletion must not leave an empty DB behind.
 */
const PROBE_WAIT_MS = 250;
function openProbe(dbPath: string): Database {
  const probe = new Database(dbPath, { readwrite: true });
  probe.run(`PRAGMA busy_timeout=${PROBE_WAIT_MS}`);
  return probe;
}

/** True when another connection holds a lock on a rollback-mode DB. */
export function isDbLive(dbPath: string): boolean {
  const probe = openProbe(dbPath);
  try {
    probe.run("BEGIN EXCLUSIVE");
    probe.run("ROLLBACK");
    return false;
  } catch (e) {
    if (isLockConflict(e)) return true;
    throw e;
  } finally {
    probe.close();
  }
}

function unlinkIfPresent(p: string): void {
  try {
    unlinkSync(p);
  } catch (e) {
    if (errorCode(e) !== "ENOENT") throw e;
  }
}

/**
 * Run `move` while holding EXCLUSIVE on `dbPath`, so no owner can lock the file
 * between the liveness check and the move. Returns "live" without running it
 * when another connection holds a lock. POSIX only: Windows cannot rename a file
 * this process has open.
 */
export function moveUnderExclusiveLock(dbPath: string, move: () => void): "moved" | "live" {
  const probe = openProbe(dbPath);
  try {
    try {
      probe.run("BEGIN EXCLUSIVE");
    } catch (e) {
      if (isLockConflict(e)) return "live";
      throw e;
    }
    move();
    probe.run("ROLLBACK");
    return "moved";
  } finally {
    probe.close();
  }
}

/**
 * Delete an idle generation. POSIX renames it aside under EXCLUSIVE, then
 * unlinks. Windows closes the probe and relies on DeleteFile failing while any
 * other handle is open.
 */
export function retireGeneration(dbPath: string): "retired" | "live" {
  const windows = process.platform === "win32";
  const retiringPath = `${dbPath}${RETIRING_MARKER}${process.pid}`;
  if (windows) {
    if (isDbLive(dbPath)) return "live";
  } else if (moveUnderExclusiveLock(dbPath, () => renameSync(dbPath, retiringPath)) === "live") {
    return "live";
  }
  try {
    unlinkSync(windows ? dbPath : retiringPath);
  } catch (e) {
    if (windows && ["EBUSY", "EPERM", "EACCES"].includes(errorCode(e))) return "live";
    throw e;
  }
  for (const sidecar of ["-journal", "-wal", "-shm"]) unlinkIfPresent(`${dbPath}${sidecar}`);
  return "retired";
}

export type CollectResult = {
  retired: string[];
  /** Live generations, never counted against retention. */
  live: string[];
  kept: string[];
  /** Managed-looking files outside the protocol (WAL mode, symlinks, unreadable headers). */
  skipped: string[];
  legacyRemoved: boolean;
  bytesFreed: number;
};

/**
 * Keep the running version plus the most recently used idle generation; retire
 * other idle generations. Never throws for a single file — failures are skipped
 * and retried on a later startup.
 */
export function collectGenerations(dir: string, runningVersion: string, now = Date.now()): CollectResult {
  const result: CollectResult = { retired: [], live: [], kept: [], skipped: [], legacyRemoved: false, bytesFreed: 0 };
  const entries = readdirSync(dir);

  // A collector that crashed between rename and unlink leaves an unreachable file.
  for (const name of entries) {
    if (name.includes(RETIRING_MARKER) && MANAGED_DB_PATTERN.test(name.slice(0, name.indexOf(RETIRING_MARKER)))) {
      try {
        unlinkSync(path.join(dir, name));
      } catch {
        // retried next startup
      }
    }
  }

  const idle: { name: string; file: string; mtimeMs: number; size: number }[] = [];
  for (const name of entries) {
    const version = MANAGED_DB_PATTERN.exec(name)?.[1];
    if (!version || version === runningVersion) continue;
    const file = path.join(dir, name);
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || journalModeFromHeader(file) !== "rollback" || existsSync(`${file}-wal`)) {
        result.skipped.push(name);
        continue;
      }
      if (isDbLive(file)) {
        result.live.push(name);
        continue;
      }
      idle.push({ name, file, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (e) {
      if (!isVanished(e)) result.skipped.push(name);
    }
  }

  idle.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const [i, gen] of idle.entries()) {
    if (i === 0) {
      result.kept.push(gen.name);
      continue;
    }
    try {
      if (retireGeneration(gen.file) === "retired") {
        result.retired.push(gen.name);
        result.bytesFreed += gen.size;
      } else {
        result.live.push(gen.name);
      }
    } catch (e) {
      if (!isVanished(e)) result.skipped.push(gen.name);
    }
  }

  const legacy = path.join(dir, LEGACY_DB_NAME);
  const legacyFiles = [legacy, `${legacy}-wal`, `${legacy}-shm`].filter((f) => existsSync(f));
  try {
    if (legacyFiles.includes(legacy) && legacyFiles.every((f) => now - statSync(f).mtimeMs > LEGACY_IDLE_MS)) {
      const size = statSync(legacy).size;
      for (const f of legacyFiles) unlinkIfPresent(f);
      result.legacyRemoved = true;
      result.bytesFreed += size;
    }
  } catch {
    // retried next startup
  }

  return result;
}

export function formatCollectResult(r: CollectResult): string | null {
  const parts: string[] = [];
  const removed = r.retired.length + (r.legacyRemoved ? 1 : 0);
  if (removed > 0) parts.push(`removed ${removed} old database${removed === 1 ? "" : "s"} (${(r.bytesFreed / 1024 / 1024).toFixed(0)} MB)`);
  if (r.live.length > 0) parts.push(`${r.live.length} in use by other clients`);
  if (r.skipped.length > 0) parts.push(`skipped ${r.skipped.join(", ")}`);
  return parts.length > 0 ? `DB cleanup: ${parts.join("; ")}.` : null;
}
