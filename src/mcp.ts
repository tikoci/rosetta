/**
 * mcp.ts — MCP server for RouterOS documentation retrieval.
 *
 * Exposes a local SQLite+FTS5 index of RouterOS docs as MCP tools,
 * enabling LLM agents to search documentation, look up properties,
 * and browse the command tree.
 *
 * CLI flags (for compiled binary or `bun run src/mcp.ts`):
 *   browse             Interactive terminal browser (REPL)
 *   --setup [--force]  Download database + print MCP client config
 *   --refresh          Shortcut for --setup --force (refresh DB)
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

/** Format a clickable terminal hyperlink using OSC 8 escape sequences.
 *  Falls back to plain URL in terminals that don't support OSC 8. */
function link(url: string, display?: string): string {
  return `\x1b]8;;${url}\x07${display ?? url}\x1b]8;;\x07`;
}

/**
 * Ensure the DB exists, has page data, and matches the current schema version.
 * This must run before importing db.ts/query.ts to avoid creating an empty DB file
 * on fresh installs.
 */
async function ensureDbReady(log: (msg: string) => void): Promise<void> {
  const { resolveDbPath, SCHEMA_VERSION } = await import("./paths.ts");
  const { downloadDb } = await import("./setup.ts");

  const dbPath = resolveDbPath(import.meta.dirname);

  const pageCount = (() => {
    try {
      const check = new (require("bun:sqlite").default)(dbPath, { readonly: true });
      const row = check.prepare("SELECT COUNT(*) AS c FROM pages").get() as { c: number };
      check.close();
      return row.c;
    } catch {
      return 0;
    }
  })();

  if (pageCount === 0) {
    try {
      await downloadDb(dbPath, log);
      log("Database downloaded successfully.");
    } catch (e) {
      log(`Auto-download failed: ${e}`);
      log(`Run: ${process.argv[0]} --setup`);
      return;
    }
  }

  const dbSchemaVersion = (() => {
    try {
      const check = new (require("bun:sqlite").default)(dbPath, { readonly: true });
      const row = check.prepare("PRAGMA user_version").get() as { user_version: number };
      check.close();
      return row.user_version;
    } catch {
      return SCHEMA_VERSION;
    }
  })();

  if (dbSchemaVersion !== SCHEMA_VERSION) {
    log(`DB schema version mismatch (DB=${dbSchemaVersion}, expected=${SCHEMA_VERSION}) - re-downloading updated database...`);
    try {
      await downloadDb(dbPath, log);
      log("Database updated successfully.");
    } catch (e) {
      log(`Auto-download failed: ${e}`);
      log(`Run: ${process.argv[0]} --refresh`);
    }
  }
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
  console.log("  rosetta browse       Interactive terminal browser");
  console.log("  rosetta --setup      Download database + print MCP client config");
  console.log("  rosetta --setup --force  Re-download database");
  console.log("  rosetta --refresh    Shortcut for --setup --force");
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
  console.log();
  console.log(`Quick start:  bunx @tikoci/rosetta --setup`);
  console.log(`Project:      ${link("https://github.com/tikoci/rosetta")}`);
  console.log(`Docs:         ${link("https://help.mikrotik.com/docs/spaces/ROS/overview", "help.mikrotik.com")}`);
  process.exit(0);
}

