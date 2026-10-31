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
 * v<version>) → routeros_search → routeros_get_page (chained from the first
 * search result's id, no hardcoded ids) → routeros_command_tree /ip/firewall
 * → routeros_device_lookup RB5009. Each call exercises a different table and
 * code path, so "it started" can't pass for "it works". Exits 0 on success, 1
 * on any protocol, tool, or provenance failure. Shared by #245 (RouterOS /app
 * integration, any reachable URL) and #246 (release OCI smoke).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const CONNECT_TIMEOUT_MS = 120_000;
const CALL_TIMEOUT_MS = 120_000;

/** Count result pages in a routeros_search response; metadata alone counts zero. */
export function searchPageCount(responseText: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("routeros_search returned non-JSON content");
  }
  const pages = (parsed as { pages?: unknown }).pages;
  return Array.isArray(pages) ? pages.length : 0;
}

/** First result id in a routeros_search response, for the chained get_page call. */
export function firstSearchPageId(responseText: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("routeros_search returned non-JSON content");
  }
  const pages = (parsed as { pages?: unknown }).pages;
  const id = Array.isArray(pages) ? (pages[0] as { id?: unknown } | undefined)?.id : undefined;
  if (typeof id !== "number") throw new Error("routeros_search first result has no numeric id");
  return id;
}

/** Text + code length in a routeros_get_page response (TOC shape counts zero here). */
export function pageTextLength(responseText: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("routeros_get_page returned non-JSON content");
  }
  const page = parsed as { text?: unknown; code?: unknown };
  return (typeof page.text === "string" ? page.text.length : 0) + (typeof page.code === "string" ? page.code.length : 0);
}

/** Section entries in a routeros_get_page response (large pages answer a TOC). */
export function pageSectionCount(responseText: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("routeros_get_page returned non-JSON content");
  }
  const sections = (parsed as { sections?: unknown }).sections;
  return Array.isArray(sections) ? sections.length : 0;
}

/**
 * Children in a routeros_command_tree response. The tool answers plain prose
 * ("No commands found under: …") when empty — that counts zero, not an error.
 */
export function commandTreeChildCount(responseText: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return 0;
  }
  return Array.isArray(parsed) ? parsed.length : 0;
}

/**
 * Devices in a routeros_device_lookup response (matrix results + catalog rows).
 * The tool answers plain prose ("No devices matched…") on a hard miss — zero.
 */
export function deviceLookupCount(responseText: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return 0;
  }
  const result = parsed as { results?: unknown; catalog?: unknown };
  return (Array.isArray(result.results) ? result.results.length : 0) + (Array.isArray(result.catalog) ? result.catalog.length : 0);
}

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

async function main(): Promise<void> {
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
    for (const need of ["routeros_stats", "routeros_search", "routeros_get_page", "routeros_command_tree", "routeros_device_lookup"]) {
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
      client.callTool({ name: "routeros_search", arguments: { query: "firewall filter" } }),
    );
    if (search.isError) throw new Error(`routeros_search returned an error: ${JSON.stringify(search).slice(0, 500)}`);
    const text = (search.content as { text: string }[])[0].text;
    const pageCount = searchPageCount(text);
    console.log(`routeros_search: ${pageCount} pages (${text.length} chars)`);
    if (pageCount === 0) throw new Error("routeros_search returned zero pages");
    const firstId = firstSearchPageId(text);

    const page = await withTimeout("routeros_get_page", CALL_TIMEOUT_MS, () =>
      client.callTool({ name: "routeros_get_page", arguments: { page: String(firstId) } }),
    );
    if (page.isError) throw new Error(`routeros_get_page returned an error: ${JSON.stringify(page).slice(0, 500)}`);
    const pageText = (page.content as { text: string }[])[0].text;
    const textLength = pageTextLength(pageText);
    const sectionCount = pageSectionCount(pageText);
    console.log(`routeros_get_page: id=${firstId} text=${textLength} chars sections=${sectionCount}`);
    if (textLength === 0 && sectionCount === 0) throw new Error(`routeros_get_page id=${firstId} returned empty content`);

    const tree = await withTimeout("routeros_command_tree", CALL_TIMEOUT_MS, () =>
      client.callTool({ name: "routeros_command_tree", arguments: { path: "/ip/firewall" } }),
    );
    if (tree.isError) throw new Error(`routeros_command_tree returned an error: ${JSON.stringify(tree).slice(0, 500)}`);
    const treeText = (tree.content as { text: string }[])[0].text;
    const childCount = commandTreeChildCount(treeText);
    console.log(`routeros_command_tree: /ip/firewall has ${childCount} children`);
    if (childCount === 0) throw new Error("routeros_command_tree /ip/firewall returned zero children");

    const device = await withTimeout("routeros_device_lookup", CALL_TIMEOUT_MS, () =>
      client.callTool({ name: "routeros_device_lookup", arguments: { query: "RB5009" } }),
    );
    if (device.isError) throw new Error(`routeros_device_lookup returned an error: ${JSON.stringify(device).slice(0, 500)}`);
    const deviceText = (device.content as { text: string }[])[0].text;
    const deviceCount = deviceLookupCount(deviceText);
    console.log(`routeros_device_lookup: RB5009 matched ${deviceCount} devices`);
    if (deviceCount === 0) throw new Error("routeros_device_lookup RB5009 matched zero devices");

    console.log(`SMOKE OK: ${urlArg} serves ${expectedTag} (${Date.now() - started}ms)`);
  } catch (error) {
    console.error(`SMOKE FAIL: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

if (import.meta.main) {
  await main();
}
