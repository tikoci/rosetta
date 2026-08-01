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
 *   ROSETTA_OFFLINE — set to "1" to skip all DB freshness/redownload network
 *     attempts; a release-tag-only mismatch falls back to the existing DB
 *     with a warning, a genuine schema mismatch still fails hard (offline
 *     can't fix an unqueryable DB)
 *   PORT    — HTTP listen port (lower precedence than --port)
 *   HOST    — HTTP bind address (lower precedence than --host)
 *   TLS_CERT_PATH — TLS certificate path (lower precedence than --tls-cert)
 *   TLS_KEY_PATH  — TLS private key path (lower precedence than --tls-key)
 */

import { MCP_INSTRUCTIONS } from "./mcp-meta.ts";
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
 * Ensure the DB exists, has page data, and matches the current schema version
 * and release. This must run before importing db.ts/query.ts to avoid
 * creating an empty DB file on fresh installs.
 *
 * Failure modes are explicit:
 *   - Missing or empty DB → download once. If download fails, abort startup —
 *     package-mode startup must not continue into db.ts and create a schema-only DB.
 *     ROSETTA_OFFLINE=1 skips the attempt and fails immediately (nothing to fall back to).
 *   - Schema mismatch → re-download once, then re-probe. If still mismatched,
 *     fail hard with an actionable message rather than silently using a DB
 *     that the running code can't query correctly. Still fails hard under
 *     ROSETTA_OFFLINE=1 — offline can't fix an unqueryable DB either way.
 *   - Release-tag mismatch only (bunx resolved a newer version, same schema,
 *     content bumped — see setup.ts's checkDbFreshness) → re-download, but
 *     degrade gracefully to the existing, still-queryable DB if that fails
 *     (e.g. offline, or ROSETTA_OFFLINE=1 set deliberately) instead of
 *     crashing startup over it.
 */
async function ensureDbReady(log: (msg: string) => void): Promise<void> {
  const { resolveDbPath, SCHEMA_VERSION, resolveVersion, detectMode, classifyDbGrounding, isDevInvocation } = await import("./paths.ts");
  const { checkDbFreshness, cleanupAbandonedTempArtifacts, downloadDb, hasMinimumDbContent, probeDb } = await import(
    "./setup.ts"
  );

  const dbPath = resolveDbPath(import.meta.dirname);
  const runningVersion = resolveVersion(import.meta.dirname);
  const mode = detectMode(import.meta.dirname);
  const offline = process.env.ROSETTA_OFFLINE === "1";

  // Always clean abandoned .tmp.* artifacts from previous failed runs when no
  // active download lock exists, regardless of whether a download is needed now.
  cleanupAbandonedTempArtifacts(dbPath);

  let p = probeDb(dbPath);

  // Case 1: DB missing or empty → first-time download. ROSETTA_OFFLINE=1 fails
  // fast here instead of hanging on a network attempt that can't succeed —
  // there is no existing DB to gracefully fall back to.
  if (!hasMinimumDbContent(p) && offline) {
    throw new Error(
      `ROSETTA_OFFLINE=1 set and no usable database exists at ${dbPath}; unset ROSETTA_OFFLINE and run --refresh once online.`,
    );
  }
  if (!hasMinimumDbContent(p)) {
    log(`No usable database at ${dbPath} — downloading...`);
    try {
      p = await downloadDb(dbPath, log);
      log("Database downloaded successfully.");
    } catch (e) {
      log(`Auto-download failed: ${e instanceof Error ? e.message : e}`);
      log(`Close other rosetta clients and run: bunx @tikoci/rosetta@latest --refresh`);
      throw new Error(`Unable to start rosetta without a usable database at ${dbPath}.`);
    }
  }

  if (!p) {
    throw new Error(`Database probe failed after download: ${dbPath}`);
  }

  if (!hasMinimumDbContent(p)) {
    throw new Error(`Database remained incomplete after recovery: ${dbPath}`);
  }

  // Case 2: Schema mismatch, or a same-schema release-tag mismatch (bunx
  // resolved a newer published version — see checkDbFreshness) → re-download,
  // then re-probe and fail hard only if the schema is still actually wrong.
  const freshness = checkDbFreshness(p, { schemaVersion: SCHEMA_VERSION, runningVersion, mode });
  if (freshness.redownload) {
    log(`${freshness.reason} ${offline ? "ROSETTA_OFFLINE=1 set — skipping redownload." : "Re-downloading database..."}`);
    const previous = p;
    try {
      // ROSETTA_OFFLINE=1 short-circuits the network attempt entirely rather
      // than letting it time out — treated as a download failure so it falls
      // into the same hard-fail-vs-graceful branching below as a real one.
      if (offline) {
        throw new Error("ROSETTA_OFFLINE=1 set; not attempting a network download");
      }
      p = await downloadDb(dbPath, log);
    } catch (e) {
      if (!freshness.hardFailOnDownloadError) {
        // Release-tag-only mismatch: `previous` is already schema-current and
        // fully queryable, so a failed refresh (e.g. offline) just means we
        // keep serving it — fall through to the shared banner below instead
        // of crashing startup over content that hasn't finished propagating.
        log(
          `⚠ Refresh check failed (${e instanceof Error ? e.message : e}); continuing with the existing ` +
            `database (release ${previous.releaseTag ?? "unknown"}).`,
        );
        p = previous;
      } else {
        log(`✗ Auto-recovery download failed: ${e instanceof Error ? e.message : e}`);
        log(
          `  This rosetta build (v${runningVersion}) cannot use the existing DB. ` +
            `Close other rosetta clients and run: bunx @tikoci/rosetta@latest --refresh`,
        );
        throw new Error(`Unable to recover an incompatible database at ${dbPath}.`);
      }
    }
    if (!p || !hasMinimumDbContent(p) || p.schemaVersion !== SCHEMA_VERSION) {
      log(
        `✗ Still incompatible after re-download (DB=${p?.schemaVersion ?? "unreadable"}, expected=${SCHEMA_VERSION}).`,
      );
      log(
        `  The published database does not match this rosetta build (v${runningVersion}). ` +
          `Run: bunx @tikoci/rosetta@latest --refresh`,
      );
      throw new Error(`Database remained incompatible after recovery: ${dbPath}`);
    }
  }

  // Quietly emit a one-line provenance banner so MCP-client logs show what's loaded.
  const tagInfo = p.releaseTag ? `, release ${p.releaseTag}` : "";
  log(`rosetta v${runningVersion} ready (DB schema v${p.schemaVersion}, ${p.pages} pages${tagInfo}).`);

  // Dev-mode grounding warning (#94): checkDbFreshness intentionally ignores
  // release-tag drift in a checkout so it never clobbers a contributor's local
  // build — but that means a schema-matching, wrong-corpus DB (e.g. a pragma
  // bumped in place over a stale corpus) starts up silently. Surface it loudly.
  // Never triggers a fetch; the served DB is unchanged.
  if (isDevInvocation(mode)) {
    const verdict = classifyDbGrounding({
      pragmaSchema: p.schemaVersion,
      metaSchema: p.metaSchemaVersion,
      releaseTag: p.releaseTag,
      builtAt: p.builtAt,
      sourceCommit: p.sourceCommit,
      codeSchema: SCHEMA_VERSION,
      codeVersion: runningVersion,
      mode,
    });
    if (!verdict.ok) {
      log(`⚠ DB grounding: ${verdict.status.toUpperCase()} — ${verdict.detail}`);
      log(`  Resolved DB: ${dbPath}`);
      log(`  This DB may not match the code you are reading. Run 'make db-sync' to fetch the latest CI release DB,`);
      log(`  or 'bun run db:doctor' for full provenance. See MANUAL.md → "Local DB grounding (dev checkouts)".`);
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
  console.log("  rosetta browse <cmd> [args]  Run any TUI command once, then open REPL");
  console.log("  rosetta browse --once <cmd>  Execute any TUI command and exit");
  console.log("  rosetta export <dir> [--force]  Write DB-only dataset directory (TSV + manifest.toml)");
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
  console.log("  ROSETTA_OFFLINE=1  Skip DB freshness network checks (fall back to existing DB)");
  console.log("  PORT     HTTP listen port (lower precedence than --port)");
  console.log("  HOST     HTTP bind address (lower precedence than --host)");
  console.log("  TLS_CERT_PATH  TLS certificate path (lower precedence than --tls-cert)");
  console.log("  TLS_KEY_PATH   TLS private key path (lower precedence than --tls-key)");
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

if (args[0] === "export") {
  const rest = args.slice(1);
  const force = rest.includes("--force");
  const outDir = rest.find((a) => !a.startsWith("-"));
  if (!outDir) {
    console.error("Usage: rosetta export <dir> [--force]");
    process.exit(1);
  }
  await ensureDbReady((msg) => process.stderr.write(`${msg}\n`));
  const { db } = await import("./db.ts");
  const { runExport } = await import("./export.ts");
  try {
    const summary = await runExport(outDir, db, {
      force,
      // On a TTY, offer an interactive overwrite instead of a flat refusal; in a
      // pipe/CI (no TTY) there is no prompt, so a foreign dir needs --force.
      confirmForeign: process.stdin.isTTY
        ? (dir) => (prompt(`export: ${dir} is not empty and has no rosetta manifest. Overwrite? [y/N]`) ?? "").trim().toLowerCase().startsWith("y")
        : undefined,
    });
    const srcNote = summary.sourceFiles.length > 0 ? ` + ${summary.sourceFiles.length} source files` : "";
    console.log(`Wrote ${summary.files.length} datasets${srcNote} + manifest.toml to ${summary.outDir}`);
    for (const f of summary.files) console.log(`  ${f.name}  (${f.rows} rows)`);
    for (const f of summary.sourceFiles) console.log(`  ${f.name}  (${f.bytes} bytes)`);
    process.exit(0);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

if (args.includes("--setup")) {
  const { runSetup } = await import("./setup.ts");
  await runSetup(args.includes("--force"));
  process.exit(0);
}

if (args.includes("--refresh")) {
  // Quiet refresh: just download + validate. Skips the MCP-config printing
  // that --setup does — users running --refresh already have a configured client.
  const { refreshDb } = await import("./setup.ts");
  const ok = await refreshDb();
  process.exit(ok ? 0 : 1);
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
  explainCommand,
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

/** MCP `instructions` string sent to clients on init. Exported so the TUI's
 *  `.instructions` dot-command can show the same text an agent sees. */
// MCP_INSTRUCTIONS now lives in mcp-meta.ts (importing it from browse.ts
// must not trigger this file's top-level CLI dispatch IIFE).

/** Factory: create a new McpServer with all tools registered.
 *  Called once for stdio, or per-session for HTTP transport. */
function createServer() {

const server = new McpServer({
  name: "rosetta",
  version: RESOLVED_VERSION,
}, {
  instructions: MCP_INSTRUCTIONS,
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

Row counts below are **order-of-magnitude only** — they orient query planning, not
exact inventory. Call \`routeros_stats\` for live counts (the single source of truth);
the corpus grows every extraction, so no exact count is baked in here.

| Table | Rows (approx) | Description |
|-------|-------------|-------------|
| \`pages\` | ~360 | One row per doc page. Primary content store (Docusaurus manual.mikrotik.com/docs). |
| \`sections\` | ~3K | h1–h3 chunks of pages with anchor IDs for deep-linking. |
| \`properties\` | ~4.6K | CLI property rows extracted from doc tables and property lists. |
| \`callouts\` | ~950 | Note/Warning/Info/Tip admonition blocks lifted from the docs. |
| \`commands\` | ~40K | RouterOS command tree entries (dir/cmd/arg) from inspect.json. |
| \`command_versions\` | ~2M+ | Junction: which command paths exist in which RouterOS versions. |
| \`ros_versions\` | dozens | Metadata per extracted RouterOS version (range reported by \`routeros_stats\`). |
| \`devices\` | ~155 | MikroTik hardware specs from product matrix CSV. |
| \`hardware_catalog\` | ~255 | Wider device universe (matrix + accessories/series/legacy) from manual.mikrotik.com/hardware + mikrotik.com/product. |
| \`device_aliases\` | ~750 | Normalized alias/slug/code → canonical device, for free-form device resolution. |
| \`device_test_results\` | ~3K | Ethernet/IPSec benchmark rows from mikrotik.com product pages. |
| \`changelogs\` | varies | Parsed per-entry changelog lines from MikroTik download server. |
| \`videos\` | ~660 | MikroTik YouTube video metadata. |
| \`video_segments\` | ~2.2K | Chapter-level transcript segments (one per chapter or one per video). |

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
- classified: { version, topics, command_path, command_path_confidence, device, property } — what the
  classifier detected from your input; command_path_confidence is high/medium/low
- pages: top FTS matches (title, path, URL, excerpt, best_section)
- related: callouts, properties, changelogs, videos, commands, devices, skills,
  glossary — empty sections are omitted. Cap scales with \`limit\`: small limit
  (default 8) keeps related tight (~3 callouts, ~2 videos); larger limit widens
  the net proportionally so a single "hungry" call can pull deeper context.
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
- Documentation: live manual.mikrotik.com/docs (Docusaurus) prose corpus; call routeros_stats for counts and version range
- Command data: RouterOS v7 only (7.9+). No v6 data.`,
    inputSchema: {
      query: z.string().describe("Natural language search query, command path, or identifier"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .default(8)
        .describe("Max page results (default 8). Related-section caps scale with this — set higher (e.g. 20) to pull more callouts/videos/properties in a single call."),
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

Returns type, default value, description, documentation page, section_anchor, and confidence.
Optionally filter by command path to disambiguate (e.g., "disabled" appears everywhere).

With command_path, rows come back best-first and confidence says how strongly THAT row is
tied to THAT menu:
- high — the section documenting the row names the menu, and the command tree agrees the
  menu takes this property
- medium — the section names a neighbouring menu (parent or child), or only the page matches
- low — nothing links the row to the menu beyond the property name; treat as a candidate,
  not an answer
Without command_path every row is medium: there is no menu to align to, so the tier is not
answering the same question. A "low" row is not necessarily wrong — 42.7% of documentation
sections never name the menu they describe — but it is unverified:
→ routeros_command_tree: confirm the property exists at that command path before relying on it

A single page may document the same property name several times, each meaning something
different in its own section — "name" on the PPP AAA page is the profile name, the login
name, and the active-user name. Those rows are distinguished by section_anchor, not by
section (which is heading text and repeats: all three read "Properties"). Read a specific
one in context with:
→ routeros_get_page: pass the row's page, and its section_anchor as the section argument

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

// ---- routeros_explain_command ----

server.registerTool(
  "routeros_explain_command",
  {
    description: `Explain a candidate RouterOS CLI command using rosetta's offline docs and command tree.

This is a read-only tier-1 helper for write-shaped questions: it canonicalizes
the command, annotates key=value arguments with documented properties, checks
tracked RouterOS version presence, and returns compact docs/changelog context.
It never connects to a router, validates against a live device, or executes anything.

Returns:
- command: original input
- canonical: { path, verb, args, confidence } for the primary non-subshell command
- confidence: high/medium/low/none from the CLI canonicalizer
- args: parsed key=value args with first property match and lookup confidence when found
- warnings: no-command, low-confidence, unknown-arg, command-not-in-version, or model-context-unused signals
- pages: compact documentation search hits
- changelog_hits: compact changelog hits
- version_check: command version range when a canonical path is available

Workflow:
→ routeros_get_page: read full docs for a returned page
→ routeros_lookup_property: inspect a specific argument/property in more detail
→ routeros_command_tree: browse available commands/arguments under the canonical path
→ routeros_command_version_check / routeros_command_diff: investigate version-specific availability

Boundaries: Documentation covers RouterOS v7, aligned with long-term ~7.22; command data covers 7.9–7.23beta2. This tool is explanatory only — use a separate validator/runner before touching a router.`,
    inputSchema: {
      command: z
        .string()
        .describe("RouterOS CLI command to explain (e.g., '/ip/firewall/filter add chain=forward action=drop')"),
      ros_version: z
        .string()
        .optional()
        .describe("Optional RouterOS version to check against tracked command availability (e.g., '7.22')."),
      model: z
        .string()
        .optional()
        .describe("Optional device model context. Accepted for future use; device-specific validation is not implemented."),
    },
  },
  async ({ command, ros_version, model }) => {
    const result = explainCommand(command, ros_version, model);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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

Returns live corpus counts (pages, properties, callouts, changelogs, commands, link coverage),
version range, available agent skills, and a **provenance** block: the resolved DB path, its
db_meta stamps (release_tag / source_commit / built_at / schema_version), and a **grounding
verdict** (status ok / schema_mismatch / internal_inconsistent / provenance_incomplete / tag_behind
/ unstamped). Use the verdict to confirm the DB you are querying is schema/release-compatible with
the code you are reading before trusting counts — "ok" means compatible (schema coherent, all four
stamps present, release not behind), not that the DB was built from this exact commit (#94). All
counts here are live — do not rely on any numbers baked into prose elsewhere.

Skills: Community-created agent guides from tikoci/routeros-skills are available as MCP resources
at rosetta://skills/{name}. Use the resource listing to browse available skills.

Knowledge boundaries:
- Documentation corpus: see provenance.built_at / provenance.release_tag for what this DB actually is
- Command tree: RouterOS 7.9+ from inspect.json (with extra-packages from CHR); see ros_version range
- No RouterOS v6 data available — v6 syntax and subsystems differ significantly from v7
- For versions older than 7.9, no command tree data exists
- Versions older than current long-term are unpatched by MikroTik
- Absence of a peripheral in docs doesn't mean unsupported — most MBIM modems work

→ routeros_search: probe the corpus these stats describe with any RouterOS question`,
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

Two layers: the RouterOS **product matrix** (devices with full structured specs + test results) plus a
wider **hardware catalog** (accessories, series, and legacy/discontinued entries) overlaid from
manual.mikrotik.com/hardware + mikrotik.com/product. Returns hardware specs, official test results,
block diagram URLs, and pricing. (Use routeros_stats for live corpus counts.)

**How it works:**
- Exact product name/code → full specs + test results + block diagram
- **Alias resolution** — old names, product codes, and www/hardware slugs resolve to the canonical
  device (e.g. "RB750Gr3" → hEX, "cap_ac" → cAP ac). A resolved single device carries a \`hardware\`
  overlay block (category, discontinued, also_known_as, product/hardware page URLs) — use the
  \`rosetta_device_id\` in it for a stable, persistable device key; no need to fetch the page URLs.
- Non-matrix entities (accessories/series/legacy) return in \`catalog\` as labeled thin rows with a
  \`kind\` field, so an accessory is never mistaken for a router.
- Otherwise → FTS search + optional structured filters → matching devices (compact)
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

Data: RouterOS product matrix + manual.mikrotik.com/hardware overlay (2026 snapshot). See routeros_stats for counts.`,
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

    // A hard miss only when neither a matrix device NOR a catalog-only entity resolved —
    // otherwise fall through and serialize `result` (which carries the `catalog` array).
    if (result.results.length === 0 && (result.catalog?.length ?? 0) === 0) {
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

**Default ordering:** Results are sorted by throughput DESC. When \`packet_size\` is NOT specified,
512-byte rows are surfaced first (within the LIMIT) before other sizes — 512B is the conventional
mid-size benchmark RouterOS admins compare on, so this keeps comparable values from being crowded
out by 1518B "best case" rows. Pin \`packet_size\` to override.

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

Requires network access to upgrade.mikrotik.com.

→ routeros_search_changelogs: read what changed *into* the current/target version (use to_version=<latest> and from_version=<user's version>)`,
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

})().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
