import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const configuredDbPath = process.env.TEST_DB_PATH?.trim();
const DB_PATH = configuredDbPath ? path.resolve(ROOT, configuredDbPath) : path.join(ROOT, "ros-help.db");
const hasTestDb = existsSync(DB_PATH);
const dbWasExplicitlyConfigured = Boolean(configuredDbPath);
const skipReason = `No populated test database at ${DB_PATH}; set TEST_DB_PATH or place ros-help.db at repo root to run this check.`;

function runOnce(
  args: string[],
  once = true,
  extraEnv: Record<string, string> = {},
): { exitCode: number | null; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(["bun", "src/browse.ts", ...(once ? ["--once"] : []), ...args], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH, ...extraEnv },
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
    test.each([".help", ".?", ".tools", ".instructions", ".resources", ".refs"])("%s emits JSON", (command) => {
      const r = runOnce([command]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain("\x1b");
      expect(JSON.parse(r.stdout)).toBeObject();
    });

    test.each([true, false])("missing primary with options fails (once=%s)", (once) => {
      const r = runOnce([".routeros_get_page", "max_length=4000"], once);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("Usage:");
    });

    test("piped missing primary fails without --once", () => {
      const r = runOnce([".routeros_search"], false);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("Usage:");
    });

    test("filter-only calls still succeed", () => {
      const r = runOnce([".routeros_device_lookup", "architecture=arm64", "limit=1"]);
      expect(r.exitCode).toBe(0);
      expect(() => JSON.parse(r.stdout)).not.toThrow();
    });

    test("tool invocation errors fail with diagnostics on stderr", () => {
      const r = runOnce([".routeros_search_tests", "limit=invalid"]);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain("Error invoking");
    });

    test(".routeros_stats prints pure JSON to stdout", () => {
      const r = runOnce([".routeros_stats"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain("\x1b");
      const parsed = JSON.parse(r.stdout);
      expect(typeof parsed.pages).toBe("number");
      expect(parsed.provenance).toBeObject();
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

    // Human commands degrade to plain text when stdout is piped (the harness
    // pipes, so stdout is never a TTY here) or when NO_COLOR is set; a TTY
    // keeps styled output. Dot-command JSON purity is covered above.
    test("piped human command emits no ANSI escapes", () => {
      const r = runOnce(["stats"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Database Statistics");
      expect(r.stdout).not.toContain("\x1b");
      expect(r.stderr).not.toContain("\x1b");
    });

    test("piped human search emits no ANSI escapes", () => {
      const r = runOnce(["search", "vrrp"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("vrrp");
      expect(r.stdout).not.toContain("\x1b");
    });

    test("NO_COLOR strips ANSI from human commands", () => {
      const r = runOnce(["stats"], true, { NO_COLOR: "1" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Database Statistics");
      expect(r.stdout).not.toContain("\x1b");
    });
  },
);
