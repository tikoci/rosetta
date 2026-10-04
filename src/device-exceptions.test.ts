/**
 * Anchor tests for the curated device-exceptions loader (src/device-exceptions.ts): every
 * entry has a known class, and the www codes it vouches for are what assess-www seeds and
 * extract-hardware-catalog force-attaches (#155).
 */
import { describe, expect, test } from "bun:test";
import { deviceExceptions, exceptionWwwCodeForDevice, exceptionWwwCodes } from "./device-exceptions.ts";

describe("device-exceptions loader", () => {
  test("every entry carries a known class", () => {
    const classes = new Set(["curated-alias", "no-hardware-page", "no-www-product", "accessory"]);
    for (const [name, e] of Object.entries(deviceExceptions())) expect([name, classes.has(e.class)]).toEqual([name, true]);
  });

  test("a no-hardware-page device maps to its verified www code", () => {
    expect(exceptionWwwCodeForDevice("KNOT Gateway HL9")).toBe("knot_gateway_hl");
    expect(exceptionWwwCodeForDevice("hAP ax3")).toBe(undefined); // auto-resolves, not listed
  });

  test("exceptionWwwCodes is the de-duplicated set of www_code values", () => {
    const codes = exceptionWwwCodes();
    expect(codes).toContain("knot_gateway_lr8");
    expect(new Set(codes).size).toBe(codes.length);
  });
});
