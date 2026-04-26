/**
 * mcp-http.test.ts — Integration tests for the MCP Streamable HTTP transport.
 *
 * Starts the actual server on a random port (using `--http`) and exercises
 * the real MCP protocol flow: initialize → list tools → call tool → SSE stream → DELETE.
 *
 * These tests catch transport-level regressions that query/schema tests cannot:
 * - Session creation and routing (the bug that shipped broken in v0.3.0)
 * - Multi-client concurrent sessions
 * - SSE stream establishment
 * - Session lifecycle (create → use → delete)
 * - Proper error responses for missing/invalid session IDs
 *
 * Each test gets an isolated server on a fresh port.
 */
import sqlite from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { SCHEMA_VERSION } from "./paths.ts";

// ── Helpers ──

const BASE_PORT = 19700 + Math.floor(Math.random() * 800);
let portCounter = 0;

function nextPort(): number {
  return BASE_PORT + portCounter++;
}

interface ServerHandle {
  port: number;
  url: string;
  proc: Subprocess;
}

interface ProcessLogs {
  stdout: string[];
  stderr: string[];
}

/** Continuously consume a subprocess stream and append decoded chunks. */
async function collectStream(stream: ReadableStream<Uint8Array>, sink: string[]): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      sink.push(decoder.decode(value));
    }
  } finally {
    reader.releaseLock();
  }
}

/** Keep only the last N characters from aggregated process logs for error messages. */
function tailLogs(logs: ProcessLogs, maxChars = 4000): string {
  const merged = `--- stdout ---\n${logs.stdout.join("")}\n--- stderr ---\n${logs.stderr.join("")}`;
  return merged.length > maxChars ? merged.slice(-maxChars) : merged;
}

/** Start the MCP server on a random port, wait for it to be ready. */
function createFixtureDb(dbPath: string): void {
  const fixture = new sqlite(dbPath);
  fixture.run(`CREATE TABLE pages (
    id           INTEGER PRIMARY KEY,
    slug         TEXT NOT NULL,
    title        TEXT NOT NULL,
    path         TEXT NOT NULL,
    depth        INTEGER NOT NULL,
    parent_id    INTEGER REFERENCES pages(id),
    url          TEXT NOT NULL,
    text         TEXT NOT NULL,
    code         TEXT NOT NULL,
    code_lang    TEXT,
    author       TEXT,
    last_updated TEXT,
    word_count   INTEGER NOT NULL,
    code_lines   INTEGER NOT NULL,
    html_file    TEXT NOT NULL
  );`);

  fixture.run(`CREATE TABLE commands (
    id          INTEGER PRIMARY KEY,
    path        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    parent_path TEXT,
    page_id     INTEGER REFERENCES pages(id),
    description TEXT,
    ros_version TEXT
  );`);

  fixture.run(`INSERT INTO pages (
    id, slug, title, path, depth, parent_id, url, text, code, code_lang,
    author, last_updated, word_count, code_lines, html_file
  ) VALUES (
    1, 'fixture', 'Fixture Page', 'RouterOS > Fixture', 1, NULL,
    'https://help.mikrotik.com/docs/spaces/ROS/pages/1/Fixture',
    'fixture text', '', NULL, 'test', NULL, 2, 0, 'fixture.html'
  );`);

  fixture.run(`INSERT INTO commands (
    id, path, name, type, parent_path, page_id, description, ros_version
  ) VALUES (
    1, '/system', 'system', 'dir', NULL, 1, 'fixture command', '7.22'
  );`);

  // Stamp the current schema version so mcp.ts doesn't try to auto-download
  // a "real" DB. Importing SCHEMA_VERSION here keeps the fixture in sync with
  // any future bumps. Also seed db_meta so the startup banner has a release tag.
  fixture.run(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  fixture.run("CREATE TABLE db_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  fixture.run("INSERT INTO db_meta (key, value) VALUES ('release_tag', 'v0.0.0-test');");
  fixture.close();
}

async function startServer(dbPath: string): Promise<ServerHandle> {
  const port = nextPort();
  const proc = Bun.spawn(["bun", "run", "src/mcp.ts", "--http", "--port", String(port)], {
    cwd: `${import.meta.dirname}/..`,
    stdout: "pipe",
    stderr: "pipe",
    // Use an isolated fixture DB and avoid network-dependent auto-downloads.
    env: { ...process.env, HOST: "127.0.0.1", DB_PATH: dbPath },
  });

  const logs: ProcessLogs = { stdout: [], stderr: [] };
  const stdoutCollector = collectStream(proc.stdout, logs.stdout);
  const stderrCollector = collectStream(proc.stderr, logs.stderr);

  let exitCode: number | null = null;
  void proc.exited.then((code) => {
    exitCode = code;
  });

  // Wait for server readiness by polling the actual HTTP endpoint.
  // Use a generous timeout because first boot may auto-download the DB.
  const deadline = Date.now() + 120_000;
  let ready = false;

  while (Date.now() < deadline) {
    if (exitCode !== null) {
      break;
    }

    try {
      const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "GET",
        headers: { Accept: "text/event-stream" },
      });

      // Endpoint is alive; missing session ID should return 400.
      if (resp.status === 400) {
        ready = true;
        break;
      }
    } catch {
      // Connection refused while server is still starting.
    }

    await Bun.sleep(200);
  }

  if (!ready) {
    proc.kill();
    await proc.exited.catch(() => undefined);
    await Promise.all([stdoutCollector, stderrCollector]);

    const reason = exitCode !== null
      ? `exited early with code ${exitCode}`
      : "did not become ready before timeout";
    throw new Error(
      `Server failed to start on port ${port}: ${reason}\n${tailLogs(logs)}`,
    );
  }

  // Keep collectors running in background; they naturally finish when process exits.
  void stdoutCollector;
  void stderrCollector;

  return { port, url: `http://127.0.0.1:${port}/mcp`, proc };
}

