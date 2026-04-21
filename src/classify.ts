/**
 * classify.ts — Pre-search input classifier for `routeros_search` / TUI.
 *
 * Cheap regex-based detectors that run before any DB query. Each detector
 * fires independently and non-exclusively: "bgp 7.22 route reflection" fires
 * topic + version + general FTS together. `searchAll()` uses the output to
 * route side queries in parallel (changelogs by version/category, device
 * lookups, property resolution) without re-parsing the input.
 *
 * Pure module — no DB, no I/O. DB-backed resolution (property exists?
 * device matches a real product?) happens in `searchAll()`.
 *
 * See DESIGN.md "North Star Architecture — Unified routeros_search".
 */

import { canonicalize } from "./canonicalize.ts";

/**
 * Known RouterOS topics — extracted from changelog categories, top-level
 * command tree names, and common subsystem tokens. Used by the classifier
 * to recognize domain-specific terms before FTS search.
 *
 * Source: `SELECT DISTINCT category FROM changelogs` (153 values) plus
 * top-level commands (app, interface, ip, system) and common synonyms.
 *
 * Defined here (not in query.ts) so classify.ts stays pure (no DB imports)
 * and classify.test.ts cannot transitively load db.ts before test setup.
 */
export const KNOWN_TOPICS = new Set([
  // --- From changelog categories (high-frequency subsystems) ---
  "api", "backup", "bgp", "bluetooth", "bonding", "bridge", "capsman",
  "certificate", "chr", "cloud", "conntrack", "console", "container",
  "defconf", "discovery", "disk", "dns", "dot1x", "dude",
  "ethernet", "export", "fetch", "filesystem", "firewall",
  "gps", "graphing", "hardware", "health", "hotspot",
  "ike1", "ike2", "interface", "ipsec", "ipv6",
  "l2tp", "l3hw", "ldp", "led", "log", "lora", "lte",
  "macsec", "mlag", "modem", "mpls", "mqtt",
  "netinstall", "netwatch", "ntp",
  "ospf", "ovpn",
  "poe", "ppp", "pppoe", "pptp", "ptp",
  "queue", "quickset",
  "radius", "resource", "rip", "romon", "route", "routing",
  "serial", "sfp", "smb", "sms", "sniffer", "snmp", "socks", "ssh", "ssl", "sstp",
  "switch", "system",
  "traceroute", "tunnels", "upgrade", "upnp", "ups", "usb", "user",
  "vlan", "vpls", "vrf", "vrrp", "vxlan",
  "webfig", "wifi", "wifiwave2", "winbox", "wireguard", "wireless",
  "zerotier",
  // --- From changelog (DHCP variants, routing sub-protocols) ---
  "dhcp", "dhcpv4", "dhcpv6", "rpki", "pimsm",
  // --- Top-level command paths ---
  "app", "ip",
  // --- Common subsystem shorthand / synonyms ---
  "nat", "mangle", "raw", "filter",
  "bgp-vpn", "user-manager", "traffic-flow", "traffic-generator",
  "route-filter", "routing-filter", "mac-telnet",
  "w60g", "tr069",
]);

export type CommandFragment = {
  /** `key=value` pairs extracted from the input (e.g. `chain=forward`). */
  pairs: Array<{ key: string; value: string }>;
  /** RouterOS verbs mentioned in the input (e.g. `add`, `set`, `print`). */
  verbs: string[];
};

export type QueryClassification = {
  /** Raw input (unchanged). */
  input: string;
  /** RouterOS version tag if a `7.X[.Y][betaN|rcN]` pattern was found. First match wins. */
  version?: string;
  /** Known-topic tokens — matched against `KNOWN_TOPICS`. Capped at 5 to keep side queries cheap. */
  topics: string[];
  /** Canonical command path (e.g. `/ip/firewall/filter`) if the input looks path-ish. */
  command_path?: string;
  /** `key=value` pairs / verbs parsed from fragment-style input (`add chain=forward`). */
  command_fragment?: CommandFragment;
  /** Device model candidate (e.g. `RB1100AHx4`, `hAP`, `CCR2216`). DB resolution happens in searchAll. */
  device?: string;
  /**
   * Property-name candidate — single lowercase token that *might* be a property name.
   * Only set when input is a single short token not matched by any other detector.
   * searchAll must verify existence in `properties.name` before acting on it.
   */
  property?: string;
};

/** Version pattern: `7.22`, `7.22.1`, `7.23beta2`, `7.22rc1`. No leading \b so `v7.22` still matches. */
const VERSION_RE = /7\.\d+(?:\.\d+)?(?:beta\d+|rc\d+)?/;

/** key=value pattern — captures `chain=forward`, `action=accept`, `ssid="My Net"` (unquoted only here). */
const FRAGMENT_RE = /([a-z][a-z0-9-]{0,30})=([^\s]+)/gi;

/**
 * Device model patterns. Order matters — specific prefixes before generic.
 * Captures the full model token so searchAll can pass it to searchDevices.
 */
const DEVICE_PATTERNS: RegExp[] = [
  /\bRB\d+[A-Za-z0-9+-]*\b/,           // RB450G, RB1100AHx4, RB5009UG+S+IN
  /\bCCR\d+[A-Za-z0-9+-]*\b/,          // CCR2216-1G-12XS-2XQ
  /\bCRS\d+[A-Za-z0-9+-]*\b/,          // CRS354-48G-4S+2Q+RM
  /\bCSS\d+[A-Za-z0-9+-]*\b/,          // CSS610-8P-2S+IN
  /\bSXT\d*[A-Za-z0-9+-]*\b/,          // SXTsq, SXT5
  /\bLHG[A-Za-z0-9+-]*\b/i,            // LHG, LHGG-60ad
  /\bLtAP[A-Za-z0-9+-]*\b/i,           // LtAP, LtAP mini
  /\bh(?:EX|AP)[A-Za-z0-9+-]*\b/,      // hEX, hEX S, hAP, hAP ax²
  /\b[cwm]AP[A-Za-z0-9+-]*\b/,         // cAP, wAP, mAP, cAP ac
  /\bnetPower[A-Za-z0-9+-]*\b/i,       // netPower 15FR
  /\bnetMetal[A-Za-z0-9+-]*\b/i,       // netMetal 5
  /\bGroove[A-Za-z0-9+-]*\b/i,         // Groove A-52HPn
];

