import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const configuredDbPath = process.env.TEST_DB_PATH?.trim();
const DB_PATH = configuredDbPath ? path.resolve(ROOT, configuredDbPath) : path.join(ROOT, "ros-help.db");
const hasTestDb = existsSync(DB_PATH);
const dbWasExplicitlyConfigured = Boolean(configuredDbPath);
const skipReason = `No populated test database at ${DB_PATH}; set TEST_DB_PATH or place ros-help.db at repo root to run this check.`;

function runOnce(args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "src/browse.ts", "--once", ...args], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe.skipIf(!hasTestDb && !dbWasExplicitlyConfigured)(
  hasTestDb || dbWasExplicitlyConfigured
    ? "browse --once dot-commands are machine-readable"
    : `browse --once dot-commands are machine-readable [skipped: ${skipReason}]`,
  () => {
    test(".routeros_stats prints pure JSON to stdout", () => {
      const r = runOnce([".routeros_stats"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain("\x1b");
      const parsed = JSON.parse(r.stdout);
      expect(typeof parsed.pages).toBe("number");
      expect(parsed.provenance.release_tag).toBeString();
    });

    test(".routeros_search prints pure JSON to stdout", () => {
      const r = runOnce([".routeros_search", "vrrp", "limit=1"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain("\x1b");
      expect(JSON.parse(r.stdout).query).toBe("vrrp");
    });

    test("unknown dot-command exits non-zero with the error on stderr", () => {
      const r = runOnce([".routeros_bogus"]);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("Unknown MCP tool");
    });

    test("dot-command missing its primary arg exits non-zero with usage on stderr", () => {
      const r = runOnce([".routeros_search"]);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain("Usage:");
    });
  },
);
