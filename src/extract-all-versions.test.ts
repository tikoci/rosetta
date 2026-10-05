import { describe, expect, test } from "bun:test";
import { extractVersions, missingVersions, probeExists, type VersionInfo } from "./extract-all-versions.ts";

function version(v: string, deep = true): VersionInfo {
  return {
    version: v,
    channel: "stable",
    deepX86: deep ? `https://example.test/${v}/extra/deep-inspect.x86.json` : null,
    deepArm64: null,
    inspectPath: `https://example.test/${v}/extra/inspect.json`,
    hasExtra: true,
    hasDeepInspect: deep,
  };
}

describe("extractVersions", () => {
  test("returns every failed version and keeps extracting after a failure", () => {
    const versions = [version("7.15", false), version("7.16"), version("7.17")];
    const ran: string[][] = [];
    const failed = extractVersions(versions, versions[2], (cmd) => {
      ran.push(cmd);
      return cmd.includes("--version=7.15") ? 1 : 0;
    });
    expect(failed).toEqual(["7.15"]);
    expect(ran).toHaveLength(3);
  });

  test("returns an empty list when every child succeeds", () => {
    const versions = [version("7.16"), version("7.17")];
    expect(extractVersions(versions, versions[1], () => 0)).toEqual([]);
  });

  test("a child killed by a signal (null exit code) counts as failed", () => {
    const versions = [version("7.17")];
    expect(extractVersions(versions, versions[0], () => null)).toEqual(["7.17"]);
  });

  test("only the primary rebuilds; legacy versions go through extract-commands", () => {
    const versions = [version("7.15", false), version("7.17")];
    const ran: string[][] = [];
    extractVersions(versions, versions[1], (cmd) => {
      ran.push(cmd);
      return 0;
    });
    expect(ran[0]?.some((a) => a.endsWith("extract-commands.ts"))).toBe(true);
    expect(ran[0]).toContain("--accumulate");
    expect(ran[1]?.some((a) => a.endsWith("extract-schema.ts"))).toBe(true);
    expect(ran[1]).not.toContain("--accumulate");
  });
});

describe("missingVersions", () => {
  test("names expected versions with no command_versions rows", () => {
    expect(missingVersions(["7.14", "7.15", "7.16"], ["7.16", "7.14"])).toEqual(["7.15"]);
    expect(missingVersions(["7.16"], ["7.16", "7.99"])).toEqual([]);
  });
});

describe("probeExists", () => {
  function statuses(...codes: number[]) {
    const methods: string[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return new Response(null, { status: codes.shift() ?? 200 });
    }) as unknown as typeof fetch;
    return { methods, retry: { fetchImpl, baseDelayMs: 0 } };
  }

  test("a 200 HEAD means published", async () => {
    const { methods, retry } = statuses(200);
    expect(await probeExists("https://example.test/x.json", retry)).toBe(true);
    expect(methods).toEqual(["HEAD"]);
  });

  test("only a 404 means not published", async () => {
    expect(await probeExists("https://example.test/x.json", statuses(404).retry)).toBe(false);
  });

  test("a transient 503 retries instead of downgrading to legacy inspect.json", async () => {
    expect(await probeExists("https://example.test/x.json", statuses(503, 200).retry)).toBe(true);
  });

  test("a 5xx that outlasts the retries throws", async () => {
    await expect(probeExists("https://example.test/x.json", statuses(503, 503, 503, 503).retry)).rejects.toThrow("HTTP 503");
  });
});
