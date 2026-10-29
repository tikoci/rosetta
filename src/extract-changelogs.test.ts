// Set BEFORE imports that can transitively load db.ts
process.env.DB_PATH = ":memory:";

import { describe, expect, test } from "bun:test";

const { buildChangelogVersionSet, LEGACY_FORMATTED_V7_BASE_VERSIONS } = await import("./extract-changelogs.ts");

describe("buildChangelogVersionSet", () => {
  test("always includes legacy v7 baseline versions", () => {
    const versions = buildChangelogVersionSet(["7.22.1", "7.23beta2"]);

    for (const legacy of LEGACY_FORMATTED_V7_BASE_VERSIONS) {
      expect(versions).toContain(legacy);
    }
  });

  test("keeps existing known versions and de-duplicates overlaps", () => {
    const versions = buildChangelogVersionSet(["7.22.1", "7.2", "7.8"]);

    expect(versions).toContain("7.22.1");
    expect(versions.filter((v) => v === "7.2")).toHaveLength(1);
    expect(versions.filter((v) => v === "7.8")).toHaveLength(1);
  });

  test("includes live channel head versions so latest long-term patch is not missed", () => {
    const versions = buildChangelogVersionSet(["7.21.3", "7.22.1"], ["7.21.4", "7.22.1", "7.23rc1"]);

    expect(versions).toContain("7.21.4");
    expect(versions.filter((v) => v === "7.22.1")).toHaveLength(1);
    expect(versions).toContain("7.23rc1");
  });
});

const {
  evaluateChangelogOutcome,
  fetchChangelog,
  MAX_CONSECUTIVE_HARD_ERRORS,
  parseChannelHead,
} = await import("./extract-changelogs.ts");

describe("evaluateChangelogOutcome", () => {
  const healthy = { versionCount: 98, totalEntries: 6609, hardErrors: 0, missing: 2, abandoned: false };

  test("passes a healthy run (next.123 shape: 2 genuine 404s)", () => {
    expect(evaluateChangelogOutcome(healthy)).toBeNull();
  });

  test("fails an empty run — the #218 shape, where every fetch failed and the table was wiped", () => {
    expect(evaluateChangelogOutcome({ ...healthy, totalEntries: 0, hardErrors: 98, missing: 0 })).toContain("0 changelog entries");
  });

  test("fails a run abandoned on consecutive hard errors", () => {
    expect(evaluateChangelogOutcome({ ...healthy, abandoned: true })).toContain(`${MAX_CONSECUTIVE_HARD_ERRORS} consecutive`);
  });

  test("fails when more than 10% of versions hard-fail", () => {
    expect(evaluateChangelogOutcome({ ...healthy, hardErrors: 9 })).toBeNull();
    expect(evaluateChangelogOutcome({ ...healthy, hardErrors: 10 })).toContain("transport/HTTP errors");
  });

  test("fails when more than 15% of versions are missing or unparsed", () => {
    expect(evaluateChangelogOutcome({ ...healthy, missing: 14 })).toBeNull();
    expect(evaluateChangelogOutcome({ ...healthy, missing: 15 })).toContain("404'd or parsed");
  });
});

describe("fetchChangelog", () => {
  const fast = { attempts: 2, baseDelayMs: 1 };
  const stub = (handler: () => Response): typeof fetch => (async () => handler()) as unknown as typeof fetch;

  test("returns the body on 200", async () => {
    const result = await fetchChangelog("7.22", { ...fast, fetchImpl: stub(() => new Response("What's new in 7.22", { status: 200 })) });
    expect(result).toEqual({ status: "ok", text: "What's new in 7.22" });
  });

  test("classifies 404 as missing", async () => {
    expect(await fetchChangelog("7.11.3", { ...fast, fetchImpl: stub(() => new Response("", { status: 404 })) })).toEqual({ status: "missing" });
  });

  test("classifies a persistent 503 as an error, not a skip", async () => {
    expect(await fetchChangelog("7.22", { ...fast, fetchImpl: stub(() => new Response("", { status: 503 })) })).toEqual({ status: "error", detail: "HTTP 503" });
  });

  test("recovers when a transient 503 clears on retry", async () => {
    let calls = 0;
    const fetchImpl = stub(() => (++calls === 1 ? new Response("", { status: 503 }) : new Response("ok", { status: 200 })));
    expect(await fetchChangelog("7.22", { ...fast, fetchImpl })).toEqual({ status: "ok", text: "ok" });
    expect(calls).toBe(2);
  });

  test("classifies a network failure as an error", async () => {
    const fetchImpl = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const result = await fetchChangelog("7.22", { ...fast, fetchImpl });
    expect(result.status).toBe("error");
  });
});

describe("parseChannelHead", () => {
  test("drops the build timestamp upgrade.mikrotik.com appends", () => {
    expect(parseChannelHead("7.25 1792678320\n")).toBe("7.25");
  });

  test("still accepts a bare version", () => {
    expect(parseChannelHead("7.26beta4\n")).toBe("7.26beta4");
  });

  test("returns empty for an empty body", () => {
    expect(parseChannelHead("  \n")).toBe("");
  });
});