// Wrap in async IIFE — bun build --compile does not support top-level await
(async () => {

if (args[0] === "browse") {
  await ensureDbReady((msg) => process.stderr.write(`${msg}\n`));
  // Strip "browse" from argv so browse.ts only sees flags/queries
  process.argv.splice(2, 1);
  await import("./browse.ts");
  return;
}

if (args.includes("--setup")) {
  const { runSetup } = await import("./setup.ts");
  await runSetup(args.includes("--force"));
  process.exit(0);
}

if (args.includes("--refresh")) {
  const { runSetup } = await import("./setup.ts");
  await runSetup(true);
  process.exit(0);
}

// ── MCP Server ──

const useHttp = args.includes("--http");

const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { z } = await import("zod/v3");

// Dynamic imports — db.ts eagerly opens the DB file on import,
// so we must import after the --setup guard to avoid creating
// an empty ros-help.db on fresh installs.
await ensureDbReady((msg) => process.stderr.write(`${msg}\n`));

// Now import db.ts (opens the DB) and query.ts
const { db, getDbStats, initDb } = await import("./db.ts");
const {
  browseCommands,
  browseCommandsAtVersion,
  checkCommandVersions,
  diffCommandVersions,
  exportDevicesCsv,
  exportDeviceTestsCsv,
  fetchCurrentVersions,
  getPage,
  getSkill,
  listSkills,
  lookupProperty,
  searchChangelogs,
  searchDevices,
  searchDeviceTests,
  getTestResultMeta,
  searchAll,
  searchDude,
  getDudePage,
} = await import("./query.ts");

initDb();

/** Factory: create a new McpServer with all tools registered.
 *  Called once for stdio, or per-session for HTTP transport. */
function createServer() {

const server = new McpServer({
  name: "rosetta",
  version: RESOLVED_VERSION,
}, {
  instructions: "RouterOS documentation search. Start with routeros_search for any RouterOS question — it runs a classifier (detects command paths, versions, devices, topics) + BM25 FTS, and returns pages plus a `related` block (command_node, properties, devices, callouts, videos, changelogs, skills) + next-step hints. One call usually answers the question. Drill into specific pages with routeros_get_page; for hardware specs use routeros_device_lookup; for version-specific command changes use routeros_command_diff. Only v7 data exists (7.9+) — v6 is out of scope.",
});

server.registerResource(
  "device-test-results-csv",
  "rosetta://datasets/device-test-results.csv",
  {
    title: "Device Test Results CSV",
    description: "Full joined benchmark dataset as CSV for reporting and bulk export. Attach explicitly in clients that support MCP resources.",
    mimeType: "text/csv",
  },
  async () => ({
    contents: [{
      uri: "rosetta://datasets/device-test-results.csv",
      mimeType: "text/csv",
      text: exportDeviceTestsCsv(),
    }],
  }),
);

server.registerResource(
  "devices-csv",
  "rosetta://datasets/devices.csv",
  {
    title: "Devices CSV",
    description: "Full device catalog as CSV, including normalized RAM and storage fields plus product and block diagram URLs.",
    mimeType: "text/csv",
  },
  async () => ({
    contents: [{
      uri: "rosetta://datasets/devices.csv",
      mimeType: "text/csv",
      text: exportDevicesCsv(),
    }],
  }),
);

server.registerResource(
  "schema-sql",
  "rosetta://schema.sql",
  {
    title: "Database Schema DDL",
    description: "Full SQLite DDL (CREATE TABLE/VIRTUAL TABLE/TRIGGER/INDEX statements) for ros-help.db. Read this before constructing raw SQL queries.",
    mimeType: "application/sql",
  },
  async () => {
    const rows = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type DESC, name ASC",
      )
      .all() as Array<{ sql: string }>;
    const ddl = rows.map((r) => `${r.sql};`).join("\n\n");
    return {
      contents: [{
        uri: "rosetta://schema.sql",
        mimeType: "application/sql",
        text: ddl,
      }],
    };
  },
);

server.registerResource(
  "schema-guide",
  "rosetta://schema-guide.md",
  {
    title: "Schema Guide",
    description: "How to query ros-help.db: table relationships, FTS5 tokenizer differences, BM25 weights, and example query patterns.",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [{
      uri: "rosetta://schema-guide.md",
      mimeType: "text/markdown",
      text: `# ros-help.db Schema Guide

Read \`rosetta://schema.sql\` for full DDL. This guide explains relationships, FTS5 quirks, and good query patterns.

## Table Map

| Table | Rows (approx) | Description |
|-------|-------------|-------------|
| \`pages\` | 317 | One row per Confluence HTML page. Primary content store. |
| \`sections\` | 2,984 | h1–h3 chunks of pages with anchor IDs for deep-linking. |
| \`properties\` | 4,860 | CLI property rows extracted from confluenceTable elements. |
| \`callouts\` | 1,034 | Note/Warning/Info/Tip blocks from Confluence callout macros. |
| \`commands\` | ~40K | RouterOS command tree entries (dir/cmd/arg) from inspect.json. |
| \`command_versions\` | 1.67M | Junction: which command paths exist in which RouterOS versions. |
| \`ros_versions\` | 46 | Metadata per extracted RouterOS version (7.9–7.23beta2). |
| \`devices\` | 144 | MikroTik hardware specs from product matrix CSV. |
| \`device_test_results\` | 2,874 | Ethernet/IPSec benchmark rows from mikrotik.com product pages. |
| \`changelogs\` | varies | Parsed per-entry changelog lines from MikroTik download server. |
| \`videos\` | 518 | MikroTik YouTube video metadata. |
| \`video_segments\` | ~1,890 | Chapter-level transcript segments (one per chapter or one per video). |

## Foreign Keys

\`\`\`
pages ←── sections.page_id
pages ←── properties.page_id
pages ←── callouts.page_id
pages ←── commands.page_id          (nullable — not all commands link to a page)
devices ←── device_test_results.device_id
ros_versions ←── command_versions.ros_version
videos ←── video_segments.video_id  (INTEGER FK to videos.id, NOT videos.video_id TEXT)
\`\`\`

## FTS5 Virtual Tables

Each table has a companion \`*_fts\` virtual table kept in sync via INSERT/UPDATE/DELETE triggers.

| FTS table | Source | Tokenizer | Indexed columns |
|-----------|--------|-----------|----------------|
| \`pages_fts\` | \`pages\` | \`porter unicode61\` | title (3×), path (2×), text (1×), code (0.5×) |
| \`properties_fts\` | \`properties\` | \`porter unicode61\` | name, description |
| \`callouts_fts\` | \`callouts\` | \`porter unicode61\` | content |
| \`changelogs_fts\` | \`changelogs\` | \`porter unicode61\` | category, description |
| \`videos_fts\` | \`videos\` | \`porter unicode61\` | title, description |
| \`video_segments_fts\` | \`video_segments\` | \`porter unicode61\` | chapter_title, transcript |
| \`devices_fts\` | \`devices\` | **\`unicode61\` only** | product_name, product_code, architecture, cpu |

**Why devices use \`unicode61\` without porter:** Model numbers like "RB5009" and "hAP ax3" must not be stemmed. Porter would corrupt them.

## BM25 Column Weights (pages_fts)

The MCP tools use \`bm25(pages_fts, 3.0, 2.0, 1.0, 0.5)\` — title gets 3× weight, path 2×, body text 1×, code blocks 0.5×. In SQLite FTS5 BM25, **lower (more negative) scores rank better**.

\`\`\`sql
SELECT p.id, p.title, p.url,
       bm25(pages_fts, 3.0, 2.0, 1.0, 0.5) AS rank
FROM pages_fts
JOIN pages p ON p.id = pages_fts.rowid
WHERE pages_fts MATCH 'firewall filter'
ORDER BY rank          -- ascending = best match first
LIMIT 10;
\`\`\`

## FTS5 Query Syntax

\`\`\`sql
-- Phrase search (exact sequence)
WHERE pages_fts MATCH '"firewall filter"'

-- AND (default — all terms must appear)
WHERE pages_fts MATCH 'dhcp relay'

-- OR
WHERE pages_fts MATCH 'dhcp OR relay'

-- Column-scoped search
WHERE pages_fts MATCH 'title:firewall'

-- NEAR (terms within N tokens of each other)
WHERE pages_fts MATCH 'NEAR(firewall filter, 5)'

-- Prefix match
WHERE pages_fts MATCH 'route*'
\`\`\`

Porter stemming is automatic — "configuring" matches "configuration", "configured", "configure".

## Common Join Patterns

### Page + its properties
\`\`\`sql
SELECT p.title, pr.name, pr.type, pr.default_val, pr.description
FROM pages p
JOIN properties pr ON pr.page_id = p.id
WHERE p.id = 328220;
\`\`\`

### FTS search → full section content
\`\`\`sql
SELECT p.title, s.heading, s.text, s.anchor_id
FROM pages_fts
JOIN pages p ON p.id = pages_fts.rowid
JOIN sections s ON s.page_id = p.id
WHERE pages_fts MATCH 'mangle routing mark'
ORDER BY bm25(pages_fts, 3.0, 2.0, 1.0, 0.5)
LIMIT 5;
\`\`\`

### Command path → linked documentation page
\`\`\`sql
SELECT c.path, c.type, p.title, p.url
FROM commands c
LEFT JOIN pages p ON p.id = c.page_id
WHERE c.path = '/ip/firewall/filter';
\`\`\`

### Commands available in a specific RouterOS version
\`\`\`sql
SELECT c.path, c.type
FROM commands c
JOIN command_versions cv ON cv.command_path = c.path
WHERE cv.ros_version = '7.22'
  AND c.path LIKE '/ip/firewall/%'
ORDER BY c.path;
\`\`\`

### Device hardware lookup + benchmarks
\`\`\`sql
SELECT d.product_name, d.ram_mb, d.cpu,
       t.test_type, t.mode, t.packet_size, t.throughput_mbps
FROM devices d
JOIN device_test_results t ON t.device_id = d.id
WHERE d.product_name LIKE '%RB5009%'
ORDER BY t.test_type, t.packet_size;
\`\`\`

### Changelog entries for a version range, breaking changes only
\`\`\`sql
SELECT version, released, category, description
FROM changelogs
WHERE is_breaking = 1
  AND version >= '7.20' AND version <= '7.22'
ORDER BY version, sort_order;
\`\`\`

## Gotchas

- **Version sorting:** \`ORDER BY version\` is lexicographic, not numeric. '7.9' > '7.10' lexicographically. Use the \`compareVersions()\` helper in query.ts or fetch all and sort in application code.
- **content= FTS tables:** Do not SELECT directly from \`*_fts\` tables — they are content tables and must be JOINed via rowid to the source table to get non-indexed columns.
- **video_segments.video_id** is an INTEGER FK to \`videos.id\`, not the TEXT \`videos.video_id\` (YouTube ID). Join on \`video_segments.video_id = videos.id\`.
- **NULL page_id in commands:** ~8% of command dirs have no linked page (\`page_id IS NULL\`). Use LEFT JOIN when joining commands to pages.
- **devices_fts LIKE fallback:** For model numbers ending in ™/® or containing superscripts, FTS may miss them. Use \`LIKE '%RB5009%'\` as a fallback on \`devices.product_name\`.
`,
    }],
  }),
);

// ── Skills resources (community-created agent guides from tikoci/routeros-skills) ──

server.registerResource(
  "skills-list",
  "rosetta://skills",
  {
    title: "RouterOS Agent Skills",
    description: "List of available RouterOS agent skill guides — community-created, AI-generated/human-reviewed supplemental content from tikoci/routeros-skills. NOT official MikroTik documentation.",
    mimeType: "text/markdown",
  },
  async () => {
    const skills = listSkills();
    const lines = [
      "# RouterOS Agent Skills",
      "",
      "⚠️ Community-created content from tikoci/routeros-skills — NOT official MikroTik documentation.",
      "AI-generated, human-reviewed. May contain errors. Verify with routeros_search/routeros_get_page.",
      "",
      `${skills.length} skills available:`,
      "",
      ...skills.map(s => `- **${s.name}** — ${s.description} (${s.word_count} words, ${s.ref_count} refs) → \`rosetta://skills/${s.name}\``),
    ];
    return {
      contents: [{
        uri: "rosetta://skills",
        mimeType: "text/markdown",
        text: lines.join("\n"),
      }],
    };
  },
);

// Register individual skill resources using resource templates
// MCP resource templates allow `rosetta://skills/{name}` pattern matching
{
  const skills = listSkills();
  for (const skill of skills) {
    server.registerResource(
      `skill-${skill.name}`,
      `rosetta://skills/${skill.name}`,
      {
        title: `Skill: ${skill.name}`,
        description: skill.description,
        mimeType: "text/markdown",
      },
      async () => {
        const detail = getSkill(skill.name);
        if (!detail) {
          return { contents: [{ uri: `rosetta://skills/${skill.name}`, mimeType: "text/plain", text: `Skill '${skill.name}' not found.` }] };
        }
        const lines = [
          detail.provenance,
          "",
          `# ${detail.name}`,
          "",
          detail.content,
        ];
        if (detail.references.length > 0) {
          lines.push("", "---", "", "## Reference Files", "");
          for (const ref of detail.references) {
            lines.push(`### ${ref.filename}`, "", ref.content, "");
          }
        }
        return {
          contents: [{
            uri: `rosetta://skills/${detail.name}`,
            mimeType: "text/markdown",
            text: lines.join("\n"),
          }],
        };
      },
    );
  }
}

// ---- routeros_search ----

server.registerTool(
  "routeros_search",
  {
    description: `Unified RouterOS search — start here for any question.

One call runs an input classifier (command-path, version, device, topic, property)
and FTS in parallel, returning pages plus classifier-informed side queries in a
single response. Consolidates what used to require 3–5 separate tool calls.

Response shape:
- classified: { version, topics, command_path, device, property } — what the
  classifier detected from your input
- pages: top FTS matches (title, path, URL, excerpt, best_section)
- related: callouts, properties, changelogs, videos, commands, devices, skills —
  each capped at 2–3 entries, empty sections omitted
- next_steps: concrete follow-up tool calls informed by the classification

Capabilities:
- BM25 ranking with Porter stemming ("configuring" matches "configuration")
- Proximity matching for compound terms ("firewall filter", "bridge vlan")
- Automatic AND → OR fallback on empty page results
- Version/device/topic detection steers related lookups

Drill-down tools (still standalone for specific needs):
→ routeros_get_page: full page content (or section) for any result
→ routeros_lookup_property: exact property lookup, optionally filtered by command path
→ routeros_command_tree: browse command hierarchy
→ routeros_search_changelogs: version range + category + breaking-only filters
→ routeros_device_lookup: detailed device specs and test results
→ routeros_command_diff / routeros_command_version_check: version-specific command tracking

Tips:
- Use specific technical terms: "DHCP relay agent" not "how to set up DHCP"
- Pass a command path directly ("/ip/firewall/filter") and related.commands +
  related.command_node surface children and linked docs without a second call
- For retired Dude GUI topics, use routeros_dude_search instead
- Documentation: 317 pages from March 2026 Confluence export, ~7.22 long-term
- Command data: RouterOS 7.9–7.23beta2. No v6 data.`,
    inputSchema: {
      query: z.string().describe("Natural language search query, command path, or identifier"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(8)
        .describe("Max page results (default 8). Related sections are always capped at 2–3."),
    },
  },
  async ({ query, limit }) => {
    const result = searchAll(query, limit);
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
The TOC response surfaces high-signal content up front so you rarely need a
second call: top **properties** (name + type + description), **related_videos**
(FTS match on page title), callout_summary (count by type), and the section list
(heading, level, char_count, deep-link URL). Re-call with the section parameter
for full section text.

**Section parameter:** Pass a section heading or anchor_id (from the TOC)
to get that section's content. If a section is still too large, its sub-section
TOC is returned instead — request a more specific sub-section.

Recommended workflow for large pages:
1. First call → get TOC (+ properties, related_videos, callout_summary)
2. Answer directly if the surfaced signal is enough
3. Otherwise call again with section="Section Name" for specific content

Workflow — what to do with this content:
→ routeros_lookup_property: get exact details for a named property
→ routeros_command_tree: browse the command path for features on this page
→ routeros_search: related warnings, video segments, and device specs now surface via search's related block`,
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
→ routeros_search: find the documentation page, then routeros_get_page to read properties in context
→ routeros_command_tree: browse args at the command path to discover property names

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
            text: `No property found: "${name}"${command_path ? ` under ${command_path}` : ""}\n\nTry instead:\n- routeros_search to find the documentation page, then routeros_get_page to read properties in context\n- routeros_command_tree at the command path to see available args`,
          },
        ],
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
Optionally filter by CPU architecture (x86/arm64) to see platform-specific commands.
Command data covers versions 7.9–7.23beta2. No v6 data.

Workflow — combine with other tools:
→ routeros_get_page: read the linked documentation page for a command
→ routeros_lookup_property: look up arg names as properties for details
→ routeros_command_version_check: check when a command was added

Examples:
- path: "/ip" → address, arp, dhcp-client, dhcp-server, firewall, route, etc.
- path: "/ip/firewall" → filter, nat, mangle, raw, address-list, etc.
- path: "", version: "7.15" → top-level menus as of RouterOS 7.15
- path: "/interface", arch: "arm64" → shows arm64-specific interfaces (wifi-qcom, ethernet/switch)`,
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
      arch: z
        .string()
        .optional()
        .describe("Filter by CPU architecture: 'x86' or 'arm64'. Omit to show all (including arch-specific nodes)."),
    },
  },
  async ({ path, version, arch }) => {
    const cmdPath = path?.trim() || "";
    const results = version
      ? browseCommandsAtVersion(cmdPath, version, arch)
      : browseCommands(cmdPath, arch);

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
version range, documentation export date, and available agent skills.

Skills: Community-created agent guides from tikoci/routeros-skills are available as MCP resources
at rosetta://skills/{name}. Use the resource listing to browse available skills.

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
    const skills = listSkills();
    const statsWithSkills = {
      ...stats,
      skills: {
        count: skills.length,
        available: skills.map(s => s.name),
        note: "Community-created agent guides from tikoci/routeros-skills. Access via rosetta://skills/{name} resources.",
      },
    };
    return {
      content: [{ type: "text", text: JSON.stringify(statsWithSkills, null, 2) }],
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
4. → routeros_command_version_check to see if commands were added/removed

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
        "Use routeros_search for documentation-based answers — callouts and videos surface in its related block",
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

// ---- routeros_dude_search ----

server.registerTool(
  "routeros_dude_search",
  {
    description: `Search archived "The Dude" network monitor documentation (from wiki.mikrotik.com via Wayback Machine).

The Dude GUI client is retired, but the Dude server/database remains in RouterOS under /dude.
These are archived wiki pages covering the Dude v6 GUI (primary) and legacy v3/v4 (reference).
Many pages include GUI screenshots — use routeros_dude_get_page to see image references.

Separate from routeros_search (which covers current RouterOS v7 docs only).
For current RouterOS /dude command-line interface, use routeros_command_tree with path "/dude".

→ routeros_dude_get_page: read full page text + screenshot list
→ routeros_command_tree: browse /dude commands in current RouterOS
→ routeros_search: search current RouterOS v7 documentation`,
    inputSchema: {
      query: z.string().describe("Search terms (e.g., 'probes SNMP', 'device discovery', 'notifications')"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(8)
        .optional()
        .describe("Max results (1–20, default 8)"),
    },
  },
  async ({ query, limit }) => {
    const results = searchDude(query, limit ?? 8);
    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No Dude wiki results for: "${query}"\n\nTry:\n- Broader search terms (e.g., 'monitor' instead of 'monitoring')\n- routeros_search for current RouterOS documentation\n- routeros_command_tree with path "/dude" for current /dude commands`,
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
    };
  },
);

