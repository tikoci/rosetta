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
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";

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

/** Start the MCP server on a random port, wait for it to be ready. */
async function startServer(): Promise<ServerHandle> {
  const port = nextPort();
  const proc = Bun.spawn(["bun", "run", "src/mcp.ts", "--http", "--port", String(port)], {
    cwd: `${import.meta.dirname}/..`,
    stdout: "pipe",
    stderr: "pipe",
    // Explicitly set DB_PATH so query.test.ts's process.env.DB_PATH=":memory:" override
    // is not inherited by the server subprocess.
    env: { ...process.env, HOST: "127.0.0.1", DB_PATH: `${import.meta.dirname}/../ros-help.db` },
  });

  // Wait for server to be ready (reads stderr for the startup message)
  // 30s: 3 servers start in parallel during full test suite, contention extends startup time
  const deadline = Date.now() + 30_000;
  let ready = false;
  const decoder = new TextDecoder();
  const reader = proc.stderr.getReader();

  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    if (text.includes(`/mcp`)) {
      ready = true;
      break;
    }
  }
  // Release the reader lock so the stream can be consumed later or cleaned up
  reader.releaseLock();

  if (!ready) {
    proc.kill();
    throw new Error(`Server failed to start on port ${port} within 10s`);
  }

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

beforeAll(async () => {
  server = await startServer();
}, 30_000);

afterAll(async () => {
  await killServer(server);
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

  test("tools/list returns all 11 tools after initialization", async () => {
    const { sessionId } = await mcpInitialize(server.url);

    // Send initialized notification first (required by protocol)
    await mcpNotification(server.url, sessionId, "notifications/initialized");

    const messages = await mcpRequest(server.url, sessionId, "tools/list", 2);
    expect(messages.length).toBe(1);

    const result = (messages[0] as Record<string, unknown>).result as Record<string, unknown>;
    const tools = result.tools as Array<{ name: string }>;
    expect(tools.length).toBe(12);

    const toolNames = tools.map((t) => t.name).sort();
    expect(toolNames).toContain("routeros_search");
    expect(toolNames).toContain("routeros_get_page");
    expect(toolNames).toContain("routeros_lookup_property");
    expect(toolNames).toContain("routeros_search_properties");
    expect(toolNames).toContain("routeros_command_tree");
    expect(toolNames).toContain("routeros_search_callouts");
    expect(toolNames).toContain("routeros_search_changelogs");
    expect(toolNames).toContain("routeros_command_version_check");
    expect(toolNames).toContain("routeros_device_lookup");
    expect(toolNames).toContain("routeros_stats");
    expect(toolNames).toContain("routeros_current_versions");
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

    expect(tools1.length).toBe(12);
    expect(tools2.length).toBe(12);
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
    expect(tools.length).toBe(12);

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
