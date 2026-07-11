// Set BEFORE importing extract-hardware-catalog.ts (which transitively imports db.ts).
process.env.DB_PATH = ":memory:";

import { describe, expect, test } from "bun:test";
import { slugify } from "./assess-hardware.ts";
import type { HardwarePage } from "./extract-hardware-catalog.ts";

const { buildCatalog, computeValidationStats, checkBaseline, writeCatalog } = await import("./extract-hardware-catalog.ts");
const { db, initDb } = await import("./db.ts");

// ── Fixture helpers ──────────────────────────────────────────────────────────

function mkMatrixRow(name: string, code: string) {
  const subCodes = code.split("&").map((c) => c.trim());
  return { name, code, subCodes, nameSlug: slugify(name), codeSlugs: subCodes.map(slugify) };
}

function mkPage(overrides: Partial<HardwarePage> & { slug: string }): HardwarePage {
  return {
    title: overrides.slug,
    productLinks: [],
    tableModelCodes: [],
    category: null,
    cause: "unmatched",
    matchedMatrixNames: [],
    ...overrides,
  } as HardwarePage;
}

function mkWww(code: string, overrides: Partial<{ title: string; tagline: string; discontinued: boolean; compareId: string; specs: Record<string, string> }> = {}) {
  return {
    code,
    title: overrides.title ?? code,
    tagline: overrides.tagline ?? "",
    discontinued: overrides.discontinued ?? false,
    compareId: overrides.compareId ?? code,
    specs: overrides.specs ?? { "Product code": code },
  };
}

// ── buildCatalog ─────────────────────────────────────────────────────────────

describe("buildCatalog — single-match devices-linked row", () => {
  test("links devices_id, records source slugs, and resolves specs via a www code that differs from the requested link (cap_ac case)", () => {
    const matrixRows = [mkMatrixRow("cAP ac", "RBcAPGi-5acD2nD")];
    const devicesByName = new Map([["cAP ac", 42]]);
    const pages = [
      mkPage({ slug: "cap-ac", productLinks: ["cap_ac"], matchedMatrixNames: ["cAP ac"], cause: "matched-by-slug", category: "Indoor wireless" }),
    ];
    const wwwProducts = [mkWww("cap_ac", { specs: { "Product code": "RBcAPGi-5acD2nD", CPU: "IPQ-4019" } })];

    const result = buildCatalog(matrixRows, devicesByName, pages, wwwProducts);

    expect(result.catalogRows).toHaveLength(1);
    const row = result.catalogRows[0];
    expect(row.rosettaDeviceId).toBe("cap-ac");
    expect(row.devicesId).toBe(42);
    expect(row.category).toBe("Indoor wireless");
    expect(row.sourceHardwareSlug).toBe("cap-ac");
    expect(row.sourceWwwCode).toBe("cap_ac");
    expect(JSON.parse(row.specsJson ?? "{}")).toMatchObject({ "Product code": "RBcAPGi-5acD2nD", CPU: "IPQ-4019" });

    const byAlias = new Map(result.aliasRows.map((a) => [a.alias, a]));
    expect(byAlias.get("cap ac")).toMatchObject({ rosettaDeviceId: "cap-ac", source: "matrix.csv" });
    expect(byAlias.get("rbcapgi-5acd2nd")).toMatchObject({ rosettaDeviceId: "cap-ac", source: "matrix.csv" });
    expect(byAlias.get("cap_ac")).toMatchObject({ rosettaDeviceId: "cap-ac", source: "hardware-link" });
    expect(byAlias.get("cap-ac")).toMatchObject({ rosettaDeviceId: "cap-ac", source: "hardware-slug" });
  });

  test("devices_id is null and unresolvedDevices flags a matrix row absent from the devices table", () => {
    const matrixRows = [mkMatrixRow("Ghost Device", "GHOST-1")];
    const result = buildCatalog(matrixRows, new Map(), [], []);

    expect(result.catalogRows[0].devicesId).toBeNull();
    expect(result.unresolvedDevices).toEqual(["Ghost Device"]);
  });
});

