#!/usr/bin/env bun
/**
 * bin/rosetta.js — Entry point for `bunx @tikoci/rosetta` and global installs.
 *
 * The server uses bun:sqlite and other Bun APIs, so it requires the Bun runtime.
 * The `bun` shebang matters: `bunx` honours a `node` shebang and runs the file under
 * Node, which made every launch print a wrong-runtime note and start a second
 * process (#175). Under Bun this imports src/mcp.ts directly, in one process.
 *
 * Under Node (only when started explicitly, e.g. `node bin/rosetta.js`), delegate
 * to `bun` quietly, and print install guidance only if Bun is missing.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, "..", "src", "mcp.ts");

if (typeof Bun !== "undefined") {
  await import(entry);
} else {
  const { spawn } = await import("node:child_process");
  const proc = spawn("bun", ["run", entry, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  proc.on("error", (err) => {
    if (err.code === "ENOENT") {
      console.error("rosetta requires Bun (bun:sqlite is not available in Node.js).\n");
      console.error("Install Bun, then use bunx instead of npx:\n");
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
