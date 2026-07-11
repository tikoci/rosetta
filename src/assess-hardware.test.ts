/**
 * Anchor tests for the device matcher in assess-hardware.ts.
 *
 * These lock the naming-surface fixes from the 2026-07-11 maintainer review (P1–P4 +
 * shared-base guard) plus the three PR #37 review fixes (canonNoRev model-suffix collision,
 * own-slug collision guard, and its title-agreement escape hatch). See
 * briefings/B-0018-product-naming-three-source-map.md. They document *current* behavior so the
 * matcher can be refactored safely — each test names the pattern and the real device behind it.
 */
import { describe, expect, test } from "bun:test";
import {
  canon,
  canonForms,
  canonNoRev,
  classify,
  computeSharedSubCodes,
  isBogusProductToken,
  type MatrixRow,
  type PageInfo,
} from "./assess-hardware.ts";

// ── Test builders ──

function row(name: string, code: string): MatrixRow {
  const subCodes = code.split("&").map((c) => c.trim()).filter(Boolean);
  return { name, code, subCodes, nameSlug: "", codeSlugs: [] }; // slugs unused by classify()
}

function page(slug: string, opts: Partial<PageInfo> = {}): PageInfo {
  return {
    slug,
    url: `https://manual.mikrotik.com/hardware/${slug}`,
    title: slug,
    wordCount: 0,
    tableCount: 0,
    headings: [],
    productLinks: [],
    nonDefaultIps: [],
    isSeries: slug.endsWith("-series"),
    bodyText: "",
    category: null,
    categoryMembers: [],
    tableModelCodes: [],
    regulatoryIds: [],
    ...opts,
  };
}

function classifyIn(p: PageInfo, rows: MatrixRow[]) {
  return classify(p, rows, computeSharedSubCodes(rows));
}

// ── P2: canonical form collapses naming-surface variance ──

describe("canon() — the one identity rule (P2)", () => {
  test("collapses +/plus/_/-/case onto one key", () => {
    // The three surfaces for CCR2004-16G-2S+ that the review flagged as "looks different".
    expect(canon("CCR2004-16G-2S+")).toBe("ccr200416g2splus");
    expect(canon("ccr2004_16g_2splus")).toBe("ccr200416g2splus");
    expect(canon("CCR2004-16G-2SplusRM")).toBe("ccr200416g2splusrm"); // RM variant stays distinct
  });

  test("& becomes 'and' so full compound codes have a stable key", () => {
    expect(canon("ATLGM&EG18-EA")).toBe("atlgmandeg18ea");
  });

  test("canonNoRev drops a trailing revision or www order-suffix", () => {
    // RBGroove52HPnr2 == RBGroove52HPn; RBcAPL-2nD-307 == RBcAPL-2nD (confirmed same device).
    expect(canonNoRev("RBGroove52HPnr2")).toBe(canon("RBGroove52HPn"));
    expect(canonNoRev("RBcAPL-2nD-307")).toBe(canon("RBcAPL-2nD"));
  });

  test("canonForms yields exact then no-rev, de-duplicated", () => {
    expect(canonForms("RB750Gr3")).toEqual(["rb750gr3", "rb750g"]);
    expect(canonForms("cAP")).toEqual(["cap"]); // no rev suffix -> single form
  });
});

// ── P4: bogus accessory/broken link tokens are never a device identity ──

describe("bogus product tokens (P4)", () => {
  test("known accessory/broken stand-ins are flagged", () => {
    for (const t of ["qm_x", "acsmaufl", "mant_lte_5o", "acrpsma", "lora_antenna_kit"]) {
      expect(isBogusProductToken(t)).toBe(true);
      expect(isBogusProductToken(t.toUpperCase())).toBe(true);
    }
    expect(isBogusProductToken("RBcAP2nD")).toBe(false);
  });

  test("a page whose only link is bogus does not bind that device", () => {
    // sxtsq-5axd links only qm_x; must not match anything via that link.
    const rows = [row("SXTsq 5 ax", "SXTsq-5axD"), row("Wrong Device", "qm-x")];
    const c = classifyIn(page("sxtsq-5axd", { productLinks: ["qm_x"] }), rows);
    // Resolves to SXTsq 5 ax by its OWN slug, never to the bogus token.
    expect(c.matchedMatrixNames).toEqual(["SXTsq 5 ax"]);
    expect(c.cause).toBe("matched-by-slug");
  });
});

// ── P1: the full &-compound code slug is tried ──

describe("compound &-code full-slug match (P1)", () => {
  test("ATLGM&EG18-EA resolves to the atlgm-and-eg18-ea page it was silently missing", () => {
    const rows = [row("ATL LTE18 kit", "ATLGM&EG18-EA")];
    const c = classifyIn(page("atlgm-and-eg18-ea"), rows);
    expect(c.matchedMatrixNames).toEqual(["ATL LTE18 kit"]);
  });
});

// ── P3: own-page slug outranks a regulatory-table Model column ──

