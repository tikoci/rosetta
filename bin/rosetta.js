#!/usr/bin/env node
/**
 * bin/rosetta.js — Entry point for `npx @tikoci/rosetta` and `bunx @tikoci/rosetta`.
 *
 * The server uses bun:sqlite and other Bun APIs, so it requires the Bun runtime.
 * When run under Bun (via bunx), this imports src/mcp.ts directly.
 * When run under Node (via npx), this spawns `bun run src/mcp.ts` as a subprocess.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, "..", "src", "mcp.ts");

if (typeof Bun !== "undefined") {
  // Running under Bun — import TypeScript entry directly
  await import(entry);
} else {
  // Running under Node — delegate to Bun subprocess
  const { spawn } = await import("node:child_process");
  const proc = spawn("bun", ["run", entry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  proc.on("error", (err) => {
    if (err.code === "ENOENT") {
      console.error("rosetta requires the Bun runtime (bun:sqlite is not available in Node.js).");
      console.error("Install Bun: https://bun.sh");
      process.exit(1);
    }
    process.exit(1);
  });
  proc.on("exit", (code) => process.exit(code ?? 1));
}
