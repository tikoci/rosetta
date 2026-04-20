/**
 * classify.test.ts — Table-driven unit tests for the input classifier.
 *
 * Pure-function module — no DB required. Covers each detector in the DESIGN.md
 * detector table plus real overlap cases (topic + version, command-path + topic).
 */
import { describe, expect, test } from "bun:test";

import { classifyQuery } from "./classify.ts";

type Expectation = {
  version?: string;
  topics?: string[];        // must be a subset of detected topics (order-insensitive)
  topicsExact?: string[];   // exact match on detected topics (order-sensitive)
  command_path?: string;
  fragment_pairs?: Array<{ key: string; value: string }>;
  fragment_verbs?: string[];
  device?: string;
  property?: string;
  none?: boolean;           // assert no signals detected
};

const CASES: Array<{ name: string; input: string; expect: Expectation }> = [
  // --- Empty / noise ---
  { name: "empty input", input: "", expect: { none: true } },
  { name: "whitespace only", input: "   \t  ", expect: { none: true } },

  // --- Topic detection (KNOWN_TOPICS) ---
  { name: "single topic — bgp", input: "bgp neighbor configuration", expect: { topics: ["bgp"] } },
  { name: "two topics — dhcp + server synonym", input: "dhcp server lease timeout", expect: { topics: ["dhcp"] } },
  { name: "firewall + filter compound", input: "how do I configure firewall filter", expect: { topics: ["firewall", "filter"] } },
  { name: "routing + ospf", input: "routing ospf area configuration", expect: { topics: ["routing", "ospf"] } },
  { name: "wireguard topic", input: "wireguard peer setup", expect: { topics: ["wireguard"] } },
  { name: "ipv6 topic", input: "ipv6 address configuration", expect: { topics: ["ipv6"] } },

  // --- Version detection ---
  { name: "stable version 7.22", input: "what changed in 7.22", expect: { version: "7.22" } },
  { name: "patch version 7.22.1", input: "7.22.1 release notes", expect: { version: "7.22.1" } },
  { name: "beta version 7.23beta2", input: "whats new in 7.23beta2", expect: { version: "7.23beta2" } },
  { name: "rc version 7.22rc1", input: "7.22rc1 bug", expect: { version: "7.22rc1" } },
  { name: "version with v prefix", input: "v7.22 changelog", expect: { version: "7.22" } },
  { name: "first-match wins on two versions", input: "compare 7.21 and 7.22", expect: { version: "7.21" } },

  // --- Topic + version overlap (DESIGN.md canonical example) ---
  {
    name: "topic + version + general",
    input: "bgp 7.22 route reflection",
    expect: { topics: ["bgp", "route"], version: "7.22" },
  },
  {
    name: "changelog-like topic+version",
    input: "firewall raw 7.22 breaking",
    expect: { topics: ["firewall", "raw"], version: "7.22" },
  },

  // --- Command path detection ---
  {
    name: "absolute slash path",
    input: "/ip/firewall/filter",
    expect: { command_path: "/ip/firewall/filter", topics: ["ip", "firewall", "filter"] },
  },
  {
    name: "space-separated absolute path",
    input: "/ip firewall filter",
    expect: { command_path: "/ip/firewall/filter" },
  },
  {
    name: "path without leading slash",
    input: "ip firewall filter",
    expect: { command_path: "/ip/firewall/filter" },
  },
  {
    name: "system scheduler path",
    input: "/system/scheduler",
    expect: { command_path: "/system/scheduler", topics: ["system"] },
  },
  {
    name: "ipv6 firewall raw",
    input: "/ipv6/firewall/raw",
    expect: { command_path: "/ipv6/firewall/raw", topics: ["ipv6", "firewall", "raw"] },
  },

  // --- Command fragment (key=value, verbs) ---
  {
    name: "add with two pairs",
    input: "add chain=forward action=accept",
    expect: {
      fragment_pairs: [{ key: "chain", value: "forward" }, { key: "action", value: "accept" }],
      fragment_verbs: ["add"],
    },
  },
  {
    name: "set disabled=no",
    input: "set disabled=no",
    expect: {
      fragment_pairs: [{ key: "disabled", value: "no" }],
      fragment_verbs: ["set"],
    },
  },
  {
    name: "print without pairs",
    input: "print detail",
    expect: { fragment_verbs: ["print"] },
  },

  // --- Device model ---
  { name: "RB model", input: "RB1100AHx4 specs", expect: { device: "RB1100AHx4" } },
  { name: "CCR with dashes", input: "CCR2216-1G-12XS-2XQ throughput", expect: { device: "CCR2216-1G-12XS-2XQ" } },
  { name: "CRS switch", input: "CRS354 port count", expect: { device: "CRS354" } },
  { name: "hEX", input: "hEX S performance", expect: { device: "hEX" } },
  { name: "hAP ax", input: "hAP ax specs", expect: { device: "hAP" } },
  { name: "cAP ac", input: "cAP ac indoor", expect: { device: "cAP" } },
  { name: "SXTsq", input: "SXTsq 5 config", expect: { device: "SXTsq" } },

  // --- Property name candidate (single short lowercase token) ---
  { name: "property — chain", input: "chain", expect: { property: "chain" } },
  { name: "property — fastpath", input: "fastpath", expect: { property: "fastpath" } },
  {
    name: "single known-topic token is NOT classified as property",
    input: "bgp",
    expect: { topics: ["bgp"] },
  },

  // --- Non-exclusive / complex inputs ---
  {
    name: "device + topic",
    input: "RB5009 wireguard performance",
    expect: { device: "RB5009", topics: ["wireguard"] },
  },
  {
    name: "container add with verb",
    input: "container add remote-image",
    expect: { topics: ["container"], fragment_verbs: ["add"] },
  },
];

