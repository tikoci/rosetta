import { describe, expect, test } from "bun:test";
import {
  flattenedRun,
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

  test("a legacy Confluence app-route URL is NOT parsed as a slug — it falls back to the breadcrumb", () => {
    // help.mikrotik.com/docs/spaces/ROS/pages/<id>/... also contains '/docs/' but the
    // tail (spaces/ROS/pages/<id>/...) is an app route, not a semantic doc path.
    expect(
      pageIdentitySegs("https://help.mikrotik.com/docs/spaces/ROS/pages/328059/Firewall", "RouterOS > Firewall"),
    ).toEqual(["routeros", "firewall"]);
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

describe("flattenedRun", () => {
  test("counts trailing command segments spelled out as in-order `-` components", () => {
    expect(flattenedRun(["interface", "bridge", "vlan"], "bridge-vlan-table")).toBe(2);
    expect(flattenedRun(["ip", "packing"], "ip-packing")).toBe(2);
  });

  test("a lone component, an out-of-order run, or an unhyphenated segment is not a run", () => {
    expect(flattenedRun(["container"], "container-freeradius-server")).toBe(0);
    expect(flattenedRun(["interface", "vlan"], "basic-vlan-switching")).toBe(0);
    expect(flattenedRun(["vlan", "bridge"], "bridge-vlan-table")).toBe(0);
    expect(flattenedRun(["ip", "firewall"], "firewall")).toBe(0);
  });
});

describe("pickBestPageId", () => {
  test("#131: /interface/bridge/vlan links to Bridge VLAN Table, not VLANs on Wireless", () => {
    const candidates: PageCandidate[] = [
      { id: 350, segs: ["wireless", "abgn", "vlans-on-wireless"], propCount: 0 }, // prefix `vlan` ↔ `vlans-…`
      { id: 24, segs: ["bridging-and-switching", "user-guides", "basic-vlan-switching"], propCount: 0 },
      { id: 26, segs: ["bridging-and-switching", "user-guides", "bridge-vlan-table"], propCount: 0 },
    ];
    expect(pickBestPageId("/interface/bridge/vlan", candidates)).toBe(26);
  });

  test("an exact component run outscores a prefix match, even against more properties", () => {
    const run = scoreCandidate(["interface", "bridge", "vlan"], ["user-guides", "bridge-vlan-table"], 0);
    const prefix = scoreCandidate(["interface", "bridge", "vlan"], ["abgn", "vlans-on-wireless"], 999);
    expect(run).toBeGreaterThan(prefix);
  });

  test("a single shared component is not credited above a prefix (/container keeps Container)", () => {
    // Both are prefix matches today; crediting the lone `container` component would hand
    // /container to the freeradius user guide (26 rows re-pointed in the #131 corpus diff).
    const candidates: PageCandidate[] = [
      { id: 35, segs: ["containers"], propCount: 60 },
      { id: 39, segs: ["containers", "user-guides", "container-freeradius-server"], propCount: 0 },
    ];
    expect(pickBestPageId("/container", candidates)).toBe(35);
  });

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
