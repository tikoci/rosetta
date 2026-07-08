import { describe, expect, test } from "bun:test";
import { checkCollisions, deriveRosettaId, parseSitemapLocs, rosettaIdToUrl } from "./rosetta-id.ts";

describe("deriveRosettaId", () => {
  test("strips scheme, host, and leading/trailing slashes", () => {
    expect(deriveRosettaId("https://manual.mikrotik.com/docs/ip/address/")).toBe("docs/ip/address");
  });

  test("lowercases mixed-case path segments", () => {
    expect(deriveRosettaId("https://manual.mikrotik.com/docs/CLI-Reference/Routing/BGP")).toBe(
      "docs/cli-reference/routing/bgp",
    );
  });

  test("passes through a bare path (no scheme/host)", () => {
    expect(deriveRosettaId("/docs/ip/dhcp-server")).toBe("docs/ip/dhcp-server");
  });

  test("strips an optional /docs/next/ version prefix", () => {
    expect(deriveRosettaId("https://manual.mikrotik.com/docs/next/ip/address")).toBe("docs/ip/address");
  });

  test("strips an optional /docs/<semver>/ version prefix", () => {
    expect(deriveRosettaId("https://manual.mikrotik.com/docs/7.22/ip/address")).toBe("docs/ip/address");
  });

  test("does not strip a real path segment that merely looks numeric-ish but isn't a version", () => {
    // "next" and semver-like segments only get stripped directly after /docs/ — elsewhere they're just path.
    expect(deriveRosettaId("https://manual.mikrotik.com/docs/ip/next")).toBe("docs/ip/next");
  });

  test("strips a .md/.mdx extension so a page and a link resolving to it agree", () => {
    expect(deriveRosettaId("https://manual.mikrotik.com/docs/network-management/dhcp")).toBe(
      deriveRosettaId("https://manual.mikrotik.com/docs/network-management/dhcp.md"),
    );
    expect(deriveRosettaId("https://manual.mikrotik.com/docs/network-management/dhcp.md#dhcp-server")).toBe(
      "docs/network-management/dhcp",
    );
  });

  test("handles non-/docs sections unchanged", () => {
    expect(deriveRosettaId("https://manual.mikrotik.com/hardware/rb5009")).toBe("hardware/rb5009");
    expect(deriveRosettaId("https://manual.mikrotik.com/changelog/changelog-2026-05-25")).toBe(
      "changelog/changelog-2026-05-25",
    );
  });
});

describe("rosettaIdToUrl", () => {
  test("round-trips with deriveRosettaId for a canonical URL", () => {
    const url = "https://manual.mikrotik.com/docs/network-management/dhcp";
    expect(rosettaIdToUrl(deriveRosettaId(url))).toBe(url);
  });
});

describe("checkCollisions", () => {
  test("reports zero collisions for distinct paths", () => {
    const report = checkCollisions([
      "https://manual.mikrotik.com/docs/ip/address",
      "https://manual.mikrotik.com/docs/ip/route",
    ]);
    expect(report.collisions.size).toBe(0);
    expect(report.uniqueIds).toBe(2);
  });

  test("detects a real collision (case-only difference)", () => {
    const report = checkCollisions([
      "https://manual.mikrotik.com/docs/IP/Address",
      "https://manual.mikrotik.com/docs/ip/address",
    ]);
    expect(report.collisions.size).toBe(1);
    expect(report.collisions.get("docs/ip/address")?.length).toBe(2);
  });

  test("detects a collision introduced by version-prefix stripping", () => {
    const report = checkCollisions([
      "https://manual.mikrotik.com/docs/ip/address",
      "https://manual.mikrotik.com/docs/next/ip/address",
    ]);
    expect(report.collisions.size).toBe(1);
  });
});

describe("parseSitemapLocs", () => {
  test("extracts <loc> entries from sitemap XML", () => {
    const xml = `<?xml version="1.0"?><urlset>
      <url><loc>https://manual.mikrotik.com/docs/ip/address</loc></url>
      <url><loc>https://manual.mikrotik.com/docs/ip/route</loc></url>
    </urlset>`;
    expect(parseSitemapLocs(xml)).toEqual([
      "https://manual.mikrotik.com/docs/ip/address",
      "https://manual.mikrotik.com/docs/ip/route",
    ]);
  });
});
