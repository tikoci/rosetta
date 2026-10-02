#!/usr/bin/env bun
/** Release smoke: real installed clients, concurrent defaults, and a missing DB_PATH parent. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [currentArg, previousArg] = process.argv.slice(2);
if (!currentArg) throw new Error("Usage: bun scripts/smoke-install.ts <current-version> [previous-version]");
const current = currentArg.replace(/^v/, "");
const previous = previousArg?.replace(/^v/, "");
const temp = mkdtempSync(path.join(tmpdir(), "rosetta-install-smoke-"));
const clients: Client[] = [];

async function connect(version: string, dbPath = ""): Promise<Client> {
  const transport = new StdioClientTransport({ command: "bunx", args: [`@tikoci/rosetta@${version}`], env: { ...process.env, DB_PATH: dbPath }, stderr: "pipe" });
  transport.stderr?.on("data", chunk => process.stderr.write(chunk));
  const client = new Client({ name: "release-install-smoke", version: "1" });
  try { await client.connect(transport, { timeout: 180000 }); } catch (error) { await transport.close(); throw error; }
  clients.push(client);
  return client;
}

async function check(client: Client, version: string): Promise<void> {
  const result = await client.callTool({ name: "routeros_stats", arguments: {} });
  const stats = JSON.parse((result.content as { text: string }[])[0].text);
  if (stats.provenance.release_tag !== `v${version}`) throw new Error(`Expected v${version}, got ${stats.provenance.release_tag}`);
  const search = await client.callTool({ name: "routeros_search", arguments: { query: "firewall" } });
  if (search.isError) throw new Error(`Search failed for ${version}: ${JSON.stringify(search)}`);
}

try {
  const oldClient = previous ? await connect(previous) : undefined;
  const currentClient = await connect(current);
  for (let round = 0; round < 3; round++) {
    if (oldClient && previous) await check(oldClient, previous);
    await check(currentClient, current);
  }
  const nested = await connect(current, path.join(temp, "missing", "nested", "help.db"));
  await check(nested, current);
  console.log(`Verified startup/provenance/search for ${current}${previous ? ` alongside ${previous}` : ""}, plus nested DB_PATH.`);
} finally {
  for (const client of clients.reverse()) await client.close();
  rmSync(temp, { recursive: true, force: true });
}
