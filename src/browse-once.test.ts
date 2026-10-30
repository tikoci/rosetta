import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

// `script(1)` allocates a pty so the child sees a TTY on stdout — the only way
// to prove the NO_COLOR branch does anything, since the harness always pipes.
// util-linux syntax, so Linux-only; this file runs on ubuntu-latest in CI.
const canFakeTty = process.platform === "linux" && existsSync("/usr/bin/script");

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function runOnceTty(
  args: string[],
  extraEnv: Record<string, string> = {},
): { exitCode: number | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, DB_PATH, ...extraEnv };
  // An ambient NO_COLOR must not leak into the styled-output assertion; tests
  // that need it pass it explicitly via extraEnv.
  if (!("NO_COLOR" in extraEnv)) delete env.NO_COLOR;
  const cmd = ["bun", "src/browse.ts", "--once", ...args].map(shellQuote).join(" ");
  const proc = Bun.spawnSync(["script", "-q", "-e", "-c", cmd, "/dev/null"], {
    cwd: ROOT,
    env,
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

    // The piped tests above pass even if the NO_COLOR branch is deleted (a pipe
    // is never a TTY), so this pair proves both halves under a pty instead.
    test.skipIf(!canFakeTty)("TTY keeps styled output without NO_COLOR", () => {
      const r = runOnceTty(["stats"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Database Statistics");
      expect(r.stdout).toContain("\x1b");
    });

    test.skipIf(!canFakeTty)("NO_COLOR strips ANSI even on a TTY", () => {
      const r = runOnceTty(["stats"], { NO_COLOR: "1" });
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("Database Statistics");
      expect(r.stdout).not.toContain("\x1b");
    });

    // Markdown + labeled-link plain fallbacks (page 1's lead lists child pages
    // as markdown links; page 170's prose has inline code spans).
    test("piped page renders labeled links as text (url)", () => {
      const r = runOnce(["page", "1"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("(https://manual.mikrotik.com/docs/");
      expect(r.stdout).not.toContain("\x1b");
    });

    test("piped page preserves inline code backticks", () => {
      const r = runOnce(["page", "170"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("`");
      expect(r.stdout).not.toContain("\x1b");
    });

    test.skipIf(!canFakeTty)("TTY page emits OSC8 hyperlinks", () => {
      const r = runOnceTty(["page", "1"]);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("\x1b]8;;");
    });
  },
);

// `--db <path>` is a global option: it must select the DB wherever it sits,
// including before the subcommand. DB_PATH outranks --db, so it is removed.
function runCli(args: string[]): { exitCode: number | null; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, ROSETTA_OFFLINE: "1" };
  delete env.DB_PATH;
  const proc = Bun.spawnSync(["bun", "src/mcp.ts", ...args], { cwd: ROOT, env, stdout: "pipe", stderr: "pipe" });
  return { exitCode: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe.skipIf(!hasTestDb && !dbWasExplicitlyConfigured)(
  hasTestDb || dbWasExplicitlyConfigured
    ? "--db is honored before, inside, and after the subcommand"
    : `--db is honored before, inside, and after the subcommand [skipped: ${skipReason}]`,
  () => {
    for (const args of [
      ["--db", DB_PATH, "browse", "--once", ".routeros_stats"],
      ["browse", "--db", DB_PATH, "--once", ".routeros_stats"],
      ["browse", "--once", ".routeros_stats", "--db", DB_PATH],
    ]) {
      test(args.join(" "), () => {
        const r = runCli(args);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout).provenance.db_path).toBe(DB_PATH);
      });
    }

    test("export skips the --db pair when it looks for its output directory", () => {
      const out = mkdtempSync(path.join(tmpdir(), "rosetta-export-db-"));
      try {
        const dir = path.join(out, "dataset");
        const r = runCli(["export", "--db", DB_PATH, dir]);
        expect(r.exitCode).toBe(0);
        expect(existsSync(path.join(dir, "manifest.toml"))).toBe(true);
      } finally {
        rmSync(out, { recursive: true, force: true });
      }
    }, 60_000);
  },
);
