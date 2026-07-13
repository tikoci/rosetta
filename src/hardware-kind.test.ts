/**
 * Anchor tests for classifyHardwareKind (src/hardware-kind.ts).
 *
 * Lock the current classification of the unmatched `/hardware` set (the 2026-07 review) so the
 * rules can be refactored safely and so step-2 DB/MCP/TUI surfaces that reuse this call have a
 * stable contract. Each case names the real page and the rule that catches it. See
 * briefings/B-0018-product-naming-three-source-map.md.
 */
import { describe, expect, test } from "bun:test";
import { classifyHardwareKind } from "./hardware-kind.ts";

describe("classifyHardwareKind", () => {
  test("off-matrix routers/CPEs are devices", () => {
    expect(classifyHardwareKind("rb2011il-in", "Ethernet routers", false)).toBe("device");
    expect(classifyHardwareKind("ccr1016-12g", "Ethernet routers", false)).toBe("device");
    expect(classifyHardwareKind("chateau-lte6", "LTE products", false)).toBe("device");
    expect(classifyHardwareKind("pwr-line-pro", "Data over Powerlines", false)).toBe("device");
  });

  test("Accessories/Antennas/Interfaces categories are accessories", () => {
    expect(classifyHardwareKind("gper", "Accessories", false)).toBe("accessory");
    expect(classifyHardwareKind("woobm-usb", "Accessories", false)).toBe("accessory");
    expect(classifyHardwareKind("s-3553lc20d", "Interfaces", false)).toBe("accessory");
  });

  test("standalone LoRa/BT radio SKUs are modules", () => {
    expect(classifyHardwareKind("r11e-lr8", "IoT products", false)).toBe("module");
    expect(classifyHardwareKind("r11e-lr9g", "IoT products", false)).toBe("module");
    expect(classifyHardwareKind("tg-bt5-in", "IoT products", false)).toBe("module");
    expect(classifyHardwareKind("tg-lr82", "IoT products", false)).toBe("module");
  });

  test("series/index and doc pages are series-or-doc", () => {
    expect(classifyHardwareKind("wap-60g-series", "60 GHz products", true)).toBe("series-or-doc");
    // `-series` slug alone classifies even if the isSeries flag is missing
    expect(classifyHardwareKind("crs-series", "Switches", false)).toBe("series-or-doc");
    expect(classifyHardwareKind("compliance", "Wireless systems", false)).toBe("series-or-doc");
  });

  test("OVERRIDES wins over every rule (nray-series is one kit, not a family)", () => {
    // `-series` suffix + isSeries would say series-or-doc, but the override forces device.
    expect(classifyHardwareKind("nray-series", "60 GHz products", true)).toBe("device");
  });

  test("series wins over the category rule (an accessory/antenna series page is still series-or-doc)", () => {
    expect(classifyHardwareKind("mtp250-series", "Accessories", false)).toBe("series-or-doc");
    expect(classifyHardwareKind("mant-series", "Antennas", false)).toBe("series-or-doc");
  });

  test("a kit that bundles a module is a device, not a module (only standalone SKUs are modules)", () => {
    expect(classifyHardwareKind("ltap-lr8-lte6-kit", "IoT products", false)).toBe("device");
    expect(classifyHardwareKind("wap-lr9-kit", "IoT products", false)).toBe("device");
  });
});