describe("buildCatalog — multi-match series pages (rb1100-series regression case)", () => {
  const row1 = mkMatrixRow("RB1100AHx4", "RB1100AHx4");
  const row2 = mkMatrixRow("RB1100AHx4 Dude Edition", "RB1100Dx4");
  const devicesByName = new Map([
    ["RB1100AHx4", 1],
    ["RB1100AHx4 Dude Edition", 2],
  ]);
  const page = mkPage({
    slug: "rb1100-series",
    productLinks: ["RB1100Dx4", "rb1100ahx4"],
    matchedMatrixNames: ["RB1100AHx4", "RB1100AHx4 Dude Edition"],
    cause: "matched-by-code",
    category: "Ethernet routers",
  });

  test("attributes the shared page slug + category to both devices", () => {
    const result = buildCatalog([row1, row2], devicesByName, [page], []);
    const bySlug = new Map(result.catalogRows.map((r) => [r.rosettaDeviceId, r]));
    expect(bySlug.get("rb1100ahx4")?.sourceHardwareSlug).toBe("rb1100-series");
    expect(bySlug.get("rb1100ahx4-dude-edition")?.sourceHardwareSlug).toBe("rb1100-series");
    expect(bySlug.get("rb1100ahx4")?.category).toBe("Ethernet routers");
    expect(bySlug.get("rb1100ahx4-dude-edition")?.category).toBe("Ethernet routers");
  });

  test("attributes each per-device product-link token to exactly one device, not both", () => {
    const result = buildCatalog([row1, row2], devicesByName, [page], []);
    const byAlias = new Map(result.aliasRows.map((a) => [a.alias, a.rosettaDeviceId]));
    expect(byAlias.get("rb1100dx4")).toBe("rb1100ahx4-dude-edition");
    expect(byAlias.get("rb1100ahx4")).toBe("rb1100ahx4");
    expect(result.ambiguousTokens).toHaveLength(0);
  });

  test("a token matching neither/both devices is reported ambiguous, not attributed", () => {
    const ambiguousPage = mkPage({
      slug: "rb1100-series",
      productLinks: ["RB1100Dx4", "SOME-OTHER-CODE"],
      matchedMatrixNames: ["RB1100AHx4", "RB1100AHx4 Dude Edition"],
      cause: "matched-by-code",
    });
    const result = buildCatalog([row1, row2], devicesByName, [ambiguousPage], []);
    expect(result.ambiguousTokens).toEqual([
      { page: "rb1100-series", token: "SOME-OTHER-CODE", candidates: ["RB1100AHx4", "RB1100AHx4 Dude Edition"] },
    ]);
    const byAlias = new Map(result.aliasRows.map((a) => [a.alias, a.rosettaDeviceId]));
    expect(byAlias.has("some-other-code")).toBe(false);
  });
});

describe("buildCatalog — standalone /hardware-only rows (accessories, legacy/EOL)", () => {
  test("a page with no matrix match becomes an hw-prefixed row with devices_id null", () => {
    const page = mkPage({ slug: "apa-1", productLinks: ["apa_1"], category: "Accessories", cause: "unmatched" });
    const www = [mkWww("apa_1", { discontinued: true })];

    const result = buildCatalog([], new Map(), [page], www);

    expect(result.catalogRows).toHaveLength(1);
    const row = result.catalogRows[0];
    expect(row.rosettaDeviceId).toBe("hw-apa-1");
    expect(row.devicesId).toBeNull();
    expect(row.category).toBe("Accessories");
    expect(row.discontinued).toBe(1);
    expect(row.sourceWwwCode).toBe("apa_1");
  });

  test("falls back to the /hardware page's own title when no www product resolves", () => {
    const page = mkPage({ slug: "no-www-page", title: "No WWW Page", cause: "no-product-link" });
    const result = buildCatalog([], new Map(), [page], []);
    expect(JSON.parse(result.catalogRows[0].specsJson ?? "{}")).toMatchObject({ _hardware_title: "No WWW Page" });
  });
});

