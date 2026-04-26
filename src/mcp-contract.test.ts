/**
 * mcp-contract.test.ts — MCP tool surface contract tests (Phase 2).
 *
 * Guards against silent breaking changes to the MCP tool registry:
 * - Block A: Frozen 14-tool list + workflow-arrow (→) convention in descriptions
 * - Block B: Token-budget guardrails for 10 canonical queries (rough chars/4)
 * - Block C: Shape snapshots — fingerprint the *contract* (keys, counts,
 *           classifier output), NOT the corpus. Deliberately omits page IDs
 *           and titles so DB refreshes don't churn snapshots.
 *
 * These are fast, deterministic, CI-runnable structural tests. No LLM calls,
 * no network. Use the real local DB (ros-help.db) for stable FTS results.
 *
 * When adding/removing/renaming a tool: update EXPECTED_TOOLS below AND add
 * a CHANGELOG entry under [Unreleased] → Added/Changed/Removed. The test is
 * designed to force an explicit decision.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");

// Block A (static file parse) runs unconditionally. Blocks B and C need the
// real populated DB singleton. When another test file (extract-videos,
// query, etc.) has already pinned the db.ts singleton to :memory:, we skip
// the DB-dependent blocks — running `bun test src/mcp-contract.test.ts`
// alone exercises them, and CI's `bun test` still gets Block A coverage.
const { searchAll } = await import("./query.ts");
const { DB_PATH, getDbStats } = await import("./db.ts");

// getDbStats() throws if tables don't exist (clean checkout before any DB build).
// Guard defensively: any failure → treat as "DB not usable" and skip B/C.
function dbPagesOrZero(): number {
  try {
    return getDbStats().pages;
  } catch {
    return 0;
  }
}

const dbPages = dbPagesOrZero();
const dbIsReal = DB_PATH !== ":memory:" && dbPages > 100;
const skipReason = dbIsReal
  ? ""
  : `DB singleton is "${DB_PATH}" (pages=${dbPages}); run \`bun test src/mcp-contract.test.ts\` solo against a populated DB for Blocks B/C.`;

// ---------------------------------------------------------------------------
// Block A: Frozen tool registry
// ---------------------------------------------------------------------------

describe("Frozen tool registry", () => {
  const EXPECTED_TOOLS = [
    "routeros_search",
    "routeros_get_page",
    "routeros_lookup_property",
    "routeros_explain_command",
    "routeros_command_tree",
    "routeros_stats",
    "routeros_search_changelogs",
    "routeros_dude_search",
    "routeros_dude_get_page",
    "routeros_command_version_check",
    "routeros_command_diff",
    "routeros_device_lookup",
    "routeros_search_tests",
    "routeros_current_versions",
  ];

  test("exactly 14 tools registered", () => {
    const mcpSrc = readFileSync(path.join(ROOT, "src/mcp.ts"), "utf-8");
    // Extract tool names from server.registerTool("<name>", patterns
    const toolMatches = mcpSrc.matchAll(/server\.registerTool\(\s*["']([^"']+)["']/g);
    const foundTools = Array.from(toolMatches, (m) => m[1]);

    expect(foundTools.length).toBe(14);
    expect(foundTools.sort()).toEqual(EXPECTED_TOOLS.sort());
  });

  test("all tools have workflow arrow (→) in description", () => {
    const mcpSrc = readFileSync(path.join(ROOT, "src/mcp.ts"), "utf-8");

    // Extract each complete registerTool block (tool name to closing paren before next registerTool)
    // Split on registerTool calls, then extract name + description from each block
    const toolBlocks = mcpSrc.split(/(?=server\.registerTool\()/);

    const toolsWithoutArrow: string[] = [];

    for (const block of toolBlocks) {
      // Extract tool name
      const nameMatch = block.match(/server\.registerTool\(\s*["']([^"']+)["']/);
      if (!nameMatch) continue;

      const toolName = nameMatch[1];

      // Extract description (from `description:` to the closing `inputSchema:`)
      // This captures the full description including embedded backticks
      const descMatch = block.match(/description:\s*`([\s\S]*?)`\s*,\s*inputSchema:/);
      if (!descMatch) {
        // Some tools might not have inputSchema, try alternate pattern
        const altMatch = block.match(/description:\s*`([\s\S]*?)`\s*,?\s*\}/);
        if (!altMatch) continue;

        const description = altMatch[1];
        if (!description.includes("→")) {
          toolsWithoutArrow.push(toolName);
        }
        continue;
      }

      const description = descMatch[1];
      if (!description.includes("→")) {
        toolsWithoutArrow.push(toolName);
      }
    }

    if (toolsWithoutArrow.length > 0) {
      throw new Error(
        `Tools lacking workflow arrow (→) convention: ${toolsWithoutArrow.join(", ")}`,
      );
    }

    // Ensure we found tool descriptions (sanity check for regex)
    const totalFound = Array.from(
      mcpSrc.matchAll(/server\.registerTool\(\s*["']([^"']+)["']/g),
    ).length;
    expect(totalFound).toBe(14);
  });
});

// ---------------------------------------------------------------------------
// Block B: Token-budget guardrails
// ---------------------------------------------------------------------------

describe.skipIf(!dbIsReal)(`Token-budget guardrails${dbIsReal ? "" : ` [skipped: ${skipReason}]`}`, () => {
  /**
   * Rough token estimator: 1 token ≈ 4 chars for JSON.
   * This is a guardrail to catch 10x regressions, not precise billing.
   */
  function estimateTokens(obj: unknown): number {
    return Math.ceil(JSON.stringify(obj).length / 4);
  }

  const QUERIES: Array<{ query: string; limit: number; budget: number }> = [
    { query: "dhcp server", limit: 8, budget: 8000 },
    { query: "/ip/firewall/filter", limit: 8, budget: 8000 },
    { query: "bridge vlan", limit: 8, budget: 8000 },
    { query: "hAP ax3", limit: 8, budget: 6000 },
    { query: "what changed in 7.22.1", limit: 8, budget: 8000 },
    { query: "BGP", limit: 8, budget: 8000 },
    { query: "container setup", limit: 8, budget: 8000 },
    { query: "disabled property", limit: 8, budget: 6000 },
    { query: "CAPsMAN", limit: 20, budget: 16000 }, // hunger knob test
    { query: "firewall filter chain", limit: 8, budget: 8000 },
  ];

  for (const { query, limit, budget } of QUERIES) {
    test(`"${query}" (limit=${limit}) ≤ ${budget} tokens`, () => {
      const result = searchAll(query, limit);
      const tokens = estimateTokens(result);

      if (tokens > budget) {
        throw new Error(
          `Token budget exceeded: "${query}" | actual=${tokens} tokens | budget=${budget}`,
        );
      }

      // Log for the record (visible on test run)
      console.log(`  ✓ "${query}" (limit=${limit}): ${tokens} tokens`);
    });
  }
});

