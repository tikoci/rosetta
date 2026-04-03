/**
 * mcp.ts — MCP server for RouterOS documentation retrieval.
 *
 * Exposes a local SQLite+FTS5 index of RouterOS docs as MCP tools,
 * enabling LLM agents to search documentation, look up properties,
 * and browse the command tree.
 *
 * CLI flags (for compiled binary or `bun run src/mcp.ts`):
 *   --setup [--force]  Download database + print MCP client config
 *   --version          Print version
 *   --help             Print usage
 *   --http             Start with Streamable HTTP transport (instead of stdio)
 *   --port <N>         HTTP listen port (default: 8080, env: PORT)
 *   --host <ADDR>      HTTP bind address (default: localhost, env: HOST)
 *   --tls-cert <PATH>  TLS certificate PEM file (enables HTTPS, env: TLS_CERT_PATH)
 *   --tls-key <PATH>   TLS private key PEM file (requires --tls-cert, env: TLS_KEY_PATH)
 *   (default)          Start MCP server (stdio transport)
 *
 * Environment variables:
 *   DB_PATH — absolute path to ros-help.db (default: next to binary or project root)
 *   PORT    — HTTP listen port (lower precedence than --port)
 *   HOST    — HTTP bind address (lower precedence than --host)
 *   TLS_CERT_PATH — TLS certificate path (lower precedence than --tls-cert)
 *   TLS_KEY_PATH  — TLS private key path (lower precedence than --tls-key)
 */

import { resolveVersion } from "./paths.ts";

const RESOLVED_VERSION = resolveVersion(import.meta.dirname);

// ── CLI dispatch (before MCP server init) ──

const args = process.argv.slice(2);

/** Extract the value following a named flag (e.g. --port 8080 → "8080") */
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(`rosetta ${RESOLVED_VERSION}`);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`rosetta ${RESOLVED_VERSION} — MCP server for RouterOS documentation`);
  console.log();
  console.log("Usage:");
  console.log("  rosetta              Start MCP server (stdio transport)");
  console.log("  rosetta --http       Start with Streamable HTTP transport");
  console.log("  rosetta --setup      Download database + print MCP client config");
  console.log("  rosetta --setup --force  Re-download database");
  console.log("  rosetta --version    Print version");
  console.log("  rosetta --help       Print this help");
  console.log();
  console.log("HTTP options (require --http):");
  console.log("  --port <N>           Listen port (default: 8080, env: PORT)");
  console.log("  --host <ADDR>        Bind address (default: localhost, env: HOST)");
  console.log("  --tls-cert <PATH>    TLS certificate PEM file (env: TLS_CERT_PATH)");
  console.log("  --tls-key <PATH>     TLS private key PEM file (env: TLS_KEY_PATH)");
  console.log();
  console.log("Environment:");
  console.log("  DB_PATH  Absolute path to ros-help.db (optional)");
  console.log("  PORT     HTTP listen port (lower precedence than --port)");
  console.log("  HOST     HTTP bind address (lower precedence than --host)");
  console.log("  TLS_CERT_PATH  TLS certificate path (lower precedence than --tls-cert)");
  console.log("  TLS_KEY_PATH   TLS private key path (lower precedence than --tls-key)");
  process.exit(0);
}

