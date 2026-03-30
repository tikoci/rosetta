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
 *   (default)          Start MCP server (stdio transport)
 *
 * Environment variables:
 *   DB_PATH — absolute path to ros-help.db (default: next to binary or project root)
 */

declare const VERSION: string;
declare const IS_COMPILED: boolean;

// ── CLI dispatch (before MCP server init) ──

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  const ver = typeof VERSION !== "undefined" ? VERSION : "dev";
  console.log(`rosetta ${ver}`);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  const ver = typeof VERSION !== "undefined" ? VERSION : "dev";
  console.log(`rosetta ${ver} — MCP server for RouterOS documentation`);
  console.log();
  console.log("Usage:");
  console.log("  rosetta              Start MCP server (stdio transport)");
  console.log("  rosetta --setup      Download database + print MCP client config");
  console.log("  rosetta --setup --force  Re-download database");
  console.log("  rosetta --version    Print version");
  console.log("  rosetta --help       Print this help");
  console.log();
  console.log("Environment:");
  console.log("  DB_PATH  Absolute path to ros-help.db (optional)");
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

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = await import("zod/v3");

// Dynamic imports — db.ts eagerly opens the DB file on import,
// so we must import after the --setup guard to avoid creating
// an empty ros-help.db on fresh installs.
//
// Check if DB has data BEFORE importing db.ts. If empty/missing,
// auto-download so db.ts opens the real database.
const _baseDir =
  typeof IS_COMPILED !== "undefined" && IS_COMPILED
    ? (await import("node:path")).dirname(process.execPath)
    : (await import("node:path")).resolve(import.meta.dirname, "..");
const _dbPath =
  process.env.DB_PATH?.trim() || (await import("node:path")).join(_baseDir, "ros-help.db");

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

const server = new McpServer({
  name: "rosetta",
  version: typeof VERSION !== "undefined" ? VERSION : "0.2.0",
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

**Large page handling:** Always set max_length (e.g., 30000) on the first call.
Some pages are 100K+ chars. When max_length is set and the page exceeds it,
pages with sections return a **table of contents** instead of truncated text.
The TOC lists each section's heading, hierarchy level, character count, and
deep-link URL. Re-call with the section parameter to retrieve specific sections.

**Section parameter:** Pass a section heading or anchor_id (from the TOC)
to get that section's content. Parent sections automatically include all
sub-section content, so requesting a top-level heading gives you everything
under it.

Recommended workflow for large pages:
1. Call with max_length=30000 → get TOC if page is large
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
        .optional()
        .describe("Recommended: set to 30000. Max combined text+code length. If exceeded and page has sections, returns a TOC instead of truncated text. Omit only if you need the entire page."),
      section: z
        .string()
        .optional()
        .describe("Section heading or anchor_id from TOC. Returns only that section's content."),
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
    description: `Look up MikroTik hardware specs or search for devices matching criteria.

144 products from mikrotik.com/products/matrix (March 2026). Returns hardware specs
including CPU, RAM, storage, ports, PoE, wireless, license level, and price.

**How it works:**
- If query matches a product name or code exactly → returns full specs for that device
- Otherwise → FTS search + optional structured filters → returns matching devices
- Filters can be used alone (no query) to find devices by capability

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

// ---- Start ----

const transport = new StdioServerTransport();
await server.connect(transport);

})();