// ---------------------------------------------------------------------------
// Block C: Response-shape invariants
// ---------------------------------------------------------------------------
//
// This block asserts shape contracts that hold on any populated DB — no
// file-based snapshots (they coupled to the local dev DB's extraction state
// and drifted against the full CI-built DB's richer `related_buckets`). The
// invariants here protect against silent breakage of the searchAll return
// shape while staying portable across DBs of varying richness.
//
// Corpus-linked expectations ("this page must rank for this query") live in
// fixtures/eval/queries.json (Phase 0) — that's the right surface for them.

describe.skipIf(!dbIsReal)(`Response-shape invariants${dbIsReal ? "" : ` [skipped: ${skipReason}]`}`, () => {
  type Invariant = {
    query: string;
    limit: number;
    classifier_expected: Record<string, unknown>;
  };

  const INVARIANTS: Invariant[] = [
    { query: "dhcp server", limit: 8, classifier_expected: { topics: ["dhcp"] } },
    {
      query: "bridge vlan",
      limit: 8,
      classifier_expected: { command_path: "/bridge/vlan", topics: ["bridge", "vlan"] },
    },
    { query: "hAP ax3", limit: 8, classifier_expected: { device: "hAP" } },
    {
      query: "what changed in 7.22.1",
      limit: 8,
      classifier_expected: { version: "7.22.1" },
    },
    {
      query: "/ip/firewall/filter",
      limit: 8,
      classifier_expected: {
        command_path: "/ip/firewall/filter",
        topics: ["ip", "firewall", "filter"],
      },
    },
  ];

  for (const { query, limit, classifier_expected } of INVARIANTS) {
    test(`shape: "${query}"`, () => {
      const result = searchAll(query, limit);

      // Top-level keys
      expect(result).toHaveProperty("query", query);
      expect(result).toHaveProperty("classified");
      expect(result).toHaveProperty("pages");
      expect(result).toHaveProperty("related");
      expect(result).toHaveProperty("next_steps");
      expect(result).toHaveProperty("total_pages");

      // Classifier output is DB-independent (pure regex) — assert exact subset
      for (const [k, v] of Object.entries(classifier_expected)) {
        expect(result.classified).toHaveProperty(k, v);
      }

      // Pages: at least one hit on a populated DB, bounded by limit
      expect(Array.isArray(result.pages)).toBe(true);
      expect(result.pages.length).toBeGreaterThan(0);
      expect(result.pages.length).toBeLessThanOrEqual(limit);
      expect(result.total_pages).toBeGreaterThanOrEqual(result.pages.length);
      for (const page of result.pages) {
        expect(page).toHaveProperty("id");
        expect(page).toHaveProperty("title");
      }

      // Related block: always an object; buckets that are present are arrays
      expect(typeof result.related).toBe("object");
      for (const [bucket, entries] of Object.entries(result.related)) {
        if (Array.isArray(entries)) {
          expect(entries.length).toBeGreaterThan(0);
        } else {
          // command_node is a single object when present
          expect(entries).toBeTruthy();
        }
        expect(bucket.length).toBeGreaterThan(0);
      }

      // next_steps: array of hint strings
      expect(Array.isArray(result.next_steps)).toBe(true);
    });
  }
});
