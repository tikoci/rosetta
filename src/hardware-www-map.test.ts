/**
 * Anchor tests for the curated hardware-www-map loader (src/hardware-www-map.ts).
 *
 * Lock the contract the ETL depends on: single-code slugs force-attach, series pages don't,
 * status-only entries contribute no code, and every vouched code is real (grounded against
 * mikrotik.com/sitemap.xml at capture time — see the TOML header). See #70 / B-0018.
 */
import { describe, expect, test } from "bun:test";
import { curatedWwwCodeForSlug, curatedWwwCodes, hardwareWwwMap } from "./hardware-www-map.ts";

describe("hardware-www-map loader", () => {
  test("a single-code slug force-attaches its curated code", () => {
    // sxt-2's product (RBSXTG-2HnDr2-168) is not derivable from the slug — the whole reason
    // the curated map exists. build-device-map/extract force-attach it past the identity gate.
    expect(curatedWwwCodeForSlug("sxt-2")).toBe("RBSXTG-2HnDr2-168");
    expect(curatedWwwCodeForSlug("hap-mini")).toBe(undefined); // not in map (auto-resolves elsewhere)
  });

  test("series pages (www_codes) do not force-attach a single code", () => {
    // A series page fronts several member products; there is no single canonical product to
    // attach, so the force-attach path must skip it (members are seeded for fetch instead).
    expect(hardwareWwwMap()["crs-series"]?.www_codes?.length).toBeGreaterThan(1);
    expect(curatedWwwCodeForSlug("crs-series")).toBe(undefined);
  });

  test("status-only entries contribute no code", () => {
    expect(hardwareWwwMap().compliance?.status).toBe("skip");
    expect(curatedWwwCodeForSlug("compliance")).toBe(undefined);
    expect(curatedWwwCodes()).not.toContain(undefined);
  });

  test("curatedWwwCodes flattens single + series member codes, de-duplicated", () => {
    const codes = curatedWwwCodes();
    expect(codes).toContain("RBSXTG-2HnDr2-168"); // single
    expect(codes).toContain("CRS109-8G-1S-2HnD-IN"); // series member
    expect(new Set(codes).size).toBe(codes.length); // no dupes
  });

  test("seed_only module/kit entries seed their code but never force-attach", () => {
    // R11e-LR8G is a subcode of the wAP/KNOT LR8G kits, which own that identity at matrix
    // rank — attaching the standalone module row would trip the catalog invariants. So the
    // code is seeded for fetch (curatedWwwCodes) but curatedWwwCodeForSlug refuses to attach.
    expect(hardwareWwwMap()["r11e-lr8g"]?.seed_only).toBe(true);
    expect(curatedWwwCodeForSlug("r11e-lr8g")).toBe(undefined);
    expect(curatedWwwCodeForSlug("r11e-lr8")).toBe(undefined);
    expect(curatedWwwCodeForSlug("ltap-lr8-lte6-kit")).toBe(undefined);
    expect(curatedWwwCodes()).toContain("r11e_lr8g"); // still seeded for the fetch
    // r11e-lr9 (non-G) has no kit collision, so it DOES force-attach (a real gap closure).
    expect(curatedWwwCodeForSlug("r11e-lr9")).toBe("r11e_lr9");
  });
});
