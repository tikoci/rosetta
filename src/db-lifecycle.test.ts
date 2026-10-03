/** Ownership + collection of package-managed DB generations (#151). Runs on macOS/Linux/Windows. */
import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireOwnership,
  collectGenerations,
  isDbLive,
  journalModeFromHeader,
  LEGACY_IDLE_MS,
  releaseOwnership,
  retireGeneration,
} from "./db-lifecycle.ts";

const temp = mkdtempSync(path.join(tmpdir(), "rosetta-lifecycle-"));
const windows = process.platform === "win32";
let seq = 0;
afterEach(() => releaseOwnership());
afterAll(() => rmSync(temp, { recursive: true, force: true }));

function freshDir(): string {
  const dir = path.join(temp, `d${seq++}`);
  mkdirSync(dir);
  return dir;
}

function generation(dir: string, name: string, mode: "DELETE" | "WAL" = "DELETE", ageDays = 0): string {
  const file = path.join(dir, name);
  const db = new Database(file);
  db.run(`PRAGMA journal_mode=${mode}`);
  db.run("CREATE TABLE IF NOT EXISTS t(x)");
  db.run("INSERT INTO t VALUES (1)");
  db.close();
  const when = new Date(Date.now() - ageDays * 86_400_000);
  utimesSync(file, when, when);
  return file;
}

/** Spawn a process that holds the proposed lifetime owner lock until killed. */
async function spawnOwner(file: string) {
  const code = `const {acquireOwnership}=await import(${JSON.stringify(path.join(import.meta.dirname, "db-lifecycle.ts"))});
    if(!acquireOwnership(${JSON.stringify(file)})) process.exit(3); console.log("ready"); setInterval(()=>{},1000);`;
  const child = Bun.spawn([process.execPath, "--eval", code], { stdout: "pipe" });
  const reader = child.stdout.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain("ready");
  return child;
}

test("downloaded files are recognised by header: rollback vs WAL", () => {
  const dir = freshDir();
  expect(journalModeFromHeader(generation(dir, "ros-help-1.0.0.db"))).toBe("rollback");
  expect(journalModeFromHeader(generation(dir, "ros-help-1.0.1.db", "WAL"))).toBe("wal");
  writeFileSync(path.join(dir, "junk.db"), "not sqlite");
  expect(journalModeFromHeader(path.join(dir, "junk.db"))).toBeNull();
});

test("a live owner in another process blocks retirement; kill -9 releases it", async () => {
  const file = generation(freshDir(), "ros-help-1.0.0.db");
  const owner = await spawnOwner(file);
  try {
    expect(isDbLive(file)).toBe(true);
    expect(retireGeneration(file)).toBe("live");
    expect(existsSync(file)).toBe(true);
  } finally {
    owner.kill(9);
    await owner.exited;
  }
  expect(isDbLive(file)).toBe(false);
  expect(retireGeneration(file)).toBe("retired");
  expect(readdirSync(path.dirname(file))).toEqual([]);
}, 20000);

test("retention keeps running + most recent idle; live, unmanaged, symlinked and WAL files are untouched", async () => {
  const dir = freshDir();
  generation(dir, "ros-help-1.0.0.db", "DELETE", 5);
  generation(dir, "ros-help-1.1.0.db", "DELETE", 3);
  generation(dir, "ros-help-1.2.0-next.4.db", "DELETE", 1); // most recent idle
  generation(dir, "ros-help-1.3.0.db", "DELETE", 9); // running
  const liveFile = generation(dir, "ros-help-0.9.0.db", "DELETE", 30);
  generation(dir, "ros-help-0.8.0.db", "WAL", 40); // pre-protocol / override-shaped: never eligible
  generation(dir, "ros-help-custom.db", "DELETE", 40); // not a managed name
  if (!windows) symlinkSync(path.join(dir, "ros-help-1.0.0.db"), path.join(dir, "ros-help-0.7.0.db"));
  const owner = await spawnOwner(liveFile);
  try {
    const result = collectGenerations(dir, "1.3.0");
    expect(result.kept).toEqual(["ros-help-1.2.0-next.4.db"]);
    expect(result.retired.sort()).toEqual(["ros-help-1.0.0.db", "ros-help-1.1.0.db"]);
    expect(result.live).toEqual(["ros-help-0.9.0.db"]);
    expect(result.skipped).toContain("ros-help-0.8.0.db");
    if (!windows) expect(result.skipped).toContain("ros-help-0.7.0.db");
    expect(readdirSync(dir).filter((f) => f.endsWith(".db")).sort()).toEqual([
      ...(windows ? [] : ["ros-help-0.7.0.db"]),
      "ros-help-0.8.0.db", "ros-help-0.9.0.db", "ros-help-1.2.0-next.4.db", "ros-help-1.3.0.db", "ros-help-custom.db",
    ]);
  } finally {
    owner.kill(9);
    await owner.exited;
  }
}, 20000);

