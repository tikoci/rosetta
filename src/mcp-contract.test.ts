/**
 * mcp-contract.test.ts — MCP tool surface contract tests (Phase 2).
 *
 * Guards against silent breaking changes to the MCP tool registry:
 * - Block A: Frozen 14-tool list + workflow-arrow (→) convention in descriptions
 * - Block B: Token-budget guardrails for 10 canonical queries (rough chars/4)
 * - Block C: Shape snapshots — fingerprint the *contract* (keys, counts,
 *           classifier output), NOT the corpus. Deliberately omits page IDs
 *           and titles so DB refreshes don't churn snapshots.
 * - Block D: explain_command grounding budget — over a fixed set of everyday
 *           commands, unknown-arg, no-description, and manual answers that
 *           sit below `high` beside an exact CLI-Reference row each stay under
 *           a ceiling (#169, B-0025).
 *
 * These are fast, deterministic, CI-runnable structural tests. No LLM calls,
 * no network. Block A always runs; set ROSETTA_REAL_DB_TESTS=1 to exercise
 * Blocks B/C against a real populated DB for stable FTS results.
 *
 * When adding/removing/renaming a tool: update EXPECTED_TOOLS below AND add
 * a CHANGELOG entry under [Unreleased] → Added/Changed/Removed. The test is
 * designed to force an explicit decision.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const runRealDbBlocks = process.env.ROSETTA_REAL_DB_TESTS === "1";

// Block A (static file parse) runs unconditionally. Blocks B and C need the
// real populated DB singleton, but opening db.ts during the main `bun test`
// suite can poison query.test.ts's DB-wipe guard. Keep the real-DB imports
// behind an explicit opt-in so the shared suite stays on `:memory:` and the
// dedicated release/real-DB runs can still exercise Blocks B/C.
let searchAll: typeof import("./query.ts").searchAll | undefined;
let explainCommand: typeof import("./query.ts").explainCommand | undefined;
let realDb: typeof import("./db.ts").db | undefined;
let realDbPath = ":memory:";
let dbPages = 0;

if (runRealDbBlocks) {
  const queryModule = await import("./query.ts");
  const dbModule = await import("./db.ts");
  searchAll = queryModule.searchAll;
  explainCommand = queryModule.explainCommand;
  realDb = dbModule.db;
  realDbPath = dbModule.DB_PATH;
  try {
    dbPages = dbModule.getDbStats().pages;
  } catch {
    dbPages = 0;
  }
}

function requireSearchAll(): typeof import("./query.ts").searchAll {
  if (!searchAll) {
    throw new Error(
      "searchAll unavailable; set ROSETTA_REAL_DB_TESTS=1 to enable real-DB contract blocks.",
    );
  }
  return searchAll;
}

const dbIsReal = runRealDbBlocks && realDbPath !== ":memory:" && dbPages > 100;
const skipReason = dbIsReal
  ? ""
  : runRealDbBlocks
    ? `DB singleton is "${realDbPath}" (pages=${dbPages}); run \`ROSETTA_REAL_DB_TESTS=1 bun test src/mcp-contract.test.ts\` against a populated DB for Blocks B/C.`
    : "real-DB blocks are opt-in; set ROSETTA_REAL_DB_TESTS=1 and run this file against a populated DB for Blocks B/C.";

// ---------------------------------------------------------------------------
// Block A: Frozen tool registry
// ---------------------------------------------------------------------------

export const EXPECTED_TOOLS = [
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
] as const;

describe("Frozen tool registry", () => {

  test("exactly 14 tools registered", () => {
    const mcpSrc = readFileSync(path.join(ROOT, "src/mcp.ts"), "utf-8");
    // Extract tool names from server.registerTool("<name>", patterns
    const toolMatches = mcpSrc.matchAll(/server\.registerTool\(\s*["']([^"']+)["']/g);
    const foundTools = Array.from(toolMatches, (m) => m[1]);

    expect(foundTools.length).toBe(14);
    expect(foundTools.sort()).toEqual([...EXPECTED_TOOLS].sort());
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
      const result = requireSearchAll()(query, limit);
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
      const result = requireSearchAll()(query, limit);

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

// ---------------------------------------------------------------------------
// Block D: explain_command grounding budget (#169)
// ---------------------------------------------------------------------------
//
// MikroTik keeps moving property tables out of manual pages into the CLI Reference. When a move
// outruns the lookup, `unknown-arg` warnings jump across everyday commands (0.11.3-next.113
// shipped 49 of 70 before the CLI-Reference fallback; 0.11.2 had 7). This block turns that into a
// number QA fails on, instead of something an agent notices in its output. The set is fixed —
// change it deliberately, and re-measure the budgets when you do.
//
// `unknown-arg` alone cannot see two other failure shapes (B-0025): an annotation with no
// description (`no-description`), and a manual row below `high` answering for a menu whose own
// CLI-Reference row exists — the class that described `/ip/firewall/filter chain` as "Bridge
// firewall chain". Each gets its own number.

describe.skipIf(!dbIsReal)(`explain_command grounding budget${dbIsReal ? "" : ` [skipped: ${skipReason}]`}`, () => {
  const COMMANDS = [
    "/ip firewall nat add chain=srcnat action=masquerade out-interface=ether1",
    "/ip firewall filter add chain=input action=drop connection-state=invalid",
    "/ip firewall address-list add list=blocked address=192.0.2.4",
    "/ip address add address=10.0.0.1/24 interface=bridge",
    "/ip route add dst-address=0.0.0.0/0 gateway=10.0.0.254 distance=1",
    "/ip dhcp-server add name=dhcp1 interface=bridge address-pool=pool1 lease-time=1h",
    "/ip dhcp-server network add address=10.0.0.0/24 gateway=10.0.0.1 dns-server=10.0.0.1",
    "/ip dhcp-client add interface=ether1 add-default-route=yes use-peer-dns=yes",
    "/ip pool add name=pool1 ranges=10.0.0.10-10.0.0.200",
    "/ip dns set servers=1.1.1.1 allow-remote-requests=yes",
    "/ip dns static add name=router.lan address=10.0.0.1",
    "/ip service set telnet disabled=yes",
    "/ip proxy set enabled=yes port=8080",
    "/system note set show-at-login=yes note=x",
    "/system scheduler add name=s1 interval=1h on-event=foo",
    "/system ntp client set enabled=yes servers=pool.ntp.org",
    "/system identity set name=r1",
    "/system clock set time-zone-name=Europe/Riga",
    "/system logging add topics=dhcp action=memory",
    "/user add name=bob group=read password=x",
    "/user group add name=ops policy=read,write",
    "/interface bridge add name=bridge vlan-filtering=yes",
    "/interface bridge port add bridge=bridge interface=ether2 pvid=10",
    "/interface bridge vlan add bridge=bridge tagged=bridge vlan-ids=10",
    "/interface vlan add name=vlan10 interface=bridge vlan-id=10",
    "/interface list member add list=LAN interface=bridge",
    "/interface wireguard add name=wg0 listen-port=13231",
    "/interface wireguard peers add interface=wg0 public-key=abc allowed-address=10.9.0.2/32",
    "/tool fetch url=https://example.com/x output=file",
    "/tool sniffer set filter-interface=ether1 file-name=cap",
  ];
  // 70 args, measured on v0.11.3-next.114 with B-0025's ordering:
  // - unknown-arg 1 (`/ip service` `disabled` is a print flag in the CLI Reference, not an
  //   argument). 7 is where 0.11.2 stood.
  // - no-description 4 (`/ip/address address`, `/ip/route` dst-address/gateway/distance:
  //   blank in the CLI Reference, never tabled in the manual). Budget leaves room for 2 more.
  // - manual below high beside an exact CLI-Reference row: 0 (was 2 before B-0025 — the bridge
  //   firewall rows answering `/ip/firewall/filter`). Budget 1, so that pair coming back fails.
  const BUDGETS = { "unknown-arg": 7, "no-description": 6, "manual-below-high": 1 } as const;

  type Tally = Record<keyof typeof BUDGETS, string[]>;
  function tally(): { args: number; misses: Tally } {
    if (!explainCommand || !realDb) throw new Error("explainCommand unavailable; set ROSETTA_REAL_DB_TESTS=1.");
    const exactOverlay = realDb.prepare(
      `SELECT 1 FROM cliref_fields f JOIN cliref_entries e ON e.id = f.entry_id
       WHERE e.source_path = ? AND f.name = ? COLLATE NOCASE AND f.field_kind = 'Argument' LIMIT 1`,
    );
    let args = 0;
    const misses: Tally = { "unknown-arg": [], "no-description": [], "manual-below-high": [] };
    for (const command of COMMANDS) {
      const result = explainCommand(command);
      const path = result.canonical?.path ?? "?";
      args += result.args.length;
      for (const w of result.warnings) {
        if (w.kind === "unknown-arg" || w.kind === "no-description") misses[w.kind].push(`${path} ${w.arg}`);
      }
      // explainCommand resolves both the menu and the command's own entry (`tool/fetch`).
      const sourcePaths = [path, `${path}/${result.canonical?.verb ?? ""}`].map((p) => p.replace(/^\/+/, ""));
      for (const arg of result.args) {
        const p = arg.property;
        if (p?.source === "manual" && p.confidence !== "high" && sourcePaths.some((sp) => exactOverlay.get(sp, arg.name))) {
          misses["manual-below-high"].push(`${path} ${arg.name} @ ${p.page_title}`);
        }
      }
    }
    return { args, misses };
  }
  const { args, misses } = dbIsReal ? tally() : { args: 0, misses: {} as Tally };

  test(`fixed set is ${COMMANDS.length} commands / 70 args`, () => {
    expect(args).toBe(70);
  });

  for (const [kind, budget] of Object.entries(BUDGETS) as Array<[keyof typeof BUDGETS, number]>) {
    test(`${kind} ≤ ${budget} of 70 args`, () => {
      const hits = misses[kind];
      console.log(`  ${kind}: ${hits.length}/${args}${hits.length ? ` — ${hits.join(", ")}` : ""}`);
      expect(hits.length).toBeLessThanOrEqual(budget);
    });
  }
});