describe("slug outranks table (P3)", () => {
  test("a page matched by both its own slug and its table reports matched-by-slug", () => {
    // RB4011: page slug == code slug AND the FCC table lists the same code. Slug must win.
    const rows = [row("RB4011iGS+5HacQ2HnD-IN", "RB4011iGS+5HacQ2HnD-IN")];
    const c = classifyIn(
      page("rb4011igs-plus-5hacq2hnd-in", { tableModelCodes: ["RB4011iGS+5HacQ2HnD-IN"] }),
      rows,
    );
    expect(c.cause).toBe("matched-by-slug");
  });

  test("a table-only match is reported and tracked separately", () => {
    // sxtsa-series has no product link and no own-slug match; only its FCC table resolves it.
    const rows = [row("SXT SA5 ac", "RBSXTG-5HPacD-SAr2")];
    const c = classifyIn(page("sxtsa-series", { tableModelCodes: ["RBSXTG-5HPacD-SAr2"] }), rows);
    expect(c.cause).toBe("matched-by-table");
    expect(c.tableOnlyNames).toEqual(["SXT SA5 ac"]);
  });
});

// ── Shared-base guard: the &-base does not bind sibling variants ──

describe("shared-base guard (Chateau LTE family)", () => {
  const chateau = [
    row("Chateau LTE6-US", "D53G-5HacD2HnD-TC&EG06-A"),
    row("Chateau LTE12 (2025)", "D53G-5HacD2HnD-TC&EG120K-EA"),
  ];

  test("the shared base D53G-5HacD2HnD-TC is detected as shared", () => {
    expect(computeSharedSubCodes(chateau).has(canon("D53G-5HacD2HnD-TC"))).toBe(true);
  });

  test("chateau-lte6-us binds only LTE6-US, not LTE12, via its full table code", () => {
    // The FCC table lists the FULL code D53G-5HacD2HnD-TC&EG06-A; the &EG06-A vs &EG120K-EA
    // module suffix is the discriminator, so only LTE6-US matches.
    const c = classifyIn(page("chateau-lte6-us", { tableModelCodes: ["D53G-5HacD2HnD-TC&EG06-A"] }), chateau);
    expect(c.matchedMatrixNames).toEqual(["Chateau LTE6-US"]);
  });
});

// ── canonNoRev only strips true metadata, not model suffixes (PR #37 review :173) ──

describe("canonNoRev preserves model designators", () => {
  test("R11e-LR8 / -LR9 / -LR2 stay distinct (uppercase-R model suffixes are not revisions)", () => {
    // The old form lowercased first, so r\d+$/\d{3}$ collapsed all three to "r11el" and bound
    // r11e-lr8/lr9 to "wAP LR2 kit". Model designators use an uppercase R and must survive.
    const forms = [canonNoRev("R11e-LR8"), canonNoRev("R11e-LR9"), canonNoRev("R11e-LR2")];
    expect(new Set(forms).size).toBe(3);
    expect(forms).toEqual(["r11elr8", "r11elr9", "r11elr2"]);
  });

  test("a lowercase-r revision or separator+3-digit packaging suffix is still stripped", () => {
    expect(canonNoRev("RB750r2")).toBe("rb750"); // lowercase r2 revision dropped, model number kept
    expect(canonNoRev("RB750")).toBe("rb750"); // no separator before digits -> kept whole (not "rb")
    expect(canonNoRev("RBcAPL-2nD-307")).toBe(canon("RBcAPL-2nD")); // -307 packaging suffix dropped
  });
});

// ── An own-slug match must be corroborated or title-agreeing (PR #37 review :457) ──

describe("own-slug collision guard", () => {
  const haps = [row("hAP ax2", "C52iG-5HaxD2HaxD-TC"), row("hAP ax3", "C53UiG+5HPaxD2HPaxD")];

  test("a page titled hAP ax³ linking hap_ax3 does not also claim hAP ax2 via its slug", () => {
    // /hardware/hap-ax-2 canon-collides with the matrix name "hAP ax2", but the page IS hAP ax³.
    const c = classifyIn(page("hap-ax-2", { title: "hAP ax³", productLinks: ["hap_ax3"] }), haps);
    expect(c.matchedMatrixNames).toEqual(["hAP ax3"]);
  });

  test("but an own-slug match the page TITLE agrees with survives a mislinked product code", () => {
    // /hardware/hap-ac-lite-tc is titled "hAP ac lite TC" and its slug names that device, but it
    // erroneously links the non-TC RB952Ui-5ac2nD; the title clause keeps the correct TC match.
    const rows = [row("hAP ac lite", "RB952Ui-5ac2nD"), row("hAP ac lite TC", "RB952Ui-5ac2nD-TC")];
    const c = classifyIn(
      page("hap-ac-lite-tc", { title: "hAP ac lite TC", productLinks: ["RB952Ui-5ac2nD"] }),
      rows,
    );
    expect(c.matchedMatrixNames).toContain("hAP ac lite TC");
  });
});
