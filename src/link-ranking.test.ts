import { describe, expect, test } from "bun:test";
import {
  type PageCandidate,
  pageIdentitySegs,
  pickBestPageId,
  scoreCandidate,
  segMatch,
} from "./link-ranking.ts";

describe("segMatch", () => {
  test("exact match beats prefix relationship", () => {
    expect(segMatch("filter", "filter")).toBe(3);
    expect(segMatch("dhcp-server", "dhcp")).toBe(2); // prefix
    expect(segMatch("dhcp", "dhcp-server")).toBe(2); // symmetric
    expect(segMatch("filter", "bridging-and-switching")).toBe(0);
  });

  test("short (<3 char) tokens only match exactly — 'ip' never prefix-matches", () => {
    expect(segMatch("ip", "ipsec")).toBe(0); // would be a false positive at 2 chars
    expect(segMatch("ip", "ip")).toBe(3);
  });
});

describe("pageIdentitySegs", () => {
  test("derives tail segments from a /docs/ slug", () => {
    expect(pageIdentitySegs("https://manual.mikrotik.com/docs/firewall-and-quality-of-service/firewall/filter")).toEqual(
      ["firewall-and-quality-of-service", "firewall", "filter"],
    );
  });

  test("falls back to the breadcrumb path, dropping the leading 'docs'", () => {
    expect(pageIdentitySegs(null, "docs > firewall-and-quality-of-service > firewall > filter")).toEqual([
      "firewall-and-quality-of-service",
      "firewall",
      "filter",
    ]);
  });
});

describe("scoreCandidate", () => {
  test("scores contiguous trailing segments, anchored at the leaf", () => {
    // /ip/firewall/filter vs .../firewall/filter → filter(3) + firewall(3)
    expect(scoreCandidate(["ip", "firewall", "filter"], ["firewall-and-quality-of-service", "firewall", "filter"], 0)).toBe(
      6 * 1000,
    );
  });

  test("an unaligned page scores 0 no matter how many properties it has (the /ip → bridging bug)", () => {
    expect(scoreCandidate(["ip"], ["bridging-and-switching"], 500)).toBe(0);
  });

  test("property count only tie-breaks among aligned pages", () => {
    const a = scoreCandidate(["ip", "dns"], ["network-management", "dns"], 3);
    const b = scoreCandidate(["ip", "dns"], ["network-management", "dns"], 1);
    expect(a).toBeGreaterThan(b);
    expect(a - b).toBe(2); // pure tie-break delta, dwarfed by the depth term
  });
});

describe("pickBestPageId", () => {
  test("the authoritative (path-aligned) page beats a property-rich unrelated page", () => {
    const candidates: PageCandidate[] = [
      { id: 1, segs: ["bridging-and-switching", "l3-hardware-offloading"], propCount: 50 }, // rich but wrong
      { id: 2, segs: ["firewall-and-quality-of-service", "firewall", "filter"], propCount: 0 }, // aligned
    ];
    expect(pickBestPageId("/ip/firewall/filter", candidates)).toBe(2);
  });

  test("prefix-aligned doc slug wins (/ip/dhcp-server ↔ .../dhcp)", () => {
    expect(
      pickBestPageId("/ip/dhcp-server", [{ id: 7, segs: ["network-management", "dhcp"], propCount: 3 }]),
    ).toBe(7);
  });

  test("returns null when no candidate aligns — the command is left unlinked, not mis-linked", () => {
    const candidates: PageCandidate[] = [
      { id: 1, segs: ["bridging-and-switching"], propCount: 50 },
      { id: 2, segs: ["authentication-authorization-accounting", "hotspot-captive-portal"], propCount: 30 },
    ];
    expect(pickBestPageId("/ip", candidates)).toBeNull();
  });

  test("deeper trailing match wins over a shallower one", () => {
    const candidates: PageCandidate[] = [
      { id: 1, segs: ["firewall-and-quality-of-service", "firewall"], propCount: 10 }, // matches 'firewall' only
      { id: 2, segs: ["firewall-and-quality-of-service", "firewall", "nat"], propCount: 0 }, // matches nat+firewall
    ];
    expect(pickBestPageId("/ip/firewall/nat", candidates)).toBe(2);
  });
});