const VERB_TOKENS = new Set([
  "add", "set", "print", "remove", "edit", "enable", "disable",
  "export", "import", "find", "get", "reset", "move",
  "monitor", "scan", "run", "start", "stop",
]);

/** Single-word tokens that look like a potential property name. */
const PROPERTY_CANDIDATE_RE = /^[a-z][a-z0-9-]{2,30}$/;

const MAX_TOPICS = 5;

/** Tokenize input into lowercase alphanumeric words, preserving dashes. */
function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/** Detect RouterOS version tag. First match only — "compare 7.21 and 7.22" keeps `7.21`. */
function detectVersion(input: string): string | undefined {
  const m = VERSION_RE.exec(input);
  return m ? m[0] : undefined;
}

/** Detect command path. Uses canonicalize.primaryPath for robust handling of `/ip address`, `ip/address`, etc. */
function detectCommandPath(input: string): string | undefined {
  // Heuristic: only run the canonicalizer if the input contains a forward slash
  // OR starts with a known top-level command word. Otherwise every "routing"
  // query would be classified as a command path.
  const trimmed = input.trim();
  const hasSlash = trimmed.includes("/");
  const firstToken = trimmed.split(/\s+/)[0]?.toLowerCase();
  const topLevels = new Set(["ip", "ipv6", "interface", "routing", "system", "bridge", "container", "port", "radius", "snmp", "tool", "user", "queue", "certificate", "file", "log", "disk", "caps-man", "mpls", "ppp", "special-login", "app"]);
  if (!hasSlash && (!firstToken || !topLevels.has(firstToken))) return undefined;

  try {
    // Prefer the parsed command's dir path if a verb was recognized; otherwise
    // fall back to finalPath (pure navigation like `/ip/firewall/filter`).
    const { commands, finalPath } = canonicalize(trimmed, "/");
    const primary = commands.find((c) => !c.subshell) ?? commands[0];
    const path = primary?.path ?? finalPath;
    if (!path || path === "/") return undefined;
    return path;
  } catch {
    return undefined;
  }
}

/** Extract `key=value` pairs and RouterOS verbs from fragment-style input. */
function detectCommandFragment(input: string): CommandFragment | undefined {
  const pairs: Array<{ key: string; value: string }> = [];
  FRAGMENT_RE.lastIndex = 0;
  for (let m = FRAGMENT_RE.exec(input); m !== null; m = FRAGMENT_RE.exec(input)) {
    pairs.push({ key: m[1].toLowerCase(), value: m[2] });
  }

  const verbs: string[] = [];
  for (const tok of tokenize(input)) {
    if (VERB_TOKENS.has(tok) && !verbs.includes(tok)) verbs.push(tok);
  }

  if (pairs.length === 0 && verbs.length === 0) return undefined;
  return { pairs, verbs };
}

/** Detect device model mention. Returns first match; searchDevices handles disambiguation. */
function detectDevice(input: string): string | undefined {
  for (const pattern of DEVICE_PATTERNS) {
    const m = pattern.exec(input);
    if (m) return m[0];
  }
  return undefined;
}

/** Match tokens against KNOWN_TOPICS. Deduplicated, capped, in first-seen order. */
function detectTopics(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of tokenize(input)) {
    if (KNOWN_TOPICS.has(tok) && !seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
      if (out.length >= MAX_TOPICS) break;
    }
  }
  return out;
}

/**
 * Flag a property-name candidate: single token that looks like an identifier
 * and isn't already classified as anything else. searchAll will verify against
 * `properties.name`.
 */
function detectProperty(
  input: string,
  opts: { hasPath: boolean; hasDevice: boolean; hasFragment: boolean; topics: string[] },
): string | undefined {
  const trimmed = input.trim();
  // Only single-token inputs are property candidates — multi-word inputs go to FTS search.
  if (!PROPERTY_CANDIDATE_RE.test(trimmed)) return undefined;
  if (opts.hasPath || opts.hasDevice || opts.hasFragment) return undefined;
  // If the token is itself a known topic, prefer that classification — topic routing beats property lookup.
  if (opts.topics.includes(trimmed.toLowerCase())) return undefined;
  return trimmed.toLowerCase();
}

/**
 * Classify a user query. Detectors run independently; return object lists every
 * signal found so `searchAll()` can route parallel side queries.
 */
export function classifyQuery(input: string): QueryClassification {
  const normalized = input ?? "";
  const result: QueryClassification = {
    input: normalized,
    topics: [],
  };

  if (!normalized.trim()) return result;

  const version = detectVersion(normalized);
  if (version) result.version = version;

  const commandPath = detectCommandPath(normalized);
  if (commandPath) result.command_path = commandPath;

  const fragment = detectCommandFragment(normalized);
  if (fragment) result.command_fragment = fragment;

  const device = detectDevice(normalized);
  if (device) result.device = device;

  result.topics = detectTopics(normalized);

  const property = detectProperty(normalized, {
    hasPath: !!commandPath,
    hasDevice: !!device,
    hasFragment: !!fragment,
    topics: result.topics,
  });
  if (property) result.property = property;

  return result;
}
