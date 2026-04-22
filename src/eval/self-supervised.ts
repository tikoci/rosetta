/**
 * Phase 1 — Self-supervised retrieval evaluation runner.
 *
 * Auto-generates query→expected-page pairs from the live SQLite DB (section
 * headings, property names, command paths, page titles), then scores searchAll()
 * against them. No LLM cost, fully deterministic — a cheap "wide net" companion
 * to Phase 0's hand-curated golden set.
 *
 * Modes:
 *   bun run src/eval/self-supervised.ts
 *                                          → run + print report + compare to baseline
 *   bun run src/eval/self-supervised.ts --json
 *                                          → run + emit JSON report on stdout
 *   bun run src/eval/self-supervised.ts --update-baseline
 *                                          → run + overwrite fixtures/eval/self-supervised-baseline.json
 *   bun run src/eval/self-supervised.ts --filter <strategy>
 *                                          → only run one strategy (section|property|cmd-path|title)
 *   bun run src/eval/self-supervised.ts --limit <N>
 *                                          → cap total queries (for fast iteration)
 *   bun run src/eval/self-supervised.ts --top-misses <N>
 *                                          → print top N highest-rank-but-still-missed queries
 *
 * Exit codes:
 *   0  all metrics meet thresholds AND no regression vs baseline
 *   1  threshold or baseline regression
 *   2  runner error (DB missing, etc.)
 *
 * See BACKLOG.md "MCP Behavioral Testing — Phase 1" for design rationale.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Types ──────────────────────────────────────────────────────────────────

type Strategy = "section" | "property" | "cmd-path" | "title";

type QueryCase = {
  query: string;
  expected_page_id: number;
  source: Strategy;
};

type Thresholds = {
  title_hit_at_5: number;
  section_hit_at_10: number;
  property_hit_at_10: number;
  cmd_path_hit_at_5: number;
  overall_mrr: number;
};

const THRESHOLDS: Thresholds = {
  title_hit_at_5: 0.9,
  section_hit_at_10: 0.65,
  property_hit_at_10: 0.55,
  cmd_path_hit_at_5: 0.7,
  overall_mrr: 0.45,
};

type QueryResult = {
  query: string;
  expected_page_id: number;
  source: Strategy;
  hit_at_1: number;
  hit_at_5: number;
  hit_at_10: number;
  mrr: number;
  rank: number | null; // null if not found in top 10
  top_3_pages: { id: number; title: string }[];
};

type StrategyMetrics = {
  count: number;
  hit_at_1: number;
  hit_at_5: number;
  hit_at_10: number;
  mrr: number;
};

type Report = {
  generated_at: string;
  total_queries: number;
  per_strategy: Record<Strategy, StrategyMetrics>;
  overall: {
    hit_at_1: number;
    hit_at_5: number;
    hit_at_10: number;
    mrr: number;
  };
  results: QueryResult[];
};

// ── Seeded RNG for deterministic sampling ──────────────────────────────────

function splitmix32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ (t >>> 15);
    t = Math.imul(t, 0x735a2d97);
    t = t ^ (t >>> 15);
    return (t >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

// ── Query generation ───────────────────────────────────────────────────────

const GENERIC_HEADINGS = new Set([
  "Overview",
  "Example",
  "Examples",
  "Properties",
  "Notes",
  "Description",
  "Configuration",
  "Introduction",
  "Summary",
  "See also",
  "See Also",
  "Usage",
  "General",
  "Basic",
  "Advanced",
  "Settings",
]);

const GENERIC_PROPERTIES = new Set(["disabled", "comment", "name"]);

async function generateQueries(
  filter?: Strategy,
  limit?: number,
): Promise<QueryCase[]> {
  // Dynamic import to respect DB_PATH env var overrides (see extraction.instructions.md)
  const { db } = await import("../db.ts");

  const rng = splitmix32(0xc0ffee);
  const queries: QueryCase[] = [];

  const strategies: Strategy[] = filter
    ? [filter]
    : ["section", "property", "cmd-path", "title"];

  for (const strategy of strategies) {
    let cases: QueryCase[] = [];

    if (strategy === "section") {
      // Target ~80 queries from section headings
      const rows = db
        .prepare(
          `SELECT page_id, heading FROM sections
           WHERE level IN (2, 3) AND length(heading) BETWEEN 6 AND 60
           ORDER BY page_id`,
        )
        .all() as { page_id: number; heading: string }[];

      const filtered = rows.filter((r) => {
        const words = r.heading.trim().split(/\s+/);
        if (words.length <= 1) return false;
        if (GENERIC_HEADINGS.has(r.heading.trim())) return false;
        return true;
      });

      cases = shuffle(filtered, rng)
        .slice(0, limit ? Math.floor(limit / 4) : 80)
        .map((r) => ({
          query: r.heading,
          expected_page_id: r.page_id,
          source: "section" as Strategy,
        }));
    } else if (strategy === "property") {
      // Target ~60 queries from property names
      const rows = db
        .prepare(
          `SELECT DISTINCT page_id, name FROM properties
           WHERE length(name) >= 4
           ORDER BY name`,
        )
        .all() as { page_id: number; name: string }[];

      const filtered = rows.filter((r) => !GENERIC_PROPERTIES.has(r.name));

      cases = shuffle(filtered, rng)
        .slice(0, limit ? Math.floor(limit / 4) : 60)
        .map((r) => ({
          query: r.name.includes("-") ? r.name : `${r.name} property`,
          expected_page_id: r.page_id,
          source: "property" as Strategy,
        }));
    } else if (strategy === "cmd-path") {
      // Target ~30 queries from command paths (skip if table is small)
      const commandsCount = (
        db.prepare("SELECT COUNT(*) as c FROM commands").get() as { c: number }
      ).c;

      if (commandsCount >= 1000) {
        const rows = db
          .prepare(
            `SELECT page_id, path FROM commands
             WHERE page_id IS NOT NULL AND type = 'dir'
             ORDER BY RANDOM()
             LIMIT 30`,
          )
          .all() as { page_id: number; path: string }[];

        cases = rows.map((r) => ({
          query: r.path,
          expected_page_id: r.page_id,
          source: "cmd-path" as Strategy,
        }));
      }
    } else if (strategy === "title") {
      // Target ~30 queries from page titles (3-6 words)
      const rows = db
        .prepare(
          `SELECT id, title FROM pages
           ORDER BY id`,
        )
        .all() as { id: number; title: string }[];

      const filtered = rows.filter((r) => {
        const words = r.title.trim().split(/\s+/);
        return words.length >= 3 && words.length <= 6;
      });

      cases = shuffle(filtered, rng)
        .slice(0, limit ? Math.floor(limit / 4) : 30)
        .map((r) => ({
          query: r.title,
          expected_page_id: r.id,
          source: "title" as Strategy,
        }));
    }

    queries.push(...cases);
  }

  // Apply overall limit if specified
  if (limit && queries.length > limit) {
    return shuffle(queries, rng).slice(0, limit);
  }

  return queries;
}

// ── Evaluation ─────────────────────────────────────────────────────────────

async function evalQuery(q: QueryCase): Promise<QueryResult> {
  const { searchAll } = await import("../query.ts");

  const resp = searchAll(q.query, 10);
  const pageIds = resp.pages.map((p) => p.id);

  let rank: number | null = null;
  for (let i = 0; i < pageIds.length; i++) {
    if (pageIds[i] === q.expected_page_id) {
      rank = i + 1;
      break;
    }
  }

  const hit_at_1 = rank === 1 ? 1 : 0;
  const hit_at_5 = rank !== null && rank <= 5 ? 1 : 0;
  const hit_at_10 = rank !== null && rank <= 10 ? 1 : 0;
  const mrr = rank !== null ? 1 / rank : 0;

  return {
    query: q.query,
    expected_page_id: q.expected_page_id,
    source: q.source,
    hit_at_1,
    hit_at_5,
    hit_at_10,
    mrr,
    rank,
    top_3_pages: resp.pages.slice(0, 3).map((p) => ({ id: p.id, title: p.title })),
  };
}

function aggregate(results: QueryResult[]): Report {
  const perStrategy: Record<Strategy, StrategyMetrics> = {
    section: { count: 0, hit_at_1: 0, hit_at_5: 0, hit_at_10: 0, mrr: 0 },
    property: { count: 0, hit_at_1: 0, hit_at_5: 0, hit_at_10: 0, mrr: 0 },
    "cmd-path": { count: 0, hit_at_1: 0, hit_at_5: 0, hit_at_10: 0, mrr: 0 },
    title: { count: 0, hit_at_1: 0, hit_at_5: 0, hit_at_10: 0, mrr: 0 },
  };

  for (const r of results) {
    const s = perStrategy[r.source];
    s.count += 1;
    s.hit_at_1 += r.hit_at_1;
    s.hit_at_5 += r.hit_at_5;
    s.hit_at_10 += r.hit_at_10;
    s.mrr += r.mrr;
  }

  for (const s of Object.values(perStrategy)) {
    if (s.count > 0) {
      s.hit_at_1 /= s.count;
      s.hit_at_5 /= s.count;
      s.hit_at_10 /= s.count;
      s.mrr /= s.count;
    }
  }

  const total = results.length;
  const overall = {
    hit_at_1: total > 0 ? results.reduce((a, r) => a + r.hit_at_1, 0) / total : 0,
    hit_at_5: total > 0 ? results.reduce((a, r) => a + r.hit_at_5, 0) / total : 0,
    hit_at_10: total > 0 ? results.reduce((a, r) => a + r.hit_at_10, 0) / total : 0,
    mrr: total > 0 ? results.reduce((a, r) => a + r.mrr, 0) / total : 0,
  };

  return {
    generated_at: new Date().toISOString(),
    total_queries: total,
    per_strategy: perStrategy,
    overall,
    results,
  };
}

// ── Reporting ──────────────────────────────────────────────────────────────

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function printReport(
  report: Report,
  baseline: Report | null,
  topMisses: number,
): void {
  console.log(
    `\n📊 Rosetta self-supervised eval — ${report.total_queries} queries`,
  );
  console.log(`   generated_at: ${report.generated_at}\n`);

  console.log("  Overall metrics:");
  const overallRows: { label: string; value: number; threshold?: number }[] = [
    { label: "Hit@1", value: report.overall.hit_at_1 },
    { label: "Hit@5", value: report.overall.hit_at_5 },
    { label: "Hit@10", value: report.overall.hit_at_10 },
    { label: "MRR", value: report.overall.mrr, threshold: THRESHOLDS.overall_mrr },
  ];

  for (const row of overallRows) {
    const ok =
      row.threshold === undefined ? "  " : row.value >= row.threshold ? "✅" : "❌";
    const thresh = row.threshold === undefined ? "" : `  (≥ ${fmtPct(row.threshold)})`;
    let delta = "";
    if (baseline) {
      const map: Record<string, number> = {
        "Hit@1": baseline.overall.hit_at_1,
        "Hit@5": baseline.overall.hit_at_5,
        "Hit@10": baseline.overall.hit_at_10,
        MRR: baseline.overall.mrr,
      };
      const b = map[row.label];
      if (typeof b === "number") {
        const d = row.value - b;
        if (Math.abs(d) >= 0.001) {
          delta = `  Δ ${d > 0 ? "+" : ""}${(d * 100).toFixed(1)}pp`;
        }
      }
    }
    console.log(
      `  ${ok}  ${row.label.padEnd(24)} ${fmtPct(row.value).padStart(7)}${thresh}${delta}`,
    );
  }

  console.log("\n  Per strategy:");
  const strategies: Strategy[] = ["title", "section", "property", "cmd-path"];
  for (const strategy of strategies) {
    const s = report.per_strategy[strategy];
    if (s.count === 0) continue;

    let thresh = "";
    let ok = "  ";
    if (strategy === "title") {
      ok = s.hit_at_5 >= THRESHOLDS.title_hit_at_5 ? "✅" : "❌";
      thresh = `  (hit@5 ≥ ${fmtPct(THRESHOLDS.title_hit_at_5)})`;
    } else if (strategy === "section") {
      ok = s.hit_at_10 >= THRESHOLDS.section_hit_at_10 ? "✅" : "❌";
      thresh = `  (hit@10 ≥ ${fmtPct(THRESHOLDS.section_hit_at_10)})`;
    } else if (strategy === "property") {
      ok = s.hit_at_10 >= THRESHOLDS.property_hit_at_10 ? "✅" : "❌";
      thresh = `  (hit@10 ≥ ${fmtPct(THRESHOLDS.property_hit_at_10)})`;
    } else if (strategy === "cmd-path") {
      ok = s.hit_at_5 >= THRESHOLDS.cmd_path_hit_at_5 ? "✅" : "❌";
      thresh = `  (hit@5 ≥ ${fmtPct(THRESHOLDS.cmd_path_hit_at_5)})`;
    }

    console.log(`  ${ok}  ${strategy.padEnd(12)}  n=${String(s.count).padStart(3)}  hit@1=${fmtPct(s.hit_at_1).padStart(7)}  hit@5=${fmtPct(s.hit_at_5).padStart(7)}  hit@10=${fmtPct(s.hit_at_10).padStart(7)}  mrr=${fmtPct(s.mrr).padStart(7)}${thresh}`);
  }

  // Top misses — highest-rank-but-still-missed queries
  if (topMisses > 0) {
    const misses = report.results
      .filter((r) => r.rank === null || r.rank > 10)
      .slice(0, topMisses);

    if (misses.length > 0) {
      console.log(`\n  🔍 Top ${topMisses} misses (expected page not in top 10):`);
      for (const m of misses) {
        console.log(`    [${m.source}] "${m.query}" (expected page_id=${m.expected_page_id})`);
        console.log(`        top-3: ${m.top_3_pages.map((p) => `#${p.id} ${p.title}`).join(" | ")}`);
      }
    }
  }
}

// ── Threshold + baseline gating ────────────────────────────────────────────

function checkThresholds(report: Report, filter?: Strategy): string[] {
  const fails: string[] = [];

  // Skip overall threshold checks when filtering by strategy
  if (!filter) {
    if (report.overall.mrr < THRESHOLDS.overall_mrr) {
      fails.push(
        `overall mrr ${fmtPct(report.overall.mrr)} < ${fmtPct(THRESHOLDS.overall_mrr)}`,
      );
    }
  }

  // Per-strategy thresholds
  const title = report.per_strategy.title;
  if (title.count > 0 && title.hit_at_5 < THRESHOLDS.title_hit_at_5) {
    fails.push(
      `title hit@5 ${fmtPct(title.hit_at_5)} < ${fmtPct(THRESHOLDS.title_hit_at_5)}`,
    );
  }

  const section = report.per_strategy.section;
  if (section.count > 0 && section.hit_at_10 < THRESHOLDS.section_hit_at_10) {
    fails.push(
      `section hit@10 ${fmtPct(section.hit_at_10)} < ${fmtPct(THRESHOLDS.section_hit_at_10)}`,
    );
  }

  const property = report.per_strategy.property;
  if (property.count > 0 && property.hit_at_10 < THRESHOLDS.property_hit_at_10) {
    fails.push(
      `property hit@10 ${fmtPct(property.hit_at_10)} < ${fmtPct(THRESHOLDS.property_hit_at_10)}`,
    );
  }

  const cmdPath = report.per_strategy["cmd-path"];
  if (cmdPath.count > 0 && cmdPath.hit_at_5 < THRESHOLDS.cmd_path_hit_at_5) {
    fails.push(
      `cmd-path hit@5 ${fmtPct(cmdPath.hit_at_5)} < ${fmtPct(THRESHOLDS.cmd_path_hit_at_5)}`,
    );
  }

  return fails;
}

function checkRegression(curr: Report, base: Report, tolerance = 0.05): string[] {
  // Tolerance = 5pp; auto-gen queries are noisier than golden set.
  const fails: string[] = [];

  // Overall metrics
  const keys: (keyof Report["overall"])[] = ["hit_at_1", "hit_at_5", "hit_at_10", "mrr"];
  for (const k of keys) {
    const d = curr.overall[k] - base.overall[k];
    if (d < -tolerance) {
      fails.push(
        `overall ${k} regressed ${(d * 100).toFixed(1)}pp (was ${fmtPct(base.overall[k])}, now ${fmtPct(curr.overall[k])})`,
      );
    }
  }

  // Per-strategy hit@10 (most lenient metric)
  const strategies: Strategy[] = ["title", "section", "property", "cmd-path"];
  for (const strategy of strategies) {
    const currS = curr.per_strategy[strategy];
    const baseS = base.per_strategy[strategy];
    if (currS.count > 0 && baseS.count > 0) {
      const d = currS.hit_at_10 - baseS.hit_at_10;
      if (d < -tolerance) {
        fails.push(
          `${strategy} hit@10 regressed ${(d * 100).toFixed(1)}pp (was ${fmtPct(baseS.hit_at_10)}, now ${fmtPct(currS.hit_at_10)})`,
        );
      }
    }
  }

  return fails;
}

// ── Main ───────────────────────────────────────────────────────────────────

const BASELINE_PATH = join(
  import.meta.dir,
  "../../fixtures/eval/self-supervised-baseline.json",
);

async function runEval(
  filter?: Strategy,
  limit?: number,
): Promise<Report> {
  const queries = await generateQueries(filter, limit);
  const results: QueryResult[] = [];

  for (const q of queries) {
    results.push(await evalQuery(q));
  }

  return aggregate(results);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const wantJson = args.includes("--json");
  const wantUpdate = args.includes("--update-baseline");
  const filterIdx = args.indexOf("--filter");
  const filter = filterIdx >= 0 ? (args[filterIdx + 1] as Strategy) : undefined;
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number.parseInt(args[limitIdx + 1] as string, 10) : undefined;
  const topMissesIdx = args.indexOf("--top-misses");
  const topMisses =
    topMissesIdx >= 0 ? Number.parseInt(args[topMissesIdx + 1] as string, 10) : 10;

  try {
    const report = await runEval(filter, limit);

    if (wantJson) {
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    }

    const baseline: Report | null = existsSync(BASELINE_PATH)
      ? (JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as Report)
      : null;

    printReport(report, baseline, topMisses);

    if (wantUpdate) {
      writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`);
      console.log(`\n  💾 baseline updated → ${BASELINE_PATH}`);
      process.exit(0);
    }

    // Gate: thresholds + regression
    const thresholdFails = filter ? [] : checkThresholds(report, filter);
    const regressionFails =
      baseline && !filter ? checkRegression(report, baseline) : [];

    if (thresholdFails.length > 0 || regressionFails.length > 0) {
      console.log("\n  ❌ FAIL");
      for (const f of thresholdFails) console.log(`     threshold: ${f}`);
      for (const f of regressionFails) console.log(`     regression: ${f}`);
      console.log("\n  Run with --update-baseline if this is intentional.\n");
      process.exit(1);
    }

    console.log("\n  ✅ all checks passed\n");
    process.exit(0);
  } catch (err) {
    console.error(`[eval] runner error: ${err}`);
    process.exit(2);
  }
}
