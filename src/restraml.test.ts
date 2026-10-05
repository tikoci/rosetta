import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchWithRetry, loadJson } from "./restraml.ts";

const ROOT = join(import.meta.dirname, "..");

function readText(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf-8");
}

describe("restraml GitHub version discovery", () => {
  test("uses authenticated GitHub helper for API version discovery", () => {
    const src = readText("src/restraml.ts");

    expect(src).toContain('from "./github.ts"');
    expect(src).toContain("fetchGitHub(RESTRAML_API_CONTENTS_URL");
    expect(src).toContain("headers: githubApiHeaders()");
  });

  test("release.yml passes GITHUB_TOKEN to extract-all-versions", () => {
    const yml = readText(".github/workflows/release.yml");
    const commandIdx = yml.indexOf("Extract command tree");
    const devicesIdx = yml.indexOf("Extract devices");
    expect(commandIdx).toBeGreaterThanOrEqual(0);
    expect(devicesIdx).toBeGreaterThan(commandIdx);

    const block = yml.slice(commandIdx, devicesIdx);
    expect(block).toContain("GITHUB_TOKEN: $" + "{{ github.token }}");
    expect(block).toContain("bun run src/extract-all-versions.ts");
  });
});

describe("fetchWithRetry / loadJson", () => {
  function scripted(statuses: Array<number | Error>) {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const next = statuses.shift();
      if (next instanceof Error) throw next;
      return new Response(next === 200 ? '{"ok":true}' : "", { status: next });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  test("retries 503s and succeeds once the server recovers", async () => {
    const { calls, fetchImpl } = scripted([503, 503, 200]);
    const data = await loadJson("https://example.test/a.json", { fetchImpl, baseDelayMs: 0 });
    expect(data).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  test("retries network errors", async () => {
    const { calls, fetchImpl } = scripted([new Error("ECONNRESET"), 200]);
    await loadJson("https://example.test/a.json", { fetchImpl, baseDelayMs: 0 });
    expect(calls).toHaveLength(2);
  });

  test("retries when the body read fails after a 200", async () => {
    const calls: string[] = [];
    const bodies = ['{"trunc', '{"ok":true}'];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(bodies.shift(), { status: 200 });
    }) as unknown as typeof fetch;
    const data = await loadJson("https://example.test/a.json", { fetchImpl, baseDelayMs: 0 });
    expect(data).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  test("each attempt gets a timeout signal, and a timed-out attempt retries", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    let n = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      if (n++ === 0) throw new DOMException("The operation timed out.", "TimeoutError");
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await loadJson("https://example.test/a.json", { fetchImpl, baseDelayMs: 0 });
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  test("5xx and body failures share one attempt budget", async () => {
    const calls: string[] = [];
    const replies: Array<[number, string]> = [[503, ""], [200, '{"trunc'], [502, ""], [200, '{"also-trunc']];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      const [status, body] = replies.shift() ?? [200, "{}"];
      return new Response(body, { status });
    }) as unknown as typeof fetch;
    await expect(loadJson("https://example.test/a.json", { fetchImpl, baseDelayMs: 0 })).rejects.toThrow();
    expect(calls).toHaveLength(4);
  });

  test("a 404 fails at once, without retrying", async () => {
    const { calls, fetchImpl } = scripted([404, 200]);
    await expect(loadJson("https://example.test/a.json", { fetchImpl, baseDelayMs: 0 })).rejects.toThrow("HTTP 404");
    expect(calls).toHaveLength(1);
  });

  test("gives up after the last attempt and reports the final status", async () => {
    const { calls, fetchImpl } = scripted([503, 503, 502]);
    await expect(
      loadJson("https://example.test/a.json", { fetchImpl, baseDelayMs: 0, attempts: 3 }),
    ).rejects.toThrow("HTTP 502");
    expect(calls).toHaveLength(3);
  });

  test("returns the final response when retries run out on a 5xx", async () => {
    const { fetchImpl } = scripted([500, 503]);
    const response = await fetchWithRetry("https://example.test/a", {}, { fetchImpl, baseDelayMs: 0, attempts: 2 });
    expect(response.status).toBe(503);
  });
});