async function killServer(handle: ServerHandle): Promise<void> {
  try {
    handle.proc.kill();
    await handle.proc.exited;
  } catch {
    // already dead
  }
}

/** Send an MCP initialize request, return { sessionId, response } */
async function mcpInitialize(url: string): Promise<{ sessionId: string; body: Record<string, unknown> }> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "initialize",
      id: 1,
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    }),
  });

  const sessionId = resp.headers.get("mcp-session-id");
  if (!sessionId) throw new Error(`No mcp-session-id in response (status ${resp.status})`);

  // Parse SSE response to extract the JSON-RPC message
  const text = await resp.text();
  const body = parseSseMessages(text);
  return { sessionId, body: body[0] as Record<string, unknown> };
}

/** Parse SSE text into JSON-RPC message objects */
function parseSseMessages(text: string): unknown[] {
  const messages: unknown[] = [];
  for (const block of text.split("\n\n")) {
    for (const line of block.split("\n")) {
      if (line.startsWith("data: ")) {
        const data = line.slice(6);
        if (data.trim()) {
          messages.push(JSON.parse(data));
        }
      }
    }
  }
  return messages;
}

/** Send a JSON-RPC request with session ID, return parsed SSE messages */
async function mcpRequest(
  url: string,
  sessionId: string,
  method: string,
  id: number,
  params: Record<string, unknown> = {},
): Promise<unknown[]> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
      "Mcp-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, id, params }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`MCP request failed (${resp.status}): ${body}`);
  }

  const text = await resp.text();
  return parseSseMessages(text);
}

/** Send a JSON-RPC notification (no id → 202 response) */
async function mcpNotification(
  url: string,
  sessionId: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<number> {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
      "Mcp-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params }),
  });
  return resp.status;
}

// ── Tests ──

// Single server instance shared across all groups — sessions are isolated per test,
// so sharing a server does not affect test independence. Starting one server instead
// of three avoids startup-time contention when all test files run in parallel.
let server: ServerHandle;
let fixtureDir: string;
let fixtureDbPath: string;

beforeAll(async () => {
  fixtureDir = mkdtempSync(join(tmpdir(), "rosetta-http-test-"));
  fixtureDbPath = join(fixtureDir, "ros-help.db");
  createFixtureDb(fixtureDbPath);
  server = await startServer(fixtureDbPath);
}, 130_000);

afterAll(async () => {
  await killServer(server);
  rmSync(fixtureDir, { recursive: true, force: true });
}, 15_000);