// Wrap in async IIFE — bun build --compile does not support top-level await
(async () => {

if (args.includes("--setup")) {
  const { runSetup } = await import("./setup.ts");
  await runSetup(args.includes("--force"));
  process.exit(0);
}

// ── MCP Server ──

const useHttp = args.includes("--http");

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = await import("zod/v3");

// Dynamic imports — db.ts eagerly opens the DB file on import,
// so we must import after the --setup guard to avoid creating
// an empty ros-help.db on fresh installs.
//
// Check if DB has data BEFORE importing db.ts. If empty/missing,
// auto-download so db.ts opens the real database.
const { resolveDbPath } = await import("./paths.ts");
const _dbPath = resolveDbPath(import.meta.dirname);

const _pageCount = (() => {
  try {
    const check = new (require("bun:sqlite").default)(_dbPath, { readonly: true });
    const row = check.prepare("SELECT COUNT(*) AS c FROM pages").get() as { c: number };
    check.close();
    return row.c;
  } catch {
    return 0;
  }
})();

if (_pageCount === 0) {
  const { downloadDb } = await import("./setup.ts");
  // Use stderr — stdout is the MCP stdio transport
  const log = (msg: string) => process.stderr.write(`${msg}\n`);
  try {
    await downloadDb(_dbPath, log);
    log("Database downloaded successfully.");
  } catch (e) {
    log(`Auto-download failed: ${e}`);
    log(`Run: ${process.argv[0]} --setup`);
  }
}

// Now import db.ts (opens the DB) and query.ts
const { getDbStats, initDb } = await import("./db.ts");
const {
  browseCommands,
  browseCommandsAtVersion,
  checkCommandVersions,
  fetchCurrentVersions,
  getPage,
  lookupProperty,
  searchCallouts,
  searchChangelogs,
  searchDevices,
  searchPages,
  searchProperties,
} = await import("./query.ts");

initDb();

/** Factory: create a new McpServer with all tools registered.
 *  Called once for stdio, or per-session for HTTP transport. */
function createServer() {

const server = new McpServer({
  name: "rosetta",
  version: RESOLVED_VERSION,
});

// ---- routeros_search ----

server.registerTool(
  "routeros_search",
  {
    description: `Search RouterOS documentation using natural language.

This is the **primary discovery tool**. Start here, then drill down with other tools.

Capabilities:
- Full-text search with BM25 ranking and Porter stemming
  ("configuring" matches "configuration", "configured", etc.)
- Proximity matching for compound terms ("firewall filter", "bridge vlan")
- Results include page title, breadcrumb path, help.mikrotik.com URL, and excerpt
- If AND returns nothing, the engine automatically retries with OR

Workflow — what to do next:
→ routeros_get_page: retrieve full content for a result (use page ID from results)
→ routeros_search_properties: find specific properties mentioned in results
→ routeros_search_callouts: find warnings/notes about topics in results
→ routeros_command_tree: browse the command hierarchy for a feature

Tips:
- Use specific technical terms: "DHCP relay agent" not "how to set up DHCP"
- Documentation: 317 pages from March 2026 Confluence export (~515K words)
- Docs reflect the then-current long-term release (~7.22), not version-pinned
- Command data: RouterOS 7.9–7.23beta2. No v6 data available.
- v6 had different syntax and subsystems — answers for v6 are unreliable.`,
    inputSchema: {
      query: z.string().describe("Natural language search query"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(8)
        .describe("Max results (default 8)"),
    },
  },
  async ({ query, limit }) => {
    const result = searchPages(query, limit);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ---- routeros_get_page ----

server.registerTool(
  "routeros_get_page",
  {
    description: `Get the full text of a RouterOS documentation page by ID or title.

Use after routeros_search identifies a relevant page. Pass the numeric page ID
(from search results) or the exact page title (case-insensitive).

Returns: plain text, code blocks, and callout blocks (notes, warnings, info, tips).
Callouts contain crucial caveats and edge-case details — always review them.

**Large page handling:** max_length defaults to 16000. When page content exceeds it,
pages with sections return a **table of contents** instead of truncated text.
The TOC lists each section's heading, hierarchy level, character count, and
deep-link URL. Re-call with the section parameter to retrieve specific sections.

**Section parameter:** Pass a section heading or anchor_id (from the TOC)
to get that section's content. If a section is still too large, its sub-section
TOC is returned instead — request a more specific sub-section.

Recommended workflow for large pages:
1. First call → get TOC if page is large (automatic with default max_length)
2. Review section headings to find the relevant section
3. Call again with section="Section Name" to get that section's content

Workflow — what to do with this content:
→ routeros_search_properties: look up specific properties mentioned in text
→ routeros_lookup_property: get exact details for a named property
→ routeros_search_callouts: find related warnings across other pages
→ routeros_command_tree: browse the command path for features on this page`,
    inputSchema: {
      page: z
        .string()
        .describe("Page ID (numeric) or exact page title"),
      max_length: z
        .number()
        .int()
        .min(1000)
        .default(16000)
        .describe("Max combined text+code length (default: 16000). If exceeded and page has sections, returns a TOC instead of truncated text. Set higher (e.g. 50000) to get more content in one call."),
      section: z
        .string()
        .optional()
        .describe("Section heading or anchor_id from TOC. Returns only that section's content (also subject to max_length)."),
    },
  },
  async ({ page, max_length, section }) => {
    const result = getPage(page, max_length, section);
    if (!result) {
      return {
        content: [{ type: "text", text: `Page not found: ${page}` }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ---- routeros_lookup_property ----

server.registerTool(
  "routeros_lookup_property",
  {
    description: `Look up a specific RouterOS configuration property by exact name.

Returns type, default value, description, and documentation page.
Optionally filter by command path to disambiguate (e.g., "disabled" appears everywhere).

This requires the **exact property name**. If you don't know the name:
→ routeros_search_properties: full-text search across property descriptions
→ routeros_search: find the documentation page, then read it with routeros_get_page

Examples:
- name: "add-default-route" → DHCP client property
- name: "dhcp-snooping" → bridge DHCP snooping toggle
- name: "disabled", command_path: "/ip/firewall/filter" → firewall filter property
- name: "chain" → shows all properties named "chain" across all pages`,
    inputSchema: {
      name: z.string().describe("Property name (e.g., 'add-default-route', 'chain')"),
      command_path: z
        .string()
        .optional()
        .describe("RouterOS command path to narrow results (e.g., '/ip/firewall/filter')"),
    },
  },
  async ({ name, command_path }) => {
    const results = lookupProperty(name, command_path);
    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No property found: "${name}"${command_path ? ` under ${command_path}` : ""}\n\nTry instead:\n- routeros_search_properties with a keyword from the property description\n- routeros_search to find the documentation page, then routeros_get_page to read it\n- routeros_command_tree at the command path to see available args`,
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  },
);

// ---- routeros_search_properties ----

server.registerTool(
  "routeros_search_properties",
  {
    description: `Search RouterOS properties by name or description text.

Full-text search across 4,860 property names and descriptions from 145 pages.
Use when you don't know the exact property name but know what it does.
If AND returns nothing, the engine automatically retries with OR.

If this returns empty:
→ routeros_search: find the documentation page containing the feature
→ routeros_get_page: read the page — properties are embedded in page text
→ routeros_command_tree: browse args at a command path for property names

Examples:
- "gateway reachability check" → finds check-gateway properties
- "snooping" → finds dhcp-snooping, igmp-snooping properties
- "trusted" → finds bridge port trusted property`,
    inputSchema: {
      query: z.string().describe("Search query for property descriptions"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max results (default 10)"),
    },
  },
  async ({ query, limit }) => {
    const results = searchProperties(query, limit);
    if (results.length === 0) {
      return {
        content: [{ type: "text", text: `No properties matched: "${query}"\n\nTry instead:\n- routeros_search to find the documentation page containing this feature\n- routeros_get_page to read properties directly from page text\n- routeros_command_tree to browse args at the command path\n- Shorter/different keywords (property descriptions are brief)` }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  },
);

// ---- routeros_command_tree ----

server.registerTool(
  "routeros_command_tree",
  {
    description: `Browse the RouterOS command tree hierarchy.

Given a menu path, returns all direct children (subdirectories, commands, and
arguments). Each child includes its type and linked documentation page if available.
Useful for discovering what's available under a command path.

Optionally filter by RouterOS version to check what exists in a specific release.
Command data covers versions 7.9–7.23beta2. No v6 data.

Workflow — combine with other tools:
→ routeros_get_page: read the linked documentation page for a command
→ routeros_lookup_property: look up arg names as properties for details
→ routeros_command_version_check: check when a command was added
→ routeros_search_properties: search for properties under this path

Examples:
- path: "/ip" → address, arp, dhcp-client, dhcp-server, firewall, route, etc.
- path: "/ip/firewall" → filter, nat, mangle, raw, address-list, etc.
- path: "", version: "7.15" → top-level menus as of RouterOS 7.15`,
    inputSchema: {
      path: z
        .string()
        .optional()
        .default("")
        .describe("RouterOS menu path (e.g., '/ip/firewall'). Empty for top-level."),
      version: z
        .string()
        .optional()
        .describe("RouterOS version to filter by (e.g., '7.15'). Omit for latest."),
    },
  },
  async ({ path, version }) => {
    const cmdPath = path?.trim() || "";
    const results = version
      ? browseCommandsAtVersion(cmdPath, version)
      : browseCommands(cmdPath);

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: `No commands found under: ${path || "/"}` }],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  },
);

// ---- routeros_stats ----

server.registerTool(
  "routeros_stats",
  {
    description: `Get database statistics for the RouterOS documentation index.

Returns page count, property count, callout count, changelog count, command count, link coverage,
version range, and documentation export date.

Knowledge boundaries:
- Documentation: March 2026 Confluence HTML export (317 pages), aligned with long-term ~7.22
- Command tree: RouterOS 7.9–7.23beta2 from inspect.json (with extra-packages from CHR)
- No RouterOS v6 data available — v6 syntax and subsystems differ significantly from v7
- For versions older than 7.9, no command tree data exists
- Versions older than current long-term are unpatched by MikroTik
- Absence of a peripheral in docs doesn't mean unsupported — most MBIM modems work`,
    inputSchema: {},
  },
  async () => {
    const stats = getDbStats();
    return {
      content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
    };
  },
);

// ---- routeros_search_callouts ----

server.registerTool(
  "routeros_search_callouts",
  {
    description: `Search note, warning, tip, and info callout blocks across all RouterOS documentation.

1,034 callouts containing important caveats, edge cases, and non-obvious behavior.
Useful for finding warnings about hardware offloading, compatibility notes,
or unexpected feature interactions that aren't obvious from main page text.

Query tips:
- Use SHORT keyword queries (1-2 terms). Callouts are brief — multi-word NL phrases often miss.
- "bridge" finds more than "bridge VLAN spanning tree conflict"
- Pass type only (no query) to browse callouts of that type
- If AND finds nothing, the engine automatically retries with OR

Optionally filter by callout type: "note" (426), "info" (357), "warning" (213), or "tip" (38).

Examples:
- query: "hardware offload" → warnings about bridge HW offloading limitations
- query: "VLAN", type: "warning" → only VLAN-related warnings
- query: "bridge", type: "warning" → bridge-related warnings
- type: "warning", limit: 20 → browse 20 warnings (no search term needed)`,
    inputSchema: {
      query: z.string().optional().default("").describe("Search keywords for callout content (keep short — 1-2 terms work best)"),
      type: z
        .enum(["note", "warning", "info", "tip"])
        .optional()
        .describe("Filter by callout type"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max results (default 10)"),
    },
  },
  async ({ query, type, limit }) => {
    const results = searchCallouts(query, type, limit);
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  },
);

// ---- routeros_search_changelogs ----

/** Group flat changelog results by version for compact output. */
function groupChangelogsByVersion(results: Array<{ version: string; released: string | null; category: string; is_breaking: number; description: string }>) {
  const byVersion = new Map<string, { released: string | null; entries: Array<{ category: string; is_breaking: number; description: string }> }>();
  for (const r of results) {
    let group = byVersion.get(r.version);
    if (!group) {
      group = { released: r.released, entries: [] };
      byVersion.set(r.version, group);
    }
    group.entries.push({ category: r.category, is_breaking: r.is_breaking, description: r.description });
  }
  return {
    total_entries: results.length,
    versions: Array.from(byVersion.entries()).map(([version, { released, entries }]) => ({
      version,
      released,
      entry_count: entries.length,
      breaking_count: entries.filter(e => e.is_breaking).length,
      entries,
    })),
  };
}

server.registerTool(
  "routeros_search_changelogs",
  {
    description: `Search MikroTik RouterOS changelogs — parsed per-entry with category and breaking-change flags.

Each entry is one *) or !) line from MikroTik's official changelogs, parsed into category + description.
Entries marked !) are breaking changes that may require config adjustments after upgrade.

**Upgrade-breakage workflow**: User says "X broke after upgrading from A to B":
1. Search changelogs with from_version=A, to_version=B, and the subsystem as query
2. Look for !) breaking changes that explain the behavior change
3. → routeros_get_page for the subsystem's documentation
4. → routeros_search_callouts for version-specific warnings
5. → routeros_command_version_check to see if commands were added/removed

Supports: FTS keyword search, version range filtering, category filtering, breaking-only mode.
Categories are subsystem names: bgp, bridge, dhcpv4-server, wifi, ipsec, console, container, etc.

Empty query with filters → browse mode (e.g., all breaking changes in 7.22).
Coverage depends on which versions were extracted — typically matches ros_versions table.`,
    inputSchema: {
      query: z
        .string()
        .optional()
        .default("")
        .describe("Search text (FTS). Omit for filter-only browse"),
      version: z
        .string()
        .optional()
        .describe("Exact version (e.g., '7.22'). Mutually exclusive with from/to"),
      from_version: z
        .string()
        .optional()
        .describe("Start of version range, EXCLUSIVE — returns changes AFTER this version (e.g., from_version='7.21.3' excludes 7.21.3 entries, includes 7.22+)"),
      to_version: z
        .string()
        .optional()
        .describe("End of version range, inclusive (e.g., '7.22.1')"),
      category: z
        .string()
        .optional()
        .describe("Filter by subsystem category (e.g., 'bgp', 'bridge', 'wifi')"),
      breaking_only: z
        .boolean()
        .optional()
        .describe("Only return !) breaking/important changes"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .default(50)
        .describe("Max results (default 50, max 500). Version-range queries often need higher limits."),
    },
  },
  async ({ query, version, from_version, to_version, category, breaking_only, limit }) => {
    const results = searchChangelogs(query || "", {
      version,
      fromVersion: from_version,
      toVersion: to_version,
      category,
      breakingOnly: breaking_only,
      limit,
    });

    if (results.length === 0) {
      const hints = [
        query ? "Try broader search terms or remove the query to browse by filters" : null,
        version ? `No changelog data for version ${version} — it may not have been extracted` : null,
        from_version || to_version ? "Try widening the version range" : null,
        category ? `Try without category filter, or check spelling (categories are lowercase: bgp, bridge, wifi, etc.)` : null,
        breaking_only ? "Try without breaking_only — the change may not be marked as breaking" : null,
        "Use routeros_search or routeros_search_callouts for documentation-based answers",
      ].filter(Boolean);
      return {
        content: [
          {
            type: "text",
            text: `No changelog entries matched${query ? `: "${query}"` : ""}${version ? ` (version: ${version})` : ""}${from_version || to_version ? ` (range: ${from_version || "?"} → ${to_version || "?"})` : ""}\n\nTry:\n${hints.map((h) => `- ${h}`).join("\n")}`,
          },
        ],
      };
    }
    // Group by version for compact output — avoids repeating version/released on every entry
    const grouped = groupChangelogsByVersion(results);
    return {
      content: [{ type: "text", text: JSON.stringify(grouped, null, 2) }],
    };
  },
);

// ---- routeros_command_version_check ----

server.registerTool(
  "routeros_command_version_check",
  {
    description: `Check which RouterOS versions include a specific command path.

Returns the list of versions where the command exists, plus first_seen/last_seen.
If the command exists in our earliest tracked version, a note warns that it likely
predates our data — check the documentation page for earlier version references.

Useful for answering "is /container supported in 7.12?" or "when was /ip/firewall/raw added?".

Command data covers versions 7.9–7.23beta2. No v6 data.
For versions below 7.9, no command tree data exists — the command may still exist there.
Cross-reference with routeros_get_page or routeros_search_callouts for version mentions
in documentation text. → routeros_search_changelogs to see what changed between versions.

Examples:
- command_path: "/container" → shows versions where container support exists
- command_path: "/ip/firewall/raw" → shows version range`,
    inputSchema: {
      command_path: z
        .string()
        .describe("RouterOS command path (e.g., '/container', '/ip/firewall/raw')"),
    },
  },
  async ({ command_path }) => {
    const result = checkCommandVersions(command_path);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ---- routeros_device_lookup ----

server.registerTool(
  "routeros_device_lookup",
  {
    description: `Look up MikroTik hardware specs, performance benchmarks, or search for devices matching criteria.

144 products from mikrotik.com (March 2026). Returns hardware specs, official test results,
block diagram URLs, and pricing.

**How it works:**
- If query matches a product name or code exactly → returns full specs + test results + block diagram
- Otherwise → FTS search + optional structured filters → returns matching devices (compact)
- Filters can be used alone (no query) to find devices by capability

**Test results** (from mikrotik.com per-product pages):
- Ethernet: bridging/routing throughput at 64/512/1518 byte packets (kpps + Mbps)
- IPSec: tunnel throughput with various AES/SHA configurations
- Key metric: "Routing 25 ip filter rules @ 512 byte" is a common routing performance gauge
- Devices with L3HW offload show additional hardware-accelerated routing rows
- Included automatically for exact/single-device lookups — no extra call needed

**Block diagram**: internal switch/CPU/PHY architecture diagram URL (PNG).
Shows bus topology and per-port bandwidth limits — useful for understanding SoC bottlenecks.

**License levels** determine feature availability:
- L3: CPE/home (no routing protocols, limited queues)
- L4: standard (OSPF, BGP, all firewall features)
- L5: ISP (unlimited tunnels, no peer limits)
- L6: controller (CAPsMAN unlimited, full cluster)

**Architecture** determines available packages and performance characteristics:
- ARM 64bit: modern high-end (CCR2xxx, CRS5xx, hAP ax², RB5009)
- ARM 32bit: mid-range (Audience, cAP ax, some switches)
- MMIPS: budget gigabit (hEX, hEX S)
- MIPSBE: legacy (older hAP, BaseBox, SXT)
- SMIPS: lowest-end (hAP lite)

Workflow — combine with other tools:
→ routeros_search: find documentation for features relevant to a device
→ routeros_command_tree: check commands available for a feature
→ routeros_current_versions: check latest firmware for the device

Data: 144 products, March 2026 snapshot. Not all MikroTik products ever made — only currently listed products.`,
    inputSchema: {
      query: z
        .string()
        .optional()
        .default("")
        .describe("Product name, code, or search terms (e.g., 'hAP ax³', 'CCR2216', 'ARM 64bit router')"),
      architecture: z
        .string()
        .optional()
        .describe("Filter: ARM 64bit, ARM 32bit, MIPSBE, MMIPS, or SMIPS"),
      min_ram_mb: z
        .number()
        .int()
        .optional()
        .describe("Filter: minimum RAM in megabytes (e.g., 256, 1024)"),
      license_level: z
        .number()
        .int()
        .optional()
        .describe("Filter: exact license level (3, 4, 5, or 6)"),
      min_storage_mb: z
        .number()
        .int()
        .optional()
        .describe("Filter: minimum storage in megabytes (e.g., 128). Devices with 16 MB storage can't fit extra packages"),
      has_poe: z
        .boolean()
        .optional()
        .describe("Filter: device has PoE in or PoE out"),
      has_wireless: z
        .boolean()
        .optional()
        .describe("Filter: device has wireless radios (2.4 GHz and/or 5 GHz)"),
      has_lte: z
        .boolean()
        .optional()
        .describe("Filter: device has LTE/cellular capability (SIM slot)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(10)
        .describe("Max results (default 10)"),
    },
  },
  async ({ query, architecture, min_ram_mb, min_storage_mb, license_level, has_poe, has_wireless, has_lte, limit }) => {
    const filters = {
      ...(architecture ? { architecture } : {}),
      ...(min_ram_mb ? { min_ram_mb } : {}),
      ...(min_storage_mb ? { min_storage_mb } : {}),
      ...(license_level ? { license_level } : {}),
      ...(has_poe ? { has_poe } : {}),
      ...(has_wireless ? { has_wireless } : {}),
      ...(has_lte ? { has_lte } : {}),
    };
    const result = searchDevices(query || "", filters, limit);

    if (result.results.length === 0) {
      const hints = [
        query ? "Try a shorter or different product name" : null,
        Object.keys(filters).length > 0 ? "Try removing some filters" : null,
        "Use routeros_search to find documentation pages about this topic",
      ].filter(Boolean);
      return {
        content: [
          {
            type: "text",
            text: `No devices matched${query ? `: "${query}"` : ""}${Object.keys(filters).length > 0 ? ` (with ${Object.keys(filters).length} filter${Object.keys(filters).length > 1 ? "s" : ""})` : ""}\n\nTry:\n${hints.map((h) => `- ${h}`).join("\n")}`,
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ---- routeros_current_versions ----

server.registerTool(
  "routeros_current_versions",
  {
    description: `Fetch current RouterOS version numbers from MikroTik's upgrade server.

Returns the latest version for each release channel: stable, long-term, testing, development.
Useful for determining if a user's version is current, outdated, or unpatched.

Key context for version reasoning:
- The long-term channel is the recommended minimum — MikroTik does not patch older branches
- Our documentation aligns with the long-term release at export time (~7.22)
- Our command tree data covers 7.9–7.23beta2
- If a user's version is older than the current long-term, recommend upgrading

Requires network access to upgrade.mikrotik.com.`,
    inputSchema: {},
  },
  async () => {
    const result = await fetchCurrentVersions();
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

return server;
} // end createServer

// ---- Start ----

if (useHttp) {
  const { existsSync } = await import("node:fs");
  const { WebStandardStreamableHTTPServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
  );
  const { isInitializeRequest } = await import(
    "@modelcontextprotocol/sdk/types.js"
  );

  const port = Number(getArg("--port") ?? process.env.PORT ?? 8080);
  const hostname = getArg("--host") ?? process.env.HOST ?? "localhost";
  const tlsCert = getArg("--tls-cert") ?? process.env.TLS_CERT_PATH;
  const tlsKey = getArg("--tls-key") ?? process.env.TLS_KEY_PATH;

  if ((tlsCert && !tlsKey) || (!tlsCert && tlsKey)) {
    process.stderr.write(
      "Error: TLS cert and key must both be provided (via flags or TLS_CERT_PATH/TLS_KEY_PATH)\n"
    );
    process.exit(1);
  }
  if (tlsCert && !existsSync(tlsCert)) {
    process.stderr.write(`Error: TLS certificate not found: ${tlsCert}\n`);
    process.exit(1);
  }
  if (tlsKey && !existsSync(tlsKey)) {
    process.stderr.write(`Error: TLS private key not found: ${tlsKey}\n`);
    process.exit(1);
  }

  const useTls = !!(tlsCert && tlsKey);
  const scheme = useTls ? "https" : "http";

  // Per-session transport routing (each MCP client session gets its own transport + server)
  const transports = new Map<string, InstanceType<typeof WebStandardStreamableHTTPServerTransport>>();

  const isLAN = hostname === "0.0.0.0" || hostname === "::";
  if (isLAN) {
    process.stderr.write(
      "Warning: Binding to all interfaces — the MCP server will be accessible from the network.\n"
    );
    if (!useTls) {
      process.stderr.write(
        "  Consider using --tls-cert/--tls-key or a reverse proxy for production use.\n"
      );
    }
  }

  /** JSON-RPC error response helper */
  function jsonRpcError(status: number, code: number, message: string): Response {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
      { status, headers: { "Content-Type": "application/json" } },
    );
  }

  Bun.serve({
    port,
    hostname,
    ...(useTls && tlsCert && tlsKey
      ? { tls: { cert: Bun.file(tlsCert), key: Bun.file(tlsKey) } }
      : {}),
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname !== "/mcp") {
        return new Response("Not Found", { status: 404 });
      }

      // DNS rebinding protection: reject browser-origin requests
      const origin = req.headers.get("origin");
      if (origin) {
        try {
          const originHost = new URL(origin).host;
          const serverHost = `${isLAN ? "localhost" : hostname}:${port}`;
          if (originHost !== serverHost && originHost !== `localhost:${port}` && originHost !== `127.0.0.1:${port}`) {
            return new Response("Forbidden: Origin not allowed", { status: 403 });
          }
        } catch {
          return new Response("Forbidden: Invalid Origin", { status: 403 });
        }
      }

      const sessionId = req.headers.get("mcp-session-id");

      // Route to existing session
      if (sessionId) {
        const transport = transports.get(sessionId);
        if (transport) {
          return transport.handleRequest(req);
        }
        return jsonRpcError(404, -32001, "Session not found");
      }

      // No session ID — only POST with initialize creates a new session
      if (req.method === "POST") {
        let body: unknown;
        try {
          body = await req.json();
        } catch {
          return jsonRpcError(400, -32700, "Parse error: Invalid JSON");
        }

        const isInit = Array.isArray(body)
          ? body.some((msg: unknown) => isInitializeRequest(msg))
          : isInitializeRequest(body);

        if (isInit) {
          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (sid: string) => {
              transports.set(sid, transport);
            },
          });
          transport.onclose = () => {
            const sid = transport.sessionId;
            if (sid) transports.delete(sid);
          };

          const mcpServer = createServer();
          await mcpServer.connect(transport);
          return transport.handleRequest(req, { parsedBody: body });
        }
      }

      return jsonRpcError(400, -32000, "Bad Request: No valid session ID provided");
    },
  });

  const displayHost = isLAN ? "localhost" : hostname;
  process.stderr.write(`rosetta ${RESOLVED_VERSION} — Streamable HTTP\n`);
  process.stderr.write(`  ${scheme}://${displayHost}:${port}/mcp\n`);
} else {
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

})();