describe("buildCatalog — compound (kit) declared codes", () => {
  test("splits a compound declared code on '&' into independently searchable component aliases", () => {
    const row = mkMatrixRow("ATL 5G R16", "ATLGM&RG520F-EU");
    const page = mkPage({ slug: "atlgm-and-rg520f-eu", productLinks: ["atl_5g_r16"], matchedMatrixNames: ["ATL 5G R16"], cause: "matched-by-slug" });
    const www = [mkWww("atl_5g_r16", { specs: { "Product code": "ATLGM&RG520F-EU" }, compareId: "atlgm&amp;rg520f-eu" })];

    const result = buildCatalog([row], new Map([["ATL 5G R16", 7]]), [page], www);
    const byAlias = new Map(result.aliasRows.map((a) => [a.alias, a]));

    // Whole compound code and both atomic parts are all reachable.
    expect(byAlias.get("atlgm&rg520f-eu")?.rosettaDeviceId).toBe("atl-5g-r16");
    expect(byAlias.get("atlgm")?.rosettaDeviceId).toBe("atl-5g-r16");
    expect(byAlias.get("rg520f-eu")?.rosettaDeviceId).toBe("atl-5g-r16");
  });

  test("an atomic component already claimed by a different device (shared kit part) is not reassigned", () => {
    const modemRow = mkMatrixRow("EG18 Modem Kit", "EG18-EA");
    const kitRow = mkMatrixRow("Some Router Kit", "SOMEBASE");
    const kitPage = mkPage({ slug: "some-router-kit", productLinks: ["some_router_kit"], matchedMatrixNames: ["Some Router Kit"], cause: "matched-by-slug" });
    const www = [mkWww("some_router_kit", { specs: { "Product code": "SOMEBASE&EG18-EA" } })];

    const result = buildCatalog([modemRow, kitRow], new Map(), [kitPage], www);
    const byAlias = new Map(result.aliasRows.map((a) => [a.alias, a.rosettaDeviceId]));

    // "eg18-ea" was already claimed by the modem's own matrix.csv row — the kit's
    // compound declared code must not steal it.
    expect(byAlias.get("eg18-ea")).toBe("eg18-modem-kit");
    expect(byAlias.get("somebase&eg18-ea")).toBe("some-router-kit");
  });
});

describe("buildCatalog — rosetta_device_id collisions", () => {
  test("throws when two matrix rows slugify to the same id", () => {
    const rowA = mkMatrixRow("Foo Bar", "A");
    const rowB = mkMatrixRow("foo bar", "B");
    expect(() => buildCatalog([rowA, rowB], new Map(), [], [])).toThrow(/collision/);
  });
});

// ── computeValidationStats ───────────────────────────────────────────────────

describe("computeValidationStats", () => {
  test("computes core field frequency, matrix coverage, and www 404 rate from raw counts", () => {
    const hw = {
      matrixRowCount: 100,
      matchedByCode: 50,
      matchedByTable: 10,
      matchedBySlug: 30, // total matched = 90 -> 90%
      categories: [{ name: "A", memberCount: 1, members: [] }],
      uncategorizedPages: [],
      pages: [],
    };
    const www = {
      candidateCount: 200,
      notFoundCount: 80, // 40%
      fieldFrequency: { "Product code": 120, CPU: 60, Architecture: 60 }, // out of 120 found products
      products: Array.from({ length: 120 }, (_, i) => mkWww(`code-${i}`)),
    };
    const stats = computeValidationStats(hw, www, []);

    expect(stats.categoryCount).toBe(1);
    expect(stats.matrixCoveragePct).toBe(90);
    expect(stats.www404RatePct).toBe(40);
    expect(stats.coreFieldFrequencyPct).toEqual({ "Product code": 100, CPU: 50, Architecture: 50 });
  });

  test("resolvedDeviceNames only counts devices linked to `devices` AND enriched by /hardware or www", () => {
    const catalogRows = [
      { rosettaDeviceId: "a", devicesId: 1, category: null, discontinued: null, specsJson: null, sourceHardwareSlug: "a", sourceWwwCode: null },
      { rosettaDeviceId: "b", devicesId: 2, category: null, discontinued: null, specsJson: null, sourceHardwareSlug: null, sourceWwwCode: null }, // bare devices row, no overlay
      { rosettaDeviceId: "hw-c", devicesId: null, category: null, discontinued: null, specsJson: null, sourceHardwareSlug: "c", sourceWwwCode: null }, // accessory, not devices-linked
    ];
    const hw = { matrixRowCount: 0, matchedByCode: 0, matchedByTable: 0, matchedBySlug: 0, categories: [], uncategorizedPages: [], pages: [] };
    const www = { candidateCount: 0, notFoundCount: 0, fieldFrequency: {}, products: [] };

    const stats = computeValidationStats(hw, www, catalogRows);
    expect(stats.resolvedDeviceNames).toEqual(["a"]);
  });
});