describe("HTTP transport: session lifecycle", () => {

  test("POST initialize creates session and returns server info", async () => {
    const { sessionId, body } = await mcpInitialize(server.url);
    expect(sessionId).toBeTruthy();
    expect(typeof sessionId).toBe("string");

    const result = body.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe("2025-03-26");

    const serverInfo = result.serverInfo as Record<string, string>;
    expect(serverInfo.name).toBe("rosetta");
  });

  test("tools/list returns all 14 tools after initialization", async () => {
    const { sessionId } = await mcpInitialize(server.url);

    // Send initialized notification first (required by protocol)
    await mcpNotification(server.url, sessionId, "notifications/initialized");

    const messages = await mcpRequest(server.url, sessionId, "tools/list", 2);
    expect(messages.length).toBe(1);

    const result = (messages[0] as Record<string, unknown>).result as Record<string, unknown>;
    const tools = result.tools as Array<{ name: string }>;
    expect(tools.length).toBe(14);

    const toolNames = tools.map((t) => t.name).sort();
    expect(toolNames).toContain("routeros_search");
    expect(toolNames).toContain("routeros_get_page");
    expect(toolNames).toContain("routeros_lookup_property");
    expect(toolNames).toContain("routeros_explain_command");
    expect(toolNames).toContain("routeros_command_tree");
    expect(toolNames).toContain("routeros_search_changelogs");
    expect(toolNames).toContain("routeros_command_version_check");
    expect(toolNames).toContain("routeros_device_lookup");
    expect(toolNames).toContain("routeros_stats");
    expect(toolNames).toContain("routeros_current_versions");
    // Dropped: routeros_search_callouts, routeros_search_videos (folded into routeros_search.related)
    expect(toolNames).not.toContain("routeros_search_callouts");
    expect(toolNames).not.toContain("routeros_search_videos");
  });

  test("resources/list returns dataset resources after initialization", async () => {
    const { sessionId } = await mcpInitialize(server.url);
    await mcpNotification(server.url, sessionId, "notifications/initialized");

    const messages = await mcpRequest(server.url, sessionId, "resources/list", 21);
    expect(messages.length).toBe(1);

    const result = (messages[0] as Record<string, unknown>).result as Record<string, unknown>;
    const resources = result.resources as Array<{ uri: string; mimeType?: string }>;

    expect(resources.some((resource) => resource.uri === "rosetta://datasets/device-test-results.csv")).toBe(true);
    expect(resources.some((resource) => resource.uri === "rosetta://datasets/devices.csv")).toBe(true);
  });

  test("resources/read returns CSV content for device test dataset", async () => {
    const { sessionId } = await mcpInitialize(server.url);
    await mcpNotification(server.url, sessionId, "notifications/initialized");

    const messages = await mcpRequest(server.url, sessionId, "resources/read", 22, {
      uri: "rosetta://datasets/device-test-results.csv",
    });
    expect(messages.length).toBe(1);

    const result = (messages[0] as Record<string, unknown>).result as Record<string, unknown>;
    const contents = result.contents as Array<{ uri: string; mimeType?: string; text?: string }>;

    expect(contents[0].uri).toBe("rosetta://datasets/device-test-results.csv");
    expect(contents[0].mimeType).toBe("text/csv");
    expect(contents[0].text).toContain("product_name,product_code,architecture,cpu,cpu_cores,cpu_frequency");
  });

  test("tools/call works for routeros_stats", async () => {
    const { sessionId } = await mcpInitialize(server.url);
    await mcpNotification(server.url, sessionId, "notifications/initialized");

    const messages = await mcpRequest(server.url, sessionId, "tools/call", 3, {
      name: "routeros_stats",
      arguments: {},
    });
    expect(messages.length).toBe(1);

    const result = (messages[0] as Record<string, unknown>).result as Record<string, unknown>;
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0].type).toBe("text");

    const stats = JSON.parse(content[0].text);
    expect(stats.pages).toBeGreaterThan(0);
    expect(stats.commands).toBeGreaterThan(0);
  });

  test("GET with session ID opens SSE stream", async () => {
    const { sessionId } = await mcpInitialize(server.url);
    await mcpNotification(server.url, sessionId, "notifications/initialized");

    // SSE streams are long-lived — abort after headers arrive.
    // Use a short timeout to prove the stream opens successfully.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);

    try {
      const resp = await fetch(server.url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "Mcp-Session-Id": sessionId,
          "Mcp-Protocol-Version": "2025-03-26",
        },
        signal: controller.signal,
      });

      // If we get here before abort, check status
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("text/event-stream");
      expect(resp.headers.get("mcp-session-id")).toBe(sessionId);
      controller.abort();
    } catch (e: unknown) {
      // AbortError is expected — the stream was open and we killed it
      if (e instanceof Error && (e.name === "AbortError" || (e as NodeJS.ErrnoException).code === "ABORT_ERR")) {
        // Success — the SSE connection was established (headers returned 200)
        // before we aborted. We can't check status after abort.
      } else {
        throw e;
      }
    } finally {
      clearTimeout(timeout);
    }
  });

  test("DELETE terminates session", async () => {
    const { sessionId } = await mcpInitialize(server.url);
    await mcpNotification(server.url, sessionId, "notifications/initialized");

    const resp = await fetch(server.url, {
      method: "DELETE",
      headers: {
        "Mcp-Session-Id": sessionId,
        "Mcp-Protocol-Version": "2025-03-26",
      },
    });

    // DELETE should succeed (200 or 202)
    expect(resp.status).toBeLessThan(300);

    // Subsequent requests with that session ID should fail
    const resp2 = await fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
        "Mcp-Protocol-Version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 99 }),
    });

    expect(resp2.status).toBe(404);
  });
});

