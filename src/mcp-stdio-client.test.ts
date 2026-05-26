/**
 * mcp-stdio-client.test.ts — Integration test for the real MCP stdio path.
 *
 * Spawns `bun src/mcp.ts` via the SDK's StdioClientTransport and exercises the
 * real client handshake, tool listing, tool calling, resource listing, and
 * shutdown flow. This catches stdout pollution and JSON-RPC framing bugs that
 * in-process tests cannot.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const configuredDbPath = process.env.TEST_DB_PATH?.trim();
const DB_PATH = configuredDbPath ? path.resolve(ROOT, configuredDbPath) : path.join(ROOT, "ros-help.db");
const hasTestDb = existsSync(DB_PATH);
const dbWasExplicitlyConfigured = Boolean(configuredDbPath);
const skipReason = `No populated test database at ${DB_PATH}; set TEST_DB_PATH or place ros-help.db at repo root to run this integration test.`;

const EXPECTED_TOOLS = [
  "routeros_search",
  "routeros_get_page",
  "routeros_lookup_property",
  "routeros_explain_command",
  "routeros_command_tree",
  "routeros_stats",
  "routeros_search_changelogs",
  "routeros_dude_search",
  "routeros_dude_get_page",
  "routeros_command_version_check",
  "routeros_command_diff",
  "routeros_device_lookup",
  "routeros_search_tests",
  "routeros_current_versions",
];

const FIXED_RESOURCE_URIS = [
  "rosetta://datasets/device-test-results.csv",
  "rosetta://datasets/devices.csv",
  "rosetta://schema-guide.md",
  "rosetta://schema.sql",
  "rosetta://skills",
];

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object.`);
  }
  return value as Record<string, unknown>;
}

function parseJsonToolResult(value: unknown): Record<string, unknown> {
  const result = asRecord(value, "tool result");
  if (!Array.isArray(result.content) || result.content.length === 0) {
    throw new Error("Expected tool result content[0] to exist.");
  }

  const firstContent = asRecord(result.content[0], "tool result content[0]");
  if (firstContent.type !== "text" || typeof firstContent.text !== "string") {
    throw new Error("Expected tool result content[0] to be text.");
  }

  return asRecord(JSON.parse(firstContent.text), "parsed tool JSON");
}

function buildDiagnostics(errors: Error[], stderr: string[]): string {
  const sections: string[] = [];
  if (errors.length > 0) {
    sections.push(`transport/client errors:\n${errors.map((error) => error.stack ?? error.message).join("\n\n")}`);
  }
  if (stderr.length > 0) {
    sections.push(`server stderr:\n${stderr.join("")}`);
  }
  return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

describe.skipIf(!hasTestDb && !dbWasExplicitlyConfigured)(
  hasTestDb || dbWasExplicitlyConfigured
    ? "stdio transport: real MCP client"
    : `stdio transport: real MCP client [skipped: ${skipReason}]`,
  () => {
  let client: Client | undefined;

  afterEach(async () => {
    if (client) {
      await client.close().catch(() => undefined);
      client = undefined;
    }
  });

  test("real stdio client lists tools, calls routeros_search, lists resources, and closes cleanly", async () => {
    if (!hasTestDb) {
      throw new Error(`Expected populated test database at ${DB_PATH}.`);
    }

    const transport = new StdioClientTransport({
      command: "bun",
      args: ["src/mcp.ts"],
      cwd: ROOT,
      env: { ...process.env, DB_PATH },
      stderr: "pipe",
    });

    const stderrChunks: string[] = [];
    transport.stderr?.on("data", (chunk) => {
      stderrChunks.push(chunk.toString());
    });

    const transportErrors: Error[] = [];
    let resolveClosed: () => void = () => {};
    const closeSeen = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let closeCount = 0;

    client = new Client({ name: "stdio-test-client", version: "1.0.0" });
    client.onerror = (error) => {
      transportErrors.push(error);
    };
    client.onclose = () => {
      closeCount += 1;
      resolveClosed();
    };

    await client.connect(transport);
    expect(client.getServerVersion()?.name).toBe("rosetta");

    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    expect(toolNames).toEqual([...EXPECTED_TOOLS].sort());

    const searchPayload = parseJsonToolResult(await client.callTool({
      name: "routeros_search",
      arguments: { query: "/ip/firewall/filter", limit: 3 },
    }));
    expect(Array.isArray(searchPayload.pages)).toBe(true);
    expect((searchPayload.pages as unknown[]).length).toBeGreaterThan(0);
    expect(searchPayload.related).toBeDefined();
    expect(typeof searchPayload.related).toBe("object");
    expect(Array.isArray(searchPayload.related)).toBe(false);
    expect(Object.keys(asRecord(searchPayload.related, "routeros_search.related")).length).toBeGreaterThan(0);

    const resources = await client.listResources();
    const fixedResourceUris = resources.resources
      .map((resource) => resource.uri)
      .filter((uri) => !uri.startsWith("rosetta://skills/"))
      .sort();
    expect(fixedResourceUris).toEqual([...FIXED_RESOURCE_URIS].sort());

    if (transportErrors.length > 0) {
      throw new Error(`Unexpected stdio transport/client error before close.${buildDiagnostics(transportErrors, stderrChunks)}`);
    }

    await client.close();
    client = undefined;
    await Promise.race([
      closeSeen,
      Bun.sleep(2_000).then(() => {
        throw new Error(`Timed out waiting for stdio client/server close.${buildDiagnostics(transportErrors, stderrChunks)}`);
      }),
    ]);

    expect(closeCount).toBe(1);
    if (transportErrors.length > 0) {
      throw new Error(`Unexpected stdio transport/client error during close.${buildDiagnostics(transportErrors, stderrChunks)}`);
    }
  }, 60_000);
});