describe("classifyQuery", () => {
  for (const { name, input, expect: want } of CASES) {
    test(name, () => {
      const result = classifyQuery(input);

      if (want.none) {
        expect(result.version).toBeUndefined();
        expect(result.command_path).toBeUndefined();
        expect(result.command_fragment).toBeUndefined();
        expect(result.device).toBeUndefined();
        expect(result.property).toBeUndefined();
        expect(result.topics).toEqual([]);
        return;
      }

      if (want.version !== undefined) expect(result.version).toBe(want.version);
      if (want.command_path !== undefined) expect(result.command_path).toBe(want.command_path);
      if (want.device !== undefined) expect(result.device).toBe(want.device);
      if (want.property !== undefined) expect(result.property).toBe(want.property);

      if (want.topics !== undefined) {
        for (const t of want.topics) {
          expect(result.topics).toContain(t);
        }
      }
      if (want.topicsExact !== undefined) expect(result.topics).toEqual(want.topicsExact);

      if (want.fragment_pairs !== undefined) {
        expect(result.command_fragment?.pairs).toEqual(want.fragment_pairs);
      }
      if (want.fragment_verbs !== undefined) {
        expect(result.command_fragment?.verbs).toEqual(want.fragment_verbs);
      }
    });
  }

  test("multi-word input never fires property detector", () => {
    const result = classifyQuery("chain forward policy");
    expect(result.property).toBeUndefined();
  });

  test("property detector yields to command_path", () => {
    // "interface" is a top-level command and a known topic — path wins over property
    const result = classifyQuery("interface");
    expect(result.property).toBeUndefined();
  });

  test("property detector yields to device", () => {
    const result = classifyQuery("RB5009");
    expect(result.property).toBeUndefined();
    expect(result.device).toBe("RB5009");
  });

  test("version regex doesn't swallow arbitrary decimals", () => {
    const result = classifyQuery("interface stats show 5.0 Gbps");
    expect(result.version).toBeUndefined();
  });

  test("topics are deduplicated", () => {
    const result = classifyQuery("firewall firewall filter firewall");
    const firewallCount = result.topics.filter((t) => t === "firewall").length;
    expect(firewallCount).toBe(1);
  });

  test("topics capped at 5", () => {
    const result = classifyQuery("bgp ospf rip dhcp dns routing wireguard ipsec");
    expect(result.topics.length).toBeLessThanOrEqual(5);
  });
});