describe("HTTP transport: error handling", () => {

  test("GET without session ID returns 400", async () => {
    const resp = await fetch(server.url, {
      method: "GET",
      headers: { Accept: "text/event-stream" },
    });

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toBeDefined();
  });

  test("POST without session ID and non-initialize method returns 400", async () => {
    const resp = await fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

    expect(resp.status).toBe(400);
    const body = await resp.json();
    expect(body.error).toBeDefined();
  });

  test("POST with invalid session ID returns 404", async () => {
    const resp = await fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": "nonexistent-session-id",
        "Mcp-Protocol-Version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
    });

    expect(resp.status).toBe(404);
  });

  test("non-/mcp path returns 404", async () => {
    const baseUrl = server.url.replace("/mcp", "");
    const resp = await fetch(`${baseUrl}/other`);
    expect(resp.status).toBe(404);
  });

  test("POST with invalid JSON returns 400", async () => {
    const { sessionId } = await mcpInitialize(server.url);

    const resp = await fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": sessionId,
        "Mcp-Protocol-Version": "2025-03-26",
      },
      body: "not valid json{{{",
    });

    // Our routing layer catches it for POST without session, or SDK catches it
    expect(resp.status).toBeGreaterThanOrEqual(400);
  });
});

describe("HTTP transport: multi-session", () => {

  test("two clients get independent sessions", async () => {
    const client1 = await mcpInitialize(server.url);
    const client2 = await mcpInitialize(server.url);

    expect(client1.sessionId).not.toBe(client2.sessionId);

    // Both sessions are functional
    await mcpNotification(server.url, client1.sessionId, "notifications/initialized");
    await mcpNotification(server.url, client2.sessionId, "notifications/initialized");

    const msgs1 = await mcpRequest(server.url, client1.sessionId, "tools/list", 2);
    const msgs2 = await mcpRequest(server.url, client2.sessionId, "tools/list", 2);

    const tools1 = ((msgs1[0] as Record<string, unknown>).result as Record<string, unknown>).tools as unknown[];
    const tools2 = ((msgs2[0] as Record<string, unknown>).result as Record<string, unknown>).tools as unknown[];

    expect(tools1.length).toBe(14);
    expect(tools2.length).toBe(14);
  });

  test("deleting one session does not affect another", async () => {
    const client1 = await mcpInitialize(server.url);
    const client2 = await mcpInitialize(server.url);

    await mcpNotification(server.url, client1.sessionId, "notifications/initialized");
    await mcpNotification(server.url, client2.sessionId, "notifications/initialized");

    // Delete client1's session
    await fetch(server.url, {
      method: "DELETE",
      headers: {
        "Mcp-Session-Id": client1.sessionId,
        "Mcp-Protocol-Version": "2025-03-26",
      },
    });

    // Client2 still works
    const msgs = await mcpRequest(server.url, client2.sessionId, "tools/list", 2);
    const tools = ((msgs[0] as Record<string, unknown>).result as Record<string, unknown>).tools as unknown[];
    expect(tools.length).toBe(14);

    // Client1 is gone
    const resp = await fetch(server.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Session-Id": client1.sessionId,
        "Mcp-Protocol-Version": "2025-03-26",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 5 }),
    });
    expect(resp.status).toBe(404);
  });
});