// ---- routeros_dude_get_page ----

server.registerTool(
  "routeros_dude_get_page",
  {
    description: `Get full content of an archived Dude wiki page by ID or title.

Returns the complete page text, code blocks, and a list of GUI screenshots with local file paths.
Screenshots are downloaded images from the archived wiki — use a file viewer for multimodal analysis.

max_length defaults to 16000. If the page text+code exceeds it, content is truncated and a
truncated field shows the original lengths. Dude pages are generally small (< 12K chars)
so truncation is uncommon.

→ routeros_dude_search: find pages by topic
→ routeros_command_tree: browse /dude commands in current RouterOS`,
    inputSchema: {
      id: z.union([z.number().int(), z.string()]).describe("Page ID (number) or title/slug (string)"),
      max_length: z
        .number()
        .int()
        .min(1000)
        .max(200000)
        .optional()
        .default(16000)
        .describe("Max combined text+code characters to return (default: 16000)."),
    },
  },
  async ({ id, max_length }) => {
    const page = getDudePage(typeof id === "string" && /^\d+$/.test(id) ? Number.parseInt(id, 10) : id, max_length);
    if (!page) {
      return {
        content: [
          {
            type: "text",
            text: `No Dude page found for: "${id}"\n\nTry routeros_dude_search to find available pages.`,
          },
        ],
      };
    }
    return {
      content: [{ type: "text", text: JSON.stringify(page, null, 2) }],
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
Cross-reference with routeros_get_page for version mentions in documentation text (callouts
surface in routeros_search's related block). → routeros_search_changelogs to see what changed between versions.

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

// ---- routeros_command_diff ----

server.registerTool(
  "routeros_command_diff",
  {
    description: `Diff two RouterOS versions — which command paths were added or removed between them.

The most common RouterOS support query is "something broke after I upgraded." This tool
directly answers it by comparing the command tree between any two tracked versions.

Returns added[] (new in to_version) and removed[] (gone from to_version) with counts.
Use path_prefix to scope the diff to a subsystem (e.g., '/ip/firewall' or '/routing/bgp').

Command data covers 7.9–7.23beta2. Both versions must be in this range for complete results;
if a version is outside the range, a note warns that results may be incomplete.

**Typical workflow for upgrade breakage:**
1. routeros_command_diff from_version="7.15" to_version="7.22" path_prefix="/ip/firewall"
   → see which filter/mangle/nat commands changed
2. routeros_search_changelogs from_version="7.15" to_version="7.22" category="firewall"
   → read human-readable changelog entries for that subsystem
3. routeros_command_version_check for a specific path that looks suspicious
   → confirm exact version range for that command

**path_prefix tip:** Start broad (e.g., '/routing/bgp'), then narrow if the diff is large.
Without a prefix, a major-version diff can list hundreds of added paths.

→ routeros_search_changelogs: read what changed (descriptions, breaking flags)
→ routeros_command_version_check: check a specific command's full version history
→ routeros_command_tree: browse the current command hierarchy at a path`,
    inputSchema: {
      from_version: z
        .string()
        .describe("The older RouterOS version to diff from (e.g., '7.15', '7.9')"),
      to_version: z
        .string()
        .describe("The newer RouterOS version to diff to (e.g., '7.22', '7.23beta2')"),
      path_prefix: z
        .string()
        .optional()
        .describe("Optional: scope the diff to a command subtree (e.g., '/ip/firewall', '/routing/bgp', '/interface/bridge')"),
      arch: z
        .string()
        .optional()
        .describe("Filter by CPU architecture: 'x86' or 'arm64'. Omit to diff all commands regardless of architecture."),
    },
  },
  async ({ from_version, to_version, path_prefix, arch }) => {
    const result = diffCommandVersions(from_version, to_version, path_prefix, arch);
    if (result.added_count === 0 && result.removed_count === 0) {
      const hint = [
        result.note ?? null,
        "No differences found. Possible reasons:",
        "- Both versions have identical command trees for this path",
        "- One or both versions may not be in our tracked range (7.9–7.23beta2)",
        "Use routeros_stats to see available version range, or try a different path_prefix.",
      ].filter(Boolean).join("\n");
      return { content: [{ type: "text", text: hint }] };
    }
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
→ routeros_search_tests: cross-device performance ranking (all 125 devices at once, e.g., 512B routing benchmark)
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

// ---- routeros_search_tests ----

server.registerTool(
  "routeros_search_tests",
  {
    description: `Query device performance test results across all devices.

Returns throughput benchmarks from mikrotik.com product pages — one call replaces
what would otherwise require 125+ individual device lookups.

**Data:** 2,874 test results across 125 devices (March 2026).
- Ethernet: bridging/routing throughput at 64/512/1518 byte packets
- IPSec: tunnel throughput with AES/SHA cipher configurations
- Results include kpps (packets/sec) and Mbps

**Common queries:**
- Routing performance ranking: test_type="ethernet", mode="Routing", configuration="25 ip filter rules", packet_size=512
- Bridge performance: test_type="ethernet", mode="Bridging", configuration="25 bridge filter"
- IPSec throughput: test_type="ipsec", mode="Single tunnel", configuration="AES-128-CBC"

**Configuration matching:** Uses LIKE (substring) — "25 ip filter" matches "25 ip filter rules".
Note: some devices use slightly different names (e.g., "25 bridge filter" vs "25 bridge filter rules").

**Tip:** Call with no filters first to see available test_types, modes, configurations, and packet_sizes via the metadata field.

Results include product_name, product_code, architecture — use routeros_device_lookup for full specs (CPU, RAM, ports, etc.).
For bulk export/reporting, attach the MCP resource rosetta://datasets/device-test-results.csv in clients that support MCP resources.

Workflow:
→ routeros_device_lookup: get full specs (CPU, RAM, pricing) + block diagram for a specific device
→ routeros_search: find documentation about features relevant to the test type`,
    inputSchema: {
      device: z
        .string()
        .optional()
        .describe("Filter by device product name (substring match, e.g., 'RB5009', 'hAP', 'CCR2216')"),
      test_type: z
        .string()
        .optional()
        .describe("Filter: 'ethernet' or 'ipsec'"),
      mode: z
        .string()
        .optional()
        .describe("Filter: e.g., 'Routing', 'Bridging', 'Single tunnel', '256 tunnels'"),
      configuration: z
        .string()
        .optional()
        .describe("Filter (substring match): e.g., '25 ip filter rules', 'AES-128-CBC + SHA1', 'none (fast path)'"),
      packet_size: z
        .number()
        .int()
        .optional()
        .describe("Filter: packet size in bytes (64, 512, 1400, 1518)"),
      sort_by: z
        .enum(["mbps", "kpps"])
        .optional()
        .default("mbps")
        .describe("Sort results by throughput metric (default: mbps)"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .default(50)
        .describe("Max results (default 50, max 200)"),
    },
  },
  async ({ device, test_type, mode, configuration, packet_size, sort_by, limit }) => {
    const hasFilters = device || test_type || mode || configuration || packet_size;

    if (!hasFilters) {
      // Discovery mode: return available filter values
      const meta = getTestResultMeta();
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            message: "No filters provided. Here are the available values — use these to build your query:",
            ...meta,
            hint: "Common query: test_type='ethernet', mode='Routing', configuration='25 ip filter rules', packet_size=512",
          }, null, 2),
        }],
      };
    }

    const result = searchDeviceTests(
      { device, test_type, mode, configuration, packet_size, sort_by },
      limit,
    );

    if (result.results.length === 0) {
      const hints = [
        "Call with no filters to see available test types, modes, and configurations",
        configuration ? `Try a shorter configuration substring (e.g., "25 ip filter" instead of the full string)` : null,
      ].filter(Boolean);
      return {
        content: [{
          type: "text",
          text: `No test results matched the filters.\n\nTry:\n${hints.map((h) => `- ${h}`).join("\n")}`,
        }],
      };
    }

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ...result,
          has_more: result.total > result.results.length,
        }, null, 2),
      }],
    };
  },
);

// ---- routeros_current_versions ----

server.registerTool(
  "routeros_current_versions",
  {
    description: `Fetch current RouterOS version numbers from MikroTik's upgrade server.

Returns the latest version for each release channel (stable, long-term, testing, development) plus the current WinBox 4 version.
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
