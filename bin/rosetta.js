#!/usr/bin/env node
/**
 * bin/rosetta.js — Entry point for `bunx @tikoci/rosetta` (and npx fallback).
 *
 * The server uses bun:sqlite and other Bun APIs, so it requires the Bun runtime.
 * When run under Bun (via bunx), this imports src/mcp.ts directly.
 * When run under Node (via npx), this spawns `bun` as a subprocess if available.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, "..", "src", "mcp.ts");

if (typeof Bun !== "undefined") {
  // Running under Bun — import TypeScript entry directly
  await import(entry);
} else {
  // Running under Node — try to delegate to Bun, but warn the user
  console.error("Note: rosetta requires the Bun runtime. Attempting to run via bun...");
  console.error();
  const { spawn } = await import("node:child_process");
  const proc = spawn("bun", ["run", entry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  proc.on("error", (err) => {
    if (err.code === "ENOENT") {
      console.error("rosetta requires Bun (bun:sqlite is not available in Node.js).\n");
      console.error("Recommended: install Bun, then use bunx instead of npx:\n");
      console.error("  curl -fsSL https://bun.sh/install | bash");
      console.error("  bunx @tikoci/rosetta --setup\n");
      console.error("Install Bun: https://bun.sh");
      process.exit(1);
    }
    console.error(`Failed to start bun: ${err.message}`);
    process.exit(1);
  });
  proc.on("exit", (code) => process.exit(code ?? 1));
}
