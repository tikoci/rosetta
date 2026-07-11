// Set BEFORE importing extract-hardware-catalog.ts (which transitively imports db.ts).
process.env.DB_PATH = ":memory:";

import { describe, expect, test } from "bun:test";
import { slugify } from "./assess-hardware.ts";
import type { BuildResult, HardwarePage, ValidationStats, WwwProduct } from "./extract-hardware-catalog.ts";

const { buildCatalog, checkInvariants, computeValidationStats, checkBaseline, serializeCatalog, writeCatalog } = await import(
  "./extract-hardware-catalog.ts"
);
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
    nonDefaultIps: [],
    regulatoryIds: [],
    ...overrides,
  } as HardwarePage;
}

function mkWww(
  code: string,
  overrides: Partial<{ title: string; tagline: string; discontinued: boolean; compareId: string; specs: Record<string, string> }> = {},
): WwwProduct {
  return {
    code,
    title: overrides.title ?? code,
    tagline: overrides.tagline ?? "",
    discontinued: overrides.discontinued ?? false,
    compareId: overrides.compareId ?? code,
    specs: overrides.specs ?? { "Product code": code },
  };
}

const counts = () => ({ matrixRows: 0, hardwarePages: 0, wwwProducts: 0 });

/** Assert-and-return so tests don't need non-null assertions on .find(). */
function must<T>(v: T | undefined, msg: string): T {
  if (v === undefined) throw new Error(`expected ${msg}`);
  return v;
}

// ── buildCatalog ─────────────────────────────────────────────────────────────