// ── checkBaseline ─────────────────────────────────────────────────────────────

describe("checkBaseline", () => {
  const baseline = {
    categoryCount: 12,
    uncategorizedPages: 0,
    coreFieldFrequencyPct: { "Product code": 100, CPU: 82, Architecture: 82 },
    matrixCoveragePct: 91,
    www404RatePct: 41,
    resolvedDeviceNames: ["a", "b", "c"],
  };

  test("identical stats pass with no failures", () => {
    expect(checkBaseline(baseline, baseline)).toEqual([]);
  });

  test("category count drift fails", () => {
    const failures = checkBaseline({ ...baseline, categoryCount: 11 }, baseline);
    expect(failures.some((f) => f.includes("category count"))).toBe(true);
  });

  test("new uncategorized pages fail", () => {
    const failures = checkBaseline({ ...baseline, uncategorizedPages: 3 }, baseline);
    expect(failures.some((f) => f.includes("uncategorized"))).toBe(true);
  });

  test("core field frequency drop beyond tolerance fails", () => {
    const failures = checkBaseline({ ...baseline, coreFieldFrequencyPct: { ...baseline.coreFieldFrequencyPct, CPU: 60 } }, baseline);
    expect(failures.some((f) => f.includes('"CPU"'))).toBe(true);
  });

  test("a small field frequency dip within tolerance does not fail", () => {
    const failures = checkBaseline({ ...baseline, coreFieldFrequencyPct: { ...baseline.coreFieldFrequencyPct, CPU: 75 } }, baseline);
    expect(failures).toEqual([]);
  });

  test("matrix coverage below the fixed floor fails even against a lenient baseline", () => {
    const lenientBaseline = { ...baseline, matrixCoveragePct: 50 };
    const failures = checkBaseline({ ...baseline, matrixCoveragePct: 80 }, lenientBaseline);
    expect(failures.some((f) => f.includes("coverage"))).toBe(true);
  });

  test("www 404 rate swinging beyond tolerance fails", () => {
    const failures = checkBaseline({ ...baseline, www404RatePct: 70 }, baseline);
    expect(failures.some((f) => f.includes("404"))).toBe(true);
  });

  test("a previously-resolved device disappearing fails and names it", () => {
    const failures = checkBaseline({ ...baseline, resolvedDeviceNames: ["a", "c"] }, baseline);
    expect(failures.some((f) => f.includes("no longer resolve") && f.includes("b"))).toBe(true);
  });
});

// ── writeCatalog (DB integration) ────────────────────────────────────────────

describe("writeCatalog", () => {
  test("is idempotent — a second run replaces rather than accumulates rows", async () => {
    initDb();
    const row1 = mkMatrixRow("Test Device", "TD-1");
    const result1 = buildCatalog([row1], new Map(), [], []);
    writeCatalog(result1);

    let count = (db.prepare("SELECT COUNT(*) AS c FROM hardware_catalog").get() as { c: number }).c;
    expect(count).toBe(1);

    writeCatalog(result1); // re-run with identical input
    count = (db.prepare("SELECT COUNT(*) AS c FROM hardware_catalog").get() as { c: number }).c;
    expect(count).toBe(1); // not 2

    const row = db.prepare("SELECT * FROM hardware_catalog").get() as { rosetta_device_id: string; devices_id: number | null };
    expect(row.rosetta_device_id).toBe("test-device");
    expect(row.devices_id).toBeNull();
  });

  test("device_aliases rows reference a real hardware_catalog.rosetta_device_id (FK holds)", async () => {
    initDb();
    const row1 = mkMatrixRow("FK Test Device", "FK-1");
    const result = buildCatalog([row1], new Map(), [], []);
    expect(() => writeCatalog(result)).not.toThrow();

    const alias = db.prepare("SELECT * FROM device_aliases WHERE alias = ?").get("fk test device") as { rosetta_device_id: string };
    expect(alias.rosetta_device_id).toBe("fk-test-device");
  });
});
