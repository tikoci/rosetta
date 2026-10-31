#!/usr/bin/env bun
/**
 * smoke-oci.ts — real MCP session against a rosetta HTTP endpoint.
 *
 * Usage: bun scripts/smoke-oci.ts <url> <version>
 *
 *   <url>      Full MCP endpoint URL, e.g. http://127.0.0.1:9803/mcp
 *   <version>  Expected release version, bare (0.12.0) or v-prefixed (v0.12.0)
 *
 * Runs initialize → tools/list → routeros_stats (provenance must equal
 * v<version>) → nonempty routeros_search. Exits 0 on success, 1 on any
 * protocol, tool, or provenance failure. Shared by #245 (RouterOS /app
 * integration, any reachable URL) and #246 (release OCI smoke).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CONNECT_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 120_000;

function usage(): never {
  console.error("Usage: bun scripts/smoke-oci.ts <url> <version>");
  console.error("  <url>      MCP endpoint, e.g. http://127.0.0.1:9803/mcp");
  console.error("  <version>  expected release version, e.g. 0.12.0");
  process.exit(2);
  throw new Error("unreachable");
}

async function withTimeout<T>(label: string, ms: number, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const [urlArg, versionArg] = process.argv.slice(2);
if (!urlArg || !versionArg) usage();

let url: URL;
try {
  url = new URL(urlArg);
} catch {
  console.error(`Invalid URL: ${urlArg}`);
  process.exit(2);
  throw new Error("unreachable");
}
const expectedTag = `v${versionArg.replace(/^v/, "")}`;
const client = new Client({ name: "rosetta-oci-smoke", version: "1" });

try {
  const started = Date.now();
  await withTimeout("MCP connect/initialize", CONNECT_TIMEOUT_MS, async () => {
    const transport = new StreamableHTTPClientTransport(url);
    await client.connect(transport);
  });
  console.log(`initialize: ok (${Date.now() - started}ms)`);

  const tools = await withTimeout("tools/list", CALL_TIMEOUT_MS, () => client.listTools());
  const names = (tools.tools ?? []).map((t) => t.name);
  console.log(`tools/list: ${names.length} tools (${names.join(", ")})`);
  for (const need of ["routeros_stats", "routeros_search"]) {
    if (!names.includes(need)) throw new Error(`tools/list is missing required tool: ${need}`);
  }

  const statsRes = await withTimeout("routeros_stats", CALL_TIMEOUT_MS, () =>
    client.callTool({ name: "routeros_stats", arguments: {} }),
  );
  if (statsRes.isError) throw new Error(`routeros_stats returned an error: ${JSON.stringify(statsRes).slice(0, 500)}`);
  const stats = JSON.parse((statsRes.content as { text: string }[])[0].text) as {
    provenance?: { release_tag?: string };
  };
  console.log(`provenance.release_tag: ${stats.provenance?.release_tag} (expected ${expectedTag})`);
  if (stats.provenance?.release_tag !== expectedTag) {
    throw new Error(`Provenance mismatch: got ${stats.provenance?.release_tag}, expected ${expectedTag}`);
  }

  const search = await withTimeout("routeros_search", CALL_TIMEOUT_MS, () =>
    client.callTool({ name: "routeros_search", arguments: { query: "firewall" } }),
  );
  if (search.isError) throw new Error(`routeros_search returned an error: ${JSON.stringify(search).slice(0, 500)}`);
  const text = (search.content as { text: string }[])[0].text;
  console.log(`routeros_search: ${text.length} chars`);
  if (text.length === 0) throw new Error("routeros_search returned empty content");

  console.log(`SMOKE OK: ${urlArg} serves ${expectedTag} (${Date.now() - started}ms)`);
} catch (error) {
  console.error(`SMOKE FAIL: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
