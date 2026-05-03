import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { EXPECTED_TOOLS } from "./mcp-contract.test.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const DB_PATH = path.join(ROOT, "ros-help.db");

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape matching requires control chars
  return s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

function runBrowseHelp(): string {
  if (!existsSync(DB_PATH)) {
    throw new Error(`Expected populated test database at ${DB_PATH}.`);
  }

  const proc = Bun.spawnSync(["bun", "src/browse.ts", "--once", ".help"], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH },
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      `browse --once .help failed (exit ${proc.exitCode})\nstdout:\n${proc.stdout.toString()}\n\nstderr:\n${proc.stderr.toString()}`,
    );
  }

  return proc.stdout.toString();
}

function extractToolDotCommands(helpOutput: string): string[] {
  const seen = new Set<string>();
  for (const line of stripAnsi(helpOutput).split("\n")) {
    const match = line.match(/^\s*\.(routeros_[a-z_]+)\b/);
    if (match) seen.add(match[1]);
  }
  return [...seen].sort();
}

describe("browse TUI ↔ MCP parity", () => {
  test("browse .help lists a dot-command for every MCP tool", () => {
    const actual = extractToolDotCommands(runBrowseHelp());
    expect(actual).toEqual([...EXPECTED_TOOLS].sort());
  });
});