describe("buildCatalog — single-match devices-linked row", () => {
  test("links device_id, records source slugs, and resolves specs via a www code that differs from the requested link (cap_ac case)", () => {
    const matrixRows = [mkMatrixRow("cAP ac", "RBcAPGi-5acD2nD")];
    const devicesByName = new Map([["cAP ac", 42]]);
    const pages = [
      mkPage({ slug: "cap-ac", title: "cAP ac", productLinks: ["cap_ac"], matchedMatrixNames: ["cAP ac"], cause: "matched-by-slug", category: "Indoor wireless" }),
    ];
    const wwwProducts = [mkWww("cap_ac", { title: "cAP ac", specs: { "Product code": "RBcAPGi-5acD2nD", CPU: "IPQ-4019" } })];

    const result = buildCatalog(matrixRows, devicesByName, pages, wwwProducts);

    expect(result.catalogRows).toHaveLength(1);
    const row = result.catalogRows[0];
    expect(row.rosettaDeviceId).toBe("cap-ac");
    expect(row.deviceId).toBe(42);
    expect(row.name).toBe("cAP ac");
    expect(row.category).toBe("Indoor wireless");
    expect(row.sourceHardwareSlug).toBe("cap-ac");
    expect(row.sourceWwwCode).toBe("cap_ac");
    expect(JSON.parse(row.specsJson ?? "{}")).toMatchObject({ "Product code": "RBcAPGi-5acD2nD", CPU: "IPQ-4019" });

    const byAlias = new Map(result.aliasRows.map((a) => [a.alias, a]));
    expect(byAlias.get("cap ac")).toMatchObject({ rosettaDeviceId: "cap-ac", source: "matrix.csv" });
    expect(byAlias.get("rbcapgi-5acd2nd")).toMatchObject({ rosettaDeviceId: "cap-ac" });
    expect(byAlias.get("cap_ac")).toMatchObject({ rosettaDeviceId: "cap-ac" });
    expect(byAlias.get("cap-ac")).toMatchObject({ rosettaDeviceId: "cap-ac", source: "hardware-slug" });
  });

  test("device_id is null and unresolvedDevices flags a matrix row absent from the devices table", () => {
    const matrixRows = [mkMatrixRow("Ghost Device", "GHOST-1")];
    const result = buildCatalog(matrixRows, new Map(), [], []);

    expect(result.catalogRows[0].deviceId).toBeNull();
    expect(result.catalogRows[0].name).toBe("Ghost Device"); // falls back to matrix name
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
  test("a page with no matrix match becomes an hw-prefixed row with device_id null", () => {
    const page = mkPage({ slug: "apa-1", title: "APA-1", productLinks: ["apa_1"], category: "Accessories", cause: "unmatched" });
    const www = [mkWww("apa_1", { title: "APA-1", discontinued: true })];

    const result = buildCatalog([], new Map(), [page], www);

    expect(result.catalogRows).toHaveLength(1);
    const row = result.catalogRows[0];
    expect(row.rosettaDeviceId).toBe("hw-apa-1");
    expect(row.deviceId).toBeNull();
    expect(row.category).toBe("Accessories");
    expect(row.discontinued).toBe(1);
    expect(row.sourceWwwCode).toBe("apa_1");
  });

  test("falls back to the /hardware page's own title when no www product resolves", () => {
    const page = mkPage({ slug: "no-www-page", title: "No WWW Page", cause: "no-product-link" });
    const result = buildCatalog([], new Map(), [page], []);
    expect(result.catalogRows[0].name).toBe("No WWW Page");
    expect(JSON.parse(result.catalogRows[0].specsJson ?? "{}")).toMatchObject({ _hardware_title: "No WWW Page" });
  });
});

// ── INVARIANT: cross-sell attribution (PR #36 review defect #1) ────────────────

describe("INVARIANT — a device only takes a www product whose identity agrees with its own", () => {
  test("an accessory link that does NOT slug-match the page is rejected; the page's own product wins", () => {
    // cube-lite60 page links the QM-X bracket first, then its own cube_lite60. The old
    // first-hit logic took QM-X's specs; the agreement gate must pick cube_lite60.
    const page = mkPage({ slug: "cube-lite60", title: "Cube Lite60", productLinks: ["qm_x", "cube_lite60"], cause: "unmatched" });
    const www = [
      mkWww("qm_x", { title: "QM-X" }),
      mkWww("cube_lite60", { title: "Cube Lite60", specs: { "Product code": "RBCube-60ad" } }),
    ];

    const result = buildCatalog([], new Map(), [page], www);
    const row = must(result.catalogRows.find((r) => r.rosettaDeviceId === "hw-cube-lite60"), "hw-cube-lite60 row");
    expect(row.sourceWwwCode).toBe("cube_lite60");
    expect(JSON.parse(row.specsJson ?? "{}")._www_title).toBe("Cube Lite60");
    // QM-X attaches to nothing and is accounted for in the drop ledger.
    expect(result.dropLedger.some((d) => d.kind === "www-product" && d.id === "qm_x")).toBe(true);
    expect(checkInvariants(result, www)).toEqual([]);
  });

  test("a page whose only link is a foreign accessory gets NULL specs, not the accessory's (chateau->mANT)", () => {
    const page = mkPage({ slug: "chateau-lte6", title: "Chateau LTE6", productLinks: ["mant_lte_5o"], cause: "unmatched" });
    const www = [mkWww("mant_lte_5o", { title: "mANT LTE 5o", discontinued: true })];

    const result = buildCatalog([], new Map(), [page], www);
    const row = must(result.catalogRows.find((r) => r.rosettaDeviceId === "hw-chateau-lte6"), "hw-chateau-lte6 row");
    expect(row.sourceWwwCode).toBeNull();
    // No www specs leaked in — only the page's own title survives in the blob.
    const specs = JSON.parse(row.specsJson ?? "{}");
    expect(specs["Product code"]).toBeUndefined();
    expect(specs._www_title).toBeUndefined();
    expect(result.dropLedger.some((d) => d.id === "mant_lte_5o")).toBe(true);
    expect(checkInvariants(result, www)).toEqual([]);
  });

  test("checkInvariants flags a row whose declared code is not among its own aliases", () => {
    // Hand-build a corrupt result: specs declare a code that no alias points back to.
    const corrupt: BuildResult = {
      catalogRows: [
        {
          rosettaDeviceId: "hw-x",
          deviceId: null,
          name: "X",
          category: null,
          discontinued: null,
          specsJson: JSON.stringify({ "Product code": "FOREIGN-CODE" }),
          sourceHardwareSlug: "x",
          sourceWwwCode: "foreign",
        },
      ],
      aliasRows: [{ alias: "x", rosettaDeviceId: "hw-x", source: "hardware-slug" }],
      unresolvedDevices: [],
      ambiguousTokens: [],
      dropLedger: [],
      aliasCollisions: [],
    };
    const failures = checkInvariants(corrupt, [mkWww("foreign", { specs: { "Product code": "FOREIGN-CODE" } })]);
    expect(failures.some((f) => f.includes("declared code is not among their own aliases"))).toBe(true);
  });
});

// ── INVARIANT: one www product -> at most one row (allowlist) ──────────────────

describe("INVARIANT — a www product attaches to at most one row, save the shared-kit allowlist", () => {
  test("the wAP R base radio legitimately backs every wAP LR kit row (allowlisted multi-attach passes)", () => {
    const rows = [
      mkMatrixRow("wAP R", "RBwAPR-2nD"),
      mkMatrixRow("wAP LR8G kit", "RBwAPR-2nD&R11e-LR8G"),
      mkMatrixRow("wAP LR9G kit", "RBwAPR-2nD&R11e-LR9G"),
    ];
    const www = [mkWww("RBwAPR-2nD", { title: "wAP R" })];
    const result = buildCatalog(rows, new Map(), [], www);

    const attached = result.catalogRows.filter((r) => r.sourceWwwCode?.toLowerCase() === "rbwapr-2nd");
    expect(attached.length).toBeGreaterThan(1); // shared across kits
    expect(checkInvariants(result, www)).toEqual([]); // allowlist exempts it

    // The base radio's own code alias resolves to wAP R itself, not a kit (sole-code priority).
    const byAlias = new Map(result.aliasRows.map((a) => [a.alias, a.rosettaDeviceId]));
    expect(byAlias.get("rbwapr-2nd")).toBe("wap-r");

    // Kit rows keep their OWN display name — they must not inherit the shared base radio's
    // "wAP R" title just because they draw specs from it (the shipped regression this catches).
    const byId = new Map(result.catalogRows.map((r) => [r.rosettaDeviceId, r]));
    expect(byId.get("wap-r")?.name).toBe("wAP R");
    expect(byId.get("wap-lr8g-kit")?.name).toBe("wAP LR8G kit");
    expect(byId.get("wap-lr9g-kit")?.name).toBe("wAP LR9G kit");
    // And the name-distinctness invariant (5) fires when a kit does inherit the base name.
    const collapsed: BuildResult = {
      ...result,
      catalogRows: result.catalogRows.map((r) => (r.sourceWwwCode?.toLowerCase() === "rbwapr-2nd" ? { ...r, name: "wAP R" } : r)),
    };
    expect(checkInvariants(collapsed, www).some((f) => f.includes("distinct name"))).toBe(true);
  });

  test("checkInvariants flags a non-allowlisted www product bound to two rows", () => {
    const corrupt: BuildResult = {
      catalogRows: [
        { rosettaDeviceId: "a", deviceId: null, name: "A", category: null, discontinued: null, specsJson: null, sourceHardwareSlug: null, sourceWwwCode: "shared" },
        { rosettaDeviceId: "b", deviceId: null, name: "B", category: null, discontinued: null, specsJson: null, sourceHardwareSlug: null, sourceWwwCode: "shared" },
      ],
      aliasRows: [],
      unresolvedDevices: [],
      ambiguousTokens: [],
      dropLedger: [{ kind: "www-product", id: "shared", reason: "x" }],
      aliasCollisions: [],
    };
    const failures = checkInvariants(corrupt, [mkWww("shared")]);
    expect(failures.some((f) => f.includes("attached to >1 row outside the allowlist"))).toBe(true);
  });
});

// ── INVARIANT: every www product accounted for (attached or dropped) ──────────

describe("INVARIANT — every www product is attached or in the drop ledger, disjoint & exhaustive", () => {
  test("an unreferenced accessory product lands in the ledger with a reason and passes accountability", () => {
    const page = mkPage({ slug: "hex", title: "hEX", productLinks: ["hex"], cause: "unmatched" });
    const www = [mkWww("hex", { title: "hEX" }), mkWww("orphan_accessory", { title: "Orphan" })];
    const result = buildCatalog([], new Map(), [page], www);

    const orphan = result.dropLedger.find((d) => d.id === "orphan_accessory");
    expect(orphan?.reason).toContain("not referenced");
    expect(checkInvariants(result, www)).toEqual([]);
  });

  test("checkInvariants flags a www product that is neither attached nor dropped", () => {
    const result = buildCatalog([], new Map(), [], []);
    // Pretend a www product existed but the build never saw it in either bucket.
    const failures = checkInvariants(result, [mkWww("ghost_product")]);
    expect(failures.some((f) => f.includes("neither attached nor in the drop ledger"))).toBe(true);
  });
});

// ── INVARIANT: alias collisions are counted, not swallowed ────────────────────

describe("INVARIANT — alias collisions are counted and priority-resolved", () => {
  test("a low-priority table code loses to a high-priority www spec code, and the collision is recorded", () => {
    // netbox-5 table lists RBDisc-5nD (noise); disc-lite5's own www declares RBDisc-5nD.
    const netbox = mkPage({ slug: "netbox-5", title: "NetBox 5", productLinks: ["rb911g"], tableModelCodes: ["RBDisc-5nD"], cause: "unmatched" });
    const disc = mkPage({ slug: "disc-lite5", title: "DISC Lite5", productLinks: ["rbdisc_5nd"], cause: "unmatched" });
    const www = [
      mkWww("rb911g", { title: "NetBox 5" }),
      mkWww("rbdisc_5nd", { title: "DISC Lite5", specs: { "Product code": "RBDisc-5nD" } }),
    ];
    const result = buildCatalog([], new Map(), [netbox, disc], www);

    const byAlias = new Map(result.aliasRows.map((a) => [a.alias, a.rosettaDeviceId]));
    // The www spec-source declared code wins the alias over the stray table code.
    expect(byAlias.get("rbdisc-5nd")).toBe("hw-disc-lite5");
    expect(result.aliasCollisions.some((c) => c.alias === "rbdisc-5nd")).toBe(true);
    expect(checkInvariants(result, www)).toEqual([]);
  });
});

// ── declared-code third matching tier (PR #36 review item 2) ──────────────────

describe("buildCatalog — declared-code third matching tier (ROSE / KNOT)", () => {
  test("resolves a matrix row via a link -> www declared full code (ROSE Data server)", () => {
    const rows = [mkMatrixRow("ROSE Data server (RDS)", "RDS2216-2XG-4S+4XS-2XQ")];
    const page = mkPage({ slug: "rose-data-server", title: "ROSE Data server (RDS)", productLinks: ["rds2216"], cause: "unmatched" });
    const www = [mkWww("rds2216", { title: "ROSE Data server (RDS)", specs: { "Product code": "RDS2216-2XG-4S+4XS-2XQ" } })];

    const result = buildCatalog(rows, new Map([["ROSE Data server (RDS)", 9]]), [page], www);
    // No standalone hw-rose-data-server duplicate — the page attributes to the matrix row.
    expect(result.catalogRows.some((r) => r.rosettaDeviceId === "hw-rose-data-server")).toBe(false);
    const row = must(result.catalogRows.find((r) => r.rosettaDeviceId === "rose-data-server-rds"), "rose-data-server-rds row");
    expect(row.deviceId).toBe(9);
    expect(row.sourceHardwareSlug).toBe("rose-data-server");
    expect(row.sourceWwwCode).toBe("rds2216");
  });

  test("resolves both KNOT rows by page slug-suffix even though both link the same mislabelled product", () => {
    const rows = [mkMatrixRow("KNOT Embedded LTE4", "EC25-EU&KNe"), mkMatrixRow("KNOT Embedded LTE4 Global", "EG25-G&KNe")];
    const pages = [
      mkPage({ slug: "knot-embedded-lte4-ec25-eu-and-kne", title: "KNOT Embedded LTE4", productLinks: ["knot_emb_lte4_global"], cause: "unmatched" }),
      mkPage({ slug: "knot-embedded-lte4-global-eg25-g-and-kne", title: "KNOT Embedded LTE4 Global", productLinks: ["knot_emb_lte4_global"], cause: "unmatched" }),
    ];
    const www = [mkWww("knot_emb_lte4_global", { title: "KNOT Embedded LTE4 Global", specs: { "Product code": "EG25-G&KNe" } })];

    const result = buildCatalog(rows, new Map(), pages, www);
    const bySlug = new Map(result.catalogRows.map((r) => [r.rosettaDeviceId, r]));
    expect(bySlug.get("knot-embedded-lte4")?.sourceHardwareSlug).toBe("knot-embedded-lte4-ec25-eu-and-kne");
    expect(bySlug.get("knot-embedded-lte4-global")?.sourceHardwareSlug).toBe("knot-embedded-lte4-global-eg25-g-and-kne");
    // No standalone hw-* duplicates for either.
    expect(result.catalogRows.some((r) => r.rosettaDeviceId.startsWith("hw-knot"))).toBe(false);
  });
});

// ── nonDefaultIps + regulatory ids landing (PR #36 review item 5) ──────────────

describe("buildCatalog — lands nonDefaultIps and FCC/IC regulatory ids into specs_json", () => {
  test("a standalone page's management IP and FCC/IC ids reach the row's specs blob", () => {
    const page = mkPage({
      slug: "cube-60g-ac",
      title: "Cube 60G ac",
      productLinks: ["cube_60g_ac"],
      tableModelCodes: ["RBCube-60ad"],
      nonDefaultIps: ["192.168.1.1"],
      regulatoryIds: [
        { model: "RBCube-60ad", type: "FCC ID", id: "TV7CUBE60" },
        { model: "RBCube-60ad", type: "IC", id: "7442A-CUBE60" },
      ],
      cause: "unmatched",
    });
    const www = [mkWww("cube_60g_ac", { title: "Cube 60G ac" })];
    const result = buildCatalog([], new Map(), [page], www);
    const specs = JSON.parse(result.catalogRows[0].specsJson ?? "{}");
    expect(specs._non_default_ips).toEqual(["192.168.1.1"]);
    expect(specs._fcc_id).toEqual(["TV7CUBE60"]);
    expect(specs._ic).toEqual(["7442A-CUBE60"]);
  });
});

// ── compound (kit) declared codes ─────────────────────────────────────────────

describe("buildCatalog — compound (kit) declared codes", () => {
  test("splits a compound declared code on '&' into independently searchable component aliases", () => {
    const row = mkMatrixRow("ATL 5G R16", "ATLGM&RG520F-EU");
    const page = mkPage({ slug: "atlgm-and-rg520f-eu", title: "ATL 5G R16", productLinks: ["atl_5g_r16"], matchedMatrixNames: ["ATL 5G R16"], cause: "matched-by-slug" });
    const www = [mkWww("atl_5g_r16", { title: "ATL 5G R16", specs: { "Product code": "ATLGM&RG520F-EU" }, compareId: "atlgm&amp;rg520f-eu" })];

    const result = buildCatalog([row], new Map([["ATL 5G R16", 7]]), [page], www);
    const byAlias = new Map(result.aliasRows.map((a) => [a.alias, a]));

    expect(byAlias.get("atlgm&rg520f-eu")?.rosettaDeviceId).toBe("atl-5g-r16");
    expect(byAlias.get("atlgm")?.rosettaDeviceId).toBe("atl-5g-r16");
    expect(byAlias.get("rg520f-eu")?.rosettaDeviceId).toBe("atl-5g-r16");
  });

  test("an atomic component already claimed by a different device (shared kit part) is not reassigned", () => {
    const modemRow = mkMatrixRow("EG18 Modem Kit", "EG18-EA");
    const kitRow = mkMatrixRow("Some Router Kit", "SOMEBASE");
    const kitPage = mkPage({ slug: "some-router-kit", title: "Some Router Kit", productLinks: ["some_router_kit"], matchedMatrixNames: ["Some Router Kit"], cause: "matched-by-slug" });
    const www = [mkWww("some_router_kit", { title: "Some Router Kit", specs: { "Product code": "SOMEBASE&EG18-EA" } })];

    const result = buildCatalog([modemRow, kitRow], new Map(), [kitPage], www);
    const byAlias = new Map(result.aliasRows.map((a) => [a.alias, a.rosettaDeviceId]));

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
    const empty = buildCatalog([], new Map(), [], []);
    const stats = computeValidationStats(hw, www, empty);

    expect(stats.categoryCount).toBe(1);
    expect(stats.matrixCoveragePct).toBe(90);
    expect(stats.www404RatePct).toBe(40);
    expect(stats.coreFieldFrequencyPct).toEqual({ "Product code": 100, CPU: 50, Architecture: 50 });
  });

  test("resolvedDeviceIds only counts devices linked to `devices` AND enriched by /hardware or www", () => {
    const result: BuildResult = {
      catalogRows: [
        { rosettaDeviceId: "a", deviceId: 1, name: "a", category: null, discontinued: null, specsJson: null, sourceHardwareSlug: "a", sourceWwwCode: null },
        { rosettaDeviceId: "b", deviceId: 2, name: "b", category: null, discontinued: null, specsJson: null, sourceHardwareSlug: null, sourceWwwCode: null }, // bare devices row, no overlay
        { rosettaDeviceId: "hw-c", deviceId: null, name: "c", category: null, discontinued: null, specsJson: null, sourceHardwareSlug: "c", sourceWwwCode: null }, // accessory, not devices-linked
      ],
      aliasRows: [],
      unresolvedDevices: [],
      ambiguousTokens: [],
      dropLedger: [],
      aliasCollisions: [],
    };
    const hw = { matrixRowCount: 0, matchedByCode: 0, matchedByTable: 0, matchedBySlug: 0, categories: [], uncategorizedPages: [], pages: [] };
    const www = { candidateCount: 0, notFoundCount: 0, fieldFrequency: {}, products: [] };

    const stats = computeValidationStats(hw, www, result);
    expect(stats.resolvedDeviceIds).toEqual(["a"]);
  });
});

// ── checkBaseline ─────────────────────────────────────────────────────────────

describe("checkBaseline", () => {
  const baseline: ValidationStats = {
    categoryCount: 12,
    uncategorizedPages: 0,
    coreFieldFrequencyPct: { "Product code": 100, CPU: 82, Architecture: 82 },
    matrixCoveragePct: 91,
    www404RatePct: 41,
    aliasCollisions: 10,
    droppedWwwProducts: 20,
    resolvedDeviceIds: ["a", "b", "c"],
  };

  test("identical stats pass with no failures", () => {
    expect(checkBaseline(baseline, baseline)).toEqual([]);
  });

  test("category count drift fails", () => {
    expect(checkBaseline({ ...baseline, categoryCount: 11 }, baseline).some((f) => f.includes("category count"))).toBe(true);
  });

  test("new uncategorized pages fail", () => {
    expect(checkBaseline({ ...baseline, uncategorizedPages: 3 }, baseline).some((f) => f.includes("uncategorized"))).toBe(true);
  });

  test("core field frequency drop beyond tolerance fails", () => {
    expect(checkBaseline({ ...baseline, coreFieldFrequencyPct: { ...baseline.coreFieldFrequencyPct, CPU: 60 } }, baseline).some((f) => f.includes('"CPU"'))).toBe(true);
  });

  test("a small field frequency dip within tolerance does not fail", () => {
    expect(checkBaseline({ ...baseline, coreFieldFrequencyPct: { ...baseline.coreFieldFrequencyPct, CPU: 75 } }, baseline)).toEqual([]);
  });

  test("matrix coverage below the fixed floor fails even against a lenient baseline", () => {
    const lenientBaseline = { ...baseline, matrixCoveragePct: 50 };
    expect(checkBaseline({ ...baseline, matrixCoveragePct: 80 }, lenientBaseline).some((f) => f.includes("coverage"))).toBe(true);
  });

  test("www 404 rate swinging beyond tolerance fails", () => {
    expect(checkBaseline({ ...baseline, www404RatePct: 70 }, baseline).some((f) => f.includes("404"))).toBe(true);
  });

  test("a surge in alias collisions beyond tolerance fails", () => {
    expect(checkBaseline({ ...baseline, aliasCollisions: 40 }, baseline).some((f) => f.includes("collision"))).toBe(true);
  });

  test("a surge in dropped www products beyond tolerance fails", () => {
    expect(checkBaseline({ ...baseline, droppedWwwProducts: 40 }, baseline).some((f) => f.includes("dropped www"))).toBe(true);
  });

  test("a previously-resolved device disappearing fails and names it", () => {
    expect(checkBaseline({ ...baseline, resolvedDeviceIds: ["a", "c"] }, baseline).some((f) => f.includes("no longer resolve") && f.includes("b"))).toBe(true);
  });
});

// ── writeCatalog (DB integration) ────────────────────────────────────────────

describe("writeCatalog", () => {
  test("is idempotent — a second run replaces rather than accumulates rows", async () => {
    initDb();
    const row1 = mkMatrixRow("Test Device", "TD-1");
    const catalog = serializeCatalog(buildCatalog([row1], new Map(), [], []), counts());
    writeCatalog(catalog);

    let count = (db.prepare("SELECT COUNT(*) AS c FROM hardware_catalog").get() as { c: number }).c;
    expect(count).toBe(1);

    writeCatalog(catalog); // re-run with identical input
    count = (db.prepare("SELECT COUNT(*) AS c FROM hardware_catalog").get() as { c: number }).c;
    expect(count).toBe(1); // not 2

    const row = db.prepare("SELECT * FROM hardware_catalog").get() as { rosetta_device_id: string; device_id: number | null; name: string };
    expect(row.rosetta_device_id).toBe("test-device");
    expect(row.device_id).toBeNull();
    expect(row.name).toBe("Test Device");
  });

  test("device_aliases rows reference a real hardware_catalog.rosetta_device_id (FK holds)", async () => {
    initDb();
    const row1 = mkMatrixRow("FK Test Device", "FK-1");
    const result = buildCatalog([row1], new Map(), [], []);
    const catalog = serializeCatalog(result, counts());
    expect(() => writeCatalog(catalog)).not.toThrow();

    const alias = db.prepare("SELECT * FROM device_aliases WHERE alias = ?").get("fk test device") as { rosetta_device_id: string };
    expect(alias.rosetta_device_id).toBe("fk-test-device");
  });

  test("device_overview view exposes name + alias_count for each row", async () => {
    initDb();
    const result = buildCatalog([mkMatrixRow("View Device", "VD-1")], new Map(), [], []);
    writeCatalog(serializeCatalog(result, counts()));
    const ov = db.prepare("SELECT * FROM device_overview WHERE rosetta_device_id = ?").get("view-device") as { name: string; alias_count: number };
    expect(ov.name).toBe("View Device");
    expect(ov.alias_count).toBeGreaterThanOrEqual(1);
  });

  test("a stale device_id (not present in devices) fails the write loud", async () => {
    initDb();
    const result: BuildResult = {
      catalogRows: [{ rosettaDeviceId: "stale", deviceId: 99999, name: "Stale", category: null, discontinued: null, specsJson: null, sourceHardwareSlug: null, sourceWwwCode: null }],
      aliasRows: [{ alias: "stale", rosettaDeviceId: "stale", source: "matrix.csv" }],
      unresolvedDevices: [],
      ambiguousTokens: [],
      dropLedger: [],
      aliasCollisions: [],
    };
    expect(() => writeCatalog(serializeCatalog(result, counts()))).toThrow(/stale/);
  });
});
