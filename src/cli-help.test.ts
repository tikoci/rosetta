import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const INTENTIONAL_OMISSIONS = new Set<string>();
const REQUIRED_ENVIRONMENT_HELP = [
  "ROSETTA_OFFLINE=1  Skip DB freshness network checks (fall back to existing DB)",
];

function readText(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), "utf-8");
}

function normalizeEntry(value: string): string {
  const trimmed = value.trim().replace(/^`|`$/g, "");
  return trimmed === "*(none)*" ? "(none)" : trimmed;
}

function readManualCliFlags(): string[] {
  const manual = readText("MANUAL.md");
  const sectionMatch = manual.match(/## CLI Flags\n\n([\s\S]*?)\n## /);
  if (!sectionMatch) {
    throw new Error("Could not locate CLI Flags table in MANUAL.md.");
  }

  const entries = new Set<string>();
  for (const line of sectionMatch[1].split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim()).filter(Boolean);
    if (cells.length < 2) continue;
    if (cells[0] === "Flag" || /^-+$/.test(cells[0])) continue;
    entries.add(normalizeEntry(cells[0]));
  }
  return [...entries].sort();
}

function runHelp(): string {
  const proc = Bun.spawnSync(["bun", "src/mcp.ts", "--help"], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      `src/mcp.ts --help failed (exit ${proc.exitCode})\nstdout:\n${proc.stdout.toString()}\n\nstderr:\n${proc.stderr.toString()}`,
    );
  }

  return proc.stdout.toString();
}

function readHelpCliEntries(helpText: string): string[] {
  const entries = new Set<string>();

  for (const line of helpText.split("\n")) {
    const usageMatch = line.match(/^\s*rosetta(?:\s+(.*?))?\s{2,}\S/);
    if (usageMatch) {
      const command = usageMatch[1]?.trim() ?? "";
      entries.add(command === "" ? "(none)" : command);
      continue;
    }

    const optionMatch = line.match(/^\s*(--[a-z-]+(?: <[^>]+>)?)\s{2,}\S/);
    if (optionMatch) {
      entries.add(optionMatch[1]);
    }
  }

  return [...entries].sort();
}

describe("CLI help ↔ MANUAL flag parity", () => {
  test("MANUAL CLI Flags table matches src/mcp.ts --help", () => {
    const documented = readManualCliFlags().filter((entry) => !INTENTIONAL_OMISSIONS.has(entry));
    const fromHelp = readHelpCliEntries(runHelp()).filter((entry) => !INTENTIONAL_OMISSIONS.has(entry));

    expect(fromHelp).toEqual(documented);
  });

  test("--help retains the ROSETTA_OFFLINE safety hint", () => {
    const help = runHelp();
    for (const line of REQUIRED_ENVIRONMENT_HELP) {
      expect(help).toContain(line);
    }
  });
});