test("concurrent collectors converge without errors", async () => {
  const dir = freshDir();
  for (let i = 0; i < 8; i++) generation(dir, `ros-help-1.0.${i}.db`, "DELETE", 10 - i);
  const code = `const {collectGenerations}=await import(${JSON.stringify(path.join(import.meta.dirname, "db-lifecycle.ts"))});
    collectGenerations(${JSON.stringify(dir)}, "2.0.0");`;
  const runs = [0, 1, 2].map(() => Bun.spawn([process.execPath, "--eval", code], { stderr: "pipe" }));
  for (const run of runs) expect(await run.exited).toBe(0);
  expect(readdirSync(dir).sort()).toEqual(["ros-help-1.0.7.db"]);
}, 20000);

test("legacy ros-help.db is removed only when the DB and its sidecars are all 14+ days quiet", () => {
  const dir = freshDir();
  const legacy = generation(dir, "ros-help.db", "WAL", 20);
  const old = new Date(Date.now() - LEGACY_IDLE_MS - 86_400_000);
  writeFileSync(`${legacy}-wal`, "");
  writeFileSync(`${legacy}-shm`, ""); // fresh: an old client started recently
  utimesSync(`${legacy}-wal`, old, old);
  expect(collectGenerations(dir, "2.0.0").legacyRemoved).toBe(false);
  expect(existsSync(legacy)).toBe(true);
  utimesSync(`${legacy}-shm`, old, old);
  expect(collectGenerations(dir, "2.0.0").legacyRemoved).toBe(true);
  expect(readdirSync(dir)).toEqual([]);
});

test("open-time race: a file retired before the first read makes acquisition re-resolve (POSIX)", () => {
  const file = generation(freshDir(), "ros-help-1.0.0.db");
  const acquired = acquireOwnership(file, { afterOpen: () => expect(retireGeneration(file)).toBe(windows ? "live" : "retired") });
  // POSIX: the collector won (no lock yet) → retirement-shaped failure → false.
  // Windows: the open handle blocks DeleteFile → acquisition proceeds on the intact file.
  expect(acquired).toBe(windows);
  expect(existsSync(file)).toBe(windows);
});

test("once the owner lock is held, a collector cannot retire the file", () => {
  const file = generation(freshDir(), "ros-help-1.0.0.db");
  expect(acquireOwnership(file, { afterLock: () => expect(retireGeneration(file)).toBe("live") })).toBe(true);
  expect(existsSync(file)).toBe(true);
});

test("non-retirement open errors are surfaced, not retried", () => {
  const file = path.join(freshDir(), "ros-help-1.0.0.db");
  writeFileSync(file, "x".repeat(4096));
  expect(() => acquireOwnership(file)).toThrow();
});

test("lock probes never create a missing file (a probe racing a deletion leaves nothing behind)", () => {
  const file = path.join(freshDir(), "ros-help-1.0.0.db");
  expect(() => isDbLive(file)).toThrow();
  expect(() => retireGeneration(file)).toThrow();
  expect(existsSync(file)).toBe(false);
});
