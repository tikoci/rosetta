#!/usr/bin/env bun
/**
 * extract-schema.ts — Import RouterOS command tree from deep-inspect JSON files
 * into the schema_nodes + schema_node_presence tables.
 *
 * Processes both x86 and arm64 deep-inspect files for a single version,
 * merges path sets, marks arch-specific nodes, parses desc_raw into
 * structured columns (data_type, enum_values, etc.), extracts _completion
 * data into _attrs, and derives dir_role.
 *
 * Also regenerates the legacy `commands` and `command_versions` tables
 * for backward compatibility with existing query functions.
 *
 * Usage:
 *   bun run src/extract-schema.ts --x86=<path-or-url> --arm64=<path-or-url> [--version=7.22.1]
 *   bun run src/extract-schema.ts --x86=<path-or-url>                       # x86 only (no arm64)
 *   bun run src/extract-schema.ts --accumulate --x86=... --arm64=...        # junction only
 *
 * Flags:
 *   --version=X       Override version (auto-derived from _meta or filename)
 *   --channel=X       Override channel (auto-derived from version string)
 *   --extra           Mark as extra-packages build
 *   --accumulate      Only add to schema_node_presence + command_versions; don't rebuild schema_nodes/commands
 *   --x86=<src>       Path or URL to deep-inspect.x86.json (or inspect.json)
 *   --arm64=<src>     Path or URL to deep-inspect.arm64.json
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeepInspectMeta {
  version?: string;
  generatedAt?: string;
  architecture?: string;
  apiTransport?: string;
  enrichmentDurationMs?: number;
  crashPathsTested?: string[];
  crashPathsCrashed?: string[];
  crashPathsSafe?: string[];
  completionStats?: Record<string, unknown>;
}

interface CompletionValue {
  style?: string;
  preference?: number;
  desc?: string;
}

export interface FlatNode {
  path: string;
  name: string;
  type: string; // 'dir' | 'cmd' | 'arg'
  parentPath: string | null;
  descRaw: string | null;
  completion: Record<string, CompletionValue> | null;
}

interface ParsedDesc {
  dataType: string | null;
  enumValues: string | null; // JSON array
  enumMulti: number | null;
  typeTag: string | null;
  rangeMin: string | null;
  rangeMax: string | null;
  maxLength: number | null;
}

// ---------------------------------------------------------------------------
// Helpers — exported for testing
// ---------------------------------------------------------------------------

export function nodeKey(n: FlatNode): string {
  return `${n.path}\0${n.type}`;
}

// ---------------------------------------------------------------------------
// Tree walker — flatten inspect JSON into FlatNode[]
// ---------------------------------------------------------------------------

export function walk(obj: Record<string, unknown>, parentPath: string, nodes: FlatNode[]) {
  for (const [key, value] of Object.entries(obj)) {
    if (key === "_type" || key === "desc" || key === "_meta" || key === "_completion") continue;
    if (typeof value !== "object" || value === null) continue;

    const node = value as Record<string, unknown>;
    const nodeType = node._type as string | undefined;
    if (!nodeType) continue;

    const currentPath = parentPath ? `${parentPath}/${key}` : `/${key}`;
    const descRaw = typeof node.desc === "string" ? node.desc : null;
    const normalizedType = nodeType === "path" ? "dir" : nodeType;

    // Extract _completion for args
    let completion: Record<string, CompletionValue> | null = null;
    if (node._completion && typeof node._completion === "object") {
      completion = node._completion as Record<string, CompletionValue>;
    }

    nodes.push({
      path: currentPath,
      name: key,
      type: normalizedType,
      parentPath: parentPath || null,
      descRaw,
      completion,
    });

    // Recurse into children (dirs and cmds have children)
    if (normalizedType === "dir" || normalizedType === "cmd") {
      walk(node, currentPath, nodes);
    }
  }
}

// ---------------------------------------------------------------------------
// Merge two arch node sets — shared, x86-only, arm64-only
// ---------------------------------------------------------------------------

export function mergeArchNodes(
  x86Nodes: FlatNode[],
  arm64Nodes: FlatNode[],
): Array<FlatNode & { arch: string | null }> {
  const x86Map = new Map<string, FlatNode>();
  const arm64Map = new Map<string, FlatNode>();
  for (const n of x86Nodes) x86Map.set(nodeKey(n), n);
  for (const n of arm64Nodes) arm64Map.set(nodeKey(n), n);

  const allKeys = new Set([...x86Map.keys(), ...arm64Map.keys()]);
  const merged: Array<FlatNode & { arch: string | null }> = [];

  for (const key of allKeys) {
    const x86Node = x86Map.get(key);
    const arm64Node = arm64Map.get(key);

    if (x86Node && arm64Node) {
      // Shared — prefer x86 data but merge completion from both if needed
      const m = { ...x86Node, arch: null as string | null };
      if (!m.completion && arm64Node.completion) m.completion = arm64Node.completion;
      if (!m.descRaw && arm64Node.descRaw) m.descRaw = arm64Node.descRaw;
      merged.push(m);
    } else if (x86Node) {
      merged.push({ ...x86Node, arch: "x86" });
    } else if (arm64Node) {
      merged.push({ ...arm64Node, arch: "arm64" });
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// desc_raw parser — decompose into structured fields
// ---------------------------------------------------------------------------

export function parseDesc(desc: string | null): ParsedDesc {
  const result: ParsedDesc = {
    dataType: null,
    enumValues: null,
    enumMulti: null,
    typeTag: null,
    rangeMin: null,
    rangeMax: null,
    maxLength: null,
  };
  if (!desc) return result;

  const trimmed = desc.trim();

  // "script"
  if (trimmed === "script") {
    result.dataType = "script";
    return result;
  }

  // "string value, max length N"
  const strMaxMatch = trimmed.match(/^string value,\s*max length\s+(\d+)$/i);
  if (strMaxMatch) {
    result.dataType = "string";
    result.maxLength = Number(strMaxMatch[1]);
    return result;
  }

  // "string value"
  if (trimmed === "string value") {
    result.dataType = "string";
    return result;
  }

  // "time interval" (bare)
  if (trimmed === "time interval") {
    result.dataType = "time";
    return result;
  }

  // "A..B    (time interval)" — range with time qualifier
  const timeRangeMatch = trimmed.match(/^(\S+)\.\.(\S+)\s+\(time interval\)$/);
  if (timeRangeMatch) {
    result.dataType = "time";
    result.rangeMin = timeRangeMatch[1];
    result.rangeMax = timeRangeMatch[2];
    return result;
  }

  // "A..B    (integer)" — range with integer qualifier
  const intRangeMatch = trimmed.match(/^(\S+)\.\.(\S+)\s+\(integer\)$/);
  if (intRangeMatch) {
    result.dataType = "integer";
    result.rangeMin = intRangeMatch[1];
    result.rangeMax = intRangeMatch[2];
    return result;
  }

  // Generic range: "A..B" without qualifier
  const genericRangeMatch = trimmed.match(/^(\S+)\.\.(\S+)$/);
  if (genericRangeMatch) {
    result.dataType = "range";
    result.rangeMin = genericRangeMatch[1];
    result.rangeMax = genericRangeMatch[2];
    return result;
  }

  // Enum with optional multi marker: "a|b|c[,TypeTag*]"
  // Also matches "a|b|c" (no bracket)
  const enumMatch = trimmed.match(/^([a-zA-Z0-9_-]+(?:\|[a-zA-Z0-9_-]+)+)(?:\[,([^\]*]+)\*?\])?$/);
  if (enumMatch) {
    const values = enumMatch[1].split("|");
    result.dataType = "enum";
    result.enumValues = JSON.stringify(values);
    if (enumMatch[2]) {
      result.enumMulti = 1;
      result.typeTag = enumMatch[2];
    }
    return result;
  }

  // "integer" (bare)
  if (trimmed === "integer") {
    result.dataType = "integer";
    return result;
  }

  // If none matched, leave all NULL — desc_raw is preserved
  return result;
}

// ---------------------------------------------------------------------------
// dir_role derivation
// ---------------------------------------------------------------------------

function deriveDirRoles(nodes: FlatNode[]): Map<string, string> {
  const dirRoles = new Map<string, string>();

  // Build a map of path → child types
  const childTypes = new Map<string, Set<string>>();
  for (const node of nodes) {
    if (!node.parentPath) continue;
    const set = childTypes.get(node.parentPath);
    if (set) set.add(node.type);
    else childTypes.set(node.parentPath, new Set([node.type]));
  }

  for (const node of nodes) {
    if (node.type !== "dir") continue;
    const children = childTypes.get(node.path);
    if (!children || children.size === 0) {
      dirRoles.set(node.path, "namespace"); // empty dir = namespace
      continue;
    }

    const hasCmd = children.has("cmd");
    const hasDir = children.has("dir");
    // Args are children of cmds, not dirs directly, but some dirs have args too
    const hasArg = children.has("arg");

    if (hasCmd && hasDir) {
      dirRoles.set(node.path, "hybrid");
    } else if (hasCmd || hasArg) {
      dirRoles.set(node.path, "list");
    } else {
      dirRoles.set(node.path, "namespace");
    }
  }

  return dirRoles;
}

// ---------------------------------------------------------------------------
// Version derivation helpers (shared with extract-commands.ts)
// ---------------------------------------------------------------------------

function deriveVersion(filepath: string): string {
  const match = filepath.match(/\/(\d+\.\d+(?:\.\d+)?(?:beta\d+|rc\d+)?)\//);
  return match?.[1] ?? "unknown";
}

function deriveChannel(version: string): string {
  if (version.includes("beta") || version.includes("rc")) return "development";
  return "stable";
}

// ---------------------------------------------------------------------------
// Import function — used by CLI and tests
// ---------------------------------------------------------------------------

interface ImportOptions {
  accumulate: boolean;
  extraPackages: boolean;
  channel: string;
  x86Source: string | null;
  arm64Source: string | null;
  x86Meta?: DeepInspectMeta;
  arm64Meta?: DeepInspectMeta;
}

export function importSchemaNodes(
  // biome-ignore lint/suspicious/noExplicitAny: duck-typed to accept bun:sqlite Database or test stubs
  db: any,
  mergedNodes: Array<FlatNode & { arch: string | null }>,
  version: string,
  opts: ImportOptions,
) {
  const { accumulate, extraPackages, channel, x86Source, arm64Source, x86Meta, arm64Meta } = opts;

  // Derive dir_role for all dirs
  const dirRoles = deriveDirRoles(mergedNodes);

  // Parse desc for all nodes
  const parsedDescs = new Map<string, ParsedDesc>();
  for (const node of mergedNodes) {
    parsedDescs.set(nodeKey(node), parseDesc(node.descRaw));
  }

  // Register versions in ros_versions (one row per arch file loaded)
  const registerVersion = (
    archMeta: DeepInspectMeta | undefined,
    archName: string,
    sourceUrl: string | null,
  ) => {
    if (!sourceUrl) return;
    db.run(
      `INSERT OR REPLACE INTO ros_versions
       (version, arch, channel, extra_packages, extracted_at,
        generated_at, crash_paths_tested, crash_paths_crashed, crash_paths_safe,
        completion_stats, source_url, api_transport, enrichment_duration_ms, _attrs)
       VALUES (?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        version,
        archName,
        channel,
        extraPackages ? 1 : 0,
        archMeta?.generatedAt ?? null,
        archMeta?.crashPathsTested ? JSON.stringify(archMeta.crashPathsTested) : null,
        archMeta?.crashPathsCrashed ? JSON.stringify(archMeta.crashPathsCrashed) : null,
        archMeta?.crashPathsSafe ? JSON.stringify(archMeta.crashPathsSafe) : null,
        archMeta?.completionStats ? JSON.stringify(archMeta.completionStats) : null,
        sourceUrl,
        archMeta?.apiTransport ?? null,
        archMeta?.enrichmentDurationMs ?? null,
        null, // _attrs — reserved for future catch-all
      ],
    );
  };

  if (x86Source) registerVersion(x86Meta, "x86", x86Source);
  if (arm64Source) registerVersion(arm64Meta, "arm64", arm64Source);

  if (!accumulate) {
    // Primary mode: rebuild schema_nodes and commands
    db.run("DELETE FROM schema_node_presence;");
    db.run("DELETE FROM schema_nodes;");

    // Insert schema_nodes
    const insertNode = db.prepare(`
      INSERT INTO schema_nodes
        (path, name, type, parent_path, dir_role, desc_raw,
         data_type, enum_values, enum_multi, type_tag,
         range_min, range_max, max_length,
         _arch, _package, _attrs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertNodes = db.transaction(() => {
      for (const node of mergedNodes) {
        const parsed = parsedDescs.get(nodeKey(node)) ?? parseDesc(node.descRaw);
        const attrs = node.completion
          ? JSON.stringify({ completion: node.completion })
          : null;

        insertNode.run(
          node.path,
          node.name,
          node.type,
          node.parentPath,
          node.type === "dir" ? (dirRoles.get(node.path) ?? null) : null,
          node.descRaw,
          parsed.dataType,
          parsed.enumValues,
          parsed.enumMulti,
          parsed.typeTag,
          parsed.rangeMin,
          parsed.rangeMax,
          parsed.maxLength,
          node.arch,
          null, // _package
          attrs,
        );
      }
    });
    insertNodes();

    // Set parent_id via self-join — no type filter: args have cmd parents, dirs/cmds have dir parents
    db.run(`
      UPDATE schema_nodes SET parent_id = (
        SELECT p.id FROM schema_nodes p
        WHERE p.path = schema_nodes.parent_path
        LIMIT 1
      )
      WHERE parent_path IS NOT NULL;
    `);

    const nodeCount = (db.prepare("SELECT COUNT(*) as c FROM schema_nodes").get() as { c: number }).c;
    console.log(`\nInserted ${nodeCount} schema_nodes (primary: ${version})`);

    // Show type breakdown
    const typeBreakdown = db
      .prepare("SELECT type, COUNT(*) as c FROM schema_nodes GROUP BY type ORDER BY c DESC")
      .all() as Array<{ type: string; c: number }>;
    for (const t of typeBreakdown) {
      console.log(`  ${t.type}: ${t.c}`);
    }

    // Show arch breakdown
    const archBreakdown = db
      .prepare(
        "SELECT COALESCE(_arch, 'both') as arch, COUNT(*) as c FROM schema_nodes GROUP BY _arch ORDER BY c DESC",
      )
      .all() as Array<{ arch: string; c: number }>;
    for (const a of archBreakdown) {
      console.log(`  arch=${a.arch}: ${a.c}`);
    }

    // Show completion stats
    const completionCount = (
      db.prepare("SELECT COUNT(*) as c FROM schema_nodes WHERE _attrs IS NOT NULL").get() as { c: number }
    ).c;
    console.log(`  nodes with _attrs (completion): ${completionCount}`);

    // -----------------------------------------------------------------------
    // Regenerate legacy `commands` table for backward compatibility
    // -----------------------------------------------------------------------
    db.run("DELETE FROM commands;");

    const insertCmd = db.prepare(`
      INSERT OR IGNORE INTO commands (path, name, type, parent_path, description, ros_version)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertCmds = db.transaction(() => {
      for (const node of mergedNodes) {
        insertCmd.run(node.path, node.name, node.type, node.parentPath, node.descRaw, version);
      }
    });
    insertCmds();

    const cmdCount = (db.prepare("SELECT COUNT(*) as c FROM commands").get() as { c: number }).c;
    console.log(`\nRegenerated ${cmdCount} commands (compat layer)`);
  }

  // Always populate schema_node_presence and command_versions for this version
  {
    // schema_node_presence
    db.run("DELETE FROM schema_node_presence WHERE version = ?", [version]);

    const insertPresence = db.prepare(`
      INSERT OR IGNORE INTO schema_node_presence (node_id, version)
      SELECT id, ? FROM schema_nodes WHERE path = ? AND type = ?
    `);

    const insertPresences = db.transaction(() => {
      // All merged nodes exist in this version
      for (const node of mergedNodes) {
        insertPresence.run(version, node.path, node.type);
      }
    });
    insertPresences();

    const presenceCount = (
      db.prepare("SELECT COUNT(*) as c FROM schema_node_presence WHERE version = ?").get(version) as { c: number }
    ).c;
    console.log(`Recorded ${presenceCount} schema_node_presence entries for ${version}`);
  }

  {
    // command_versions (compat)
    db.run("DELETE FROM command_versions WHERE ros_version = ?", [version]);

    const insertVersion = db.prepare(`
      INSERT OR IGNORE INTO command_versions (command_path, ros_version)
      VALUES (?, ?)
    `);

    const insertVersions = db.transaction(() => {
      for (const node of mergedNodes) {
        insertVersion.run(node.path, version);
      }
    });
    insertVersions();

    const versionCount = (
      db.prepare("SELECT COUNT(*) as c FROM command_versions WHERE ros_version = ?").get(version) as { c: number }
    ).c;
    console.log(`Recorded ${versionCount} command_versions entries for ${version}`);
  }

  const totalVersions = (
    db.prepare("SELECT COUNT(DISTINCT version) AS c FROM schema_node_presence").get() as { c: number }
  ).c;
  console.log(`Total versions tracked: ${totalVersions}`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const { db, initDb } = await import("./db.ts");
  const { loadJson } = await import("./restraml.ts");

  const cliArgs = process.argv.slice(2);
  const accumulate = cliArgs.includes("--accumulate");
  const extraPackages = cliArgs.includes("--extra");

  const flagArgs = Object.fromEntries(
    cliArgs
      .filter((a) => a.startsWith("--") && a.includes("="))
      .map((a) => {
        const [k, ...v] = a.slice(2).split("=");
        return [k, v.join("=")];
      }),
  );

  const x86Source = flagArgs.x86 ?? null;
  const arm64Source = flagArgs.arm64 ?? null;

  if (!x86Source && !arm64Source) {
    console.error("Error: at least one of --x86=<path> or --arm64=<path> is required");
    process.exit(1);
  }

  // Load both arch files
  const x86Data = x86Source ? await loadJson<Record<string, unknown>>(x86Source) : null;
  const arm64Data = arm64Source ? await loadJson<Record<string, unknown>>(arm64Source) : null;

  const x86Meta = x86Data?._meta as DeepInspectMeta | undefined;
  const arm64Meta = arm64Data?._meta as DeepInspectMeta | undefined;
  const meta = x86Meta ?? arm64Meta;

  // Derive version
  const version =
    flagArgs.version ??
    meta?.version ??
    (x86Source ? deriveVersion(x86Source) : arm64Source ? deriveVersion(arm64Source) : "unknown");
  const channel = flagArgs.channel ?? deriveChannel(version);

  console.log(`extract-schema: version=${version} channel=${channel} accumulate=${accumulate}`);
  if (x86Source) console.log(`  x86: ${x86Source}`);
  if (arm64Source) console.log(`  arm64: ${arm64Source}`);

  // Walk both trees
  const x86Nodes: FlatNode[] = [];
  const arm64Nodes: FlatNode[] = [];
  if (x86Data) walk(x86Data, "", x86Nodes);
  if (arm64Data) walk(arm64Data, "", arm64Nodes);
  console.log(`  x86 nodes: ${x86Nodes.length}, arm64 nodes: ${arm64Nodes.length}`);

  // Merge
  const mergedNodes = mergeArchNodes(x86Nodes, arm64Nodes);
  const shared = mergedNodes.filter((n) => n.arch === null).length;
  const x86Only = mergedNodes.filter((n) => n.arch === "x86").length;
  const arm64Only = mergedNodes.filter((n) => n.arch === "arm64").length;
  console.log(`  merged: ${mergedNodes.length} (shared=${shared}, x86-only=${x86Only}, arm64-only=${arm64Only})`);

  // Initialize DB and import
  initDb();

  importSchemaNodes(db, mergedNodes, version, {
    accumulate,
    extraPackages,
    channel,
    x86Source,
    arm64Source,
    x86Meta,
    arm64Meta,
  });
}
