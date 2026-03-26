/**
 * mcp.ts — MCP server for RouterOS documentation retrieval.
 *
 * Exposes a local SQLite+FTS5 index of RouterOS docs as MCP tools,
 * enabling LLM agents to search documentation, look up properties,
 * and browse the command tree.
 *
 * Environment variables:
 *   DB_PATH — absolute path to ros-help.db (default: <workspace>/ros-help.db)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v3";
import { getDbStats, initDb } from "./db.ts";
import {
  browseCommands,
  browseCommandsAtVersion,
  checkCommandVersions,
  fetchCurrentVersions,
  getPage,
  lookupProperty,
  searchCallouts,
  searchPages,
  searchProperties,
} from "./query.ts";

initDb();

const server = new McpServer({
  name: "mikrotik-docs",
  version: "0.1.0",
});

// ---- routeros_search ----

server.registerTool(
  "routeros_search",
  {
    description: `Search RouterOS documentation using natural language.

This is the primary discovery tool. Start here to find relevant documentation pages,
then use routeros_get_page to retrieve full content.

Capabilities:
- Full-text search with BM25 ranking and Porter stemming
  ("configuring" matches "configuration", "configured", etc.)
- Proximity matching for compound terms ("firewall filter", "bridge vlan")
- Results include page title, breadcrumb path, help.mikrotik.com URL, and excerpt
- If AND returns nothing, the engine automatically retries with OR

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
    description: `Get the full text of a RouterOS documentation page.

Use this after routeros_search identifies a relevant page. Pass either:
- The numeric Confluence page ID (from search results)
- The exact page title (case-insensitive)

Returns the complete plain text, code blocks, and any callout blocks
(notes, warnings, info) for the page. Callouts contain important caveats
and edge-case details.`,
    inputSchema: {
      page: z
        .string()
        .describe("Page ID (numeric) or exact page title"),
    },
  },
  async ({ page }) => {
    const result = getPage(page);
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
    description: `Look up a specific RouterOS configuration property by name.

Returns the property's type, default value, description, and which documentation
page it appears on. Useful for understanding what a specific setting does.

Optionally filter by command path to disambiguate properties that appear in
multiple contexts (e.g., "disabled" appears in many command menus).

Examples:
- name: "add-default-route" → DHCP client property
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
            text: `No property found: "${name}"${command_path ? ` under ${command_path}` : ""}`,
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
    description: `Search RouterOS properties by description text.

Unlike routeros_lookup_property (which matches by exact name), this does
full-text search across property names and descriptions. Use when you don't
know the exact property name but know what it does.

Example: "gateway reachability check" finds check-gateway properties.`,
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

Optionally filter by RouterOS version to check what exists in a specific release.
Command data covers versions 7.9–7.23beta2. No v6 data.
For versions below 7.9, no command tree data exists.
For versions older than the current long-term, recommend upgrading (MikroTik does not
patch older branches).

Examples:
- path: "/ip" → shows address, arp, dhcp-client, dhcp-server, firewall, route, etc.
- path: "/ip/firewall" → shows filter, nat, mangle, raw, address-list, etc.
- path: "", version: "7.15" → shows top-level menus as of RouterOS 7.15`,
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

Returns page count, property count, callout count, command count, link coverage,
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
    description: `Search note, warning, and info callout blocks across all RouterOS documentation.

Callouts contain important caveats, edge cases, and non-obvious behavior.
Useful for finding warnings about hardware offloading, compatibility notes,
or unexpected feature interactions.

Optionally filter by callout type: "note", "warning", or "info".

Examples:
- query: "hardware offload" → warnings about bridge HW offloading limitations
- query: "VLAN", type: "warning" → only VLAN-related warnings`,
    inputSchema: {
      query: z.string().describe("Search query for callout content"),
      type: z
        .enum(["note", "warning", "info"])
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

// ---- routeros_command_version_check ----

server.registerTool(
  "routeros_command_version_check",
  {
    description: `Check which RouterOS versions include a specific command path.

Returns the list of versions where the command exists, plus first_seen/last_seen.
Useful for answering "is /container supported in 7.12?" or "when was /ip/firewall/raw added?".

Command data covers versions 7.9–7.23beta2. No v6 data.
For versions below 7.9, no command tree data exists.

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
