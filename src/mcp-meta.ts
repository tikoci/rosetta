/**
 * mcp-meta.ts — small constants shared between the MCP server (`mcp.ts`)
 * and the TUI dot-commands (`browse.ts`).
 *
 * Lives in its own module so importing it from `browse.ts` does not pull
 * in `mcp.ts`'s top-level CLI dispatch / async IIFE (which would try to
 * launch the MCP server as a side effect of importing).
 */

/** MCP `instructions` string sent to clients on init. The TUI's
 *  `.instructions` dot-command shows the same text an agent sees. */
export const MCP_INSTRUCTIONS =
  "RouterOS documentation search. Start with routeros_search for any RouterOS question — it runs a classifier (detects command paths, versions, devices, topics) + BM25 FTS, and returns pages plus a `related` block (command_node, properties, devices, callouts, videos, changelogs, skills) + next-step hints. One call usually answers the question. Drill into specific pages with routeros_get_page; for hardware specs use routeros_device_lookup; for version-specific command changes use routeros_command_diff. Only v7 data exists (7.9+) — v6 is out of scope.";

/** Static metadata for the registered MCP resources. Kept in sync with the
 *  `server.registerResource` calls in `mcp.ts`; exposed for the TUI
 *  `.resources` dot-command. Per-skill resources are discovered dynamically
 *  via `listSkills()` at call time. */
export const MCP_STATIC_RESOURCES: ReadonlyArray<{
  uri: string;
  title: string;
  description: string;
  mimeType: string;
}> = [
  {
    uri: "rosetta://datasets/device-test-results.csv",
    title: "Device Test Results CSV",
    description: "Full joined benchmark dataset as CSV.",
    mimeType: "text/csv",
  },
  {
    uri: "rosetta://datasets/devices.csv",
    title: "Devices CSV",
    description: "Device catalog with normalized RAM/storage and URLs.",
    mimeType: "text/csv",
  },
  {
    uri: "rosetta://schema.sql",
    title: "Database Schema DDL",
    description: "Full SQLite DDL for ros-help.db.",
    mimeType: "application/sql",
  },
  {
    uri: "rosetta://schema-guide.md",
    title: "Schema Guide",
    description:
      "Table relationships, FTS5 quirks, BM25 weights, query patterns.",
    mimeType: "text/markdown",
  },
  {
    uri: "rosetta://skills",
    title: "RouterOS Agent Skills",
    description:
      "List of community-created agent skill guides (tikoci/routeros-skills).",
    mimeType: "text/markdown",
  },
];
