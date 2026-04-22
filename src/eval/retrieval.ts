/**
 * Phase 0 — Golden-query retrieval evaluation runner.
 *
 * Loads fixtures/eval/queries.json, calls searchAll() for each query, and
 * computes classical IR metrics (recall@k, MRR) plus classifier-detection
 * accuracy. No LLM call anywhere — this is fully deterministic and runs
 * against the committed ros-help.db in seconds.
 *
 * Modes:
 *   bun run src/eval/retrieval.ts            → run + print report + compare to baseline
 *   bun run src/eval/retrieval.ts --json     → run + emit JSON report on stdout
 *   bun run src/eval/retrieval.ts --update-baseline
 *                                           → run + overwrite fixtures/eval/baseline.json
 *   bun run src/eval/retrieval.ts --filter <id-prefix>
 *                                           → only run queries whose id starts with prefix
 *
 * Exit codes:
 *   0  all metrics meet thresholds AND no regression vs baseline
 *   1  threshold or baseline regression
 *   2  runner error (bad fixture, DB missing, etc.)
 *
 * See BACKLOG.md "MCP Behavioral Testing — Phase 0" for design rationale.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { searchAll } from "../query.ts";

// ── Types ──────────────────────────────────────────────────────────────────

type Shape =
  | "nl-question"
  | "command-path"
  | "version-question"
  | "device"
  | "topic-multi"
  | "ambiguous";

type ExpectedClassified = {
  command_path?: string;
  version?: string;
  device?: string;
  property?: string;
};

type MatchMode = "any" | "all";

type GoldenQuery = {
  id: string;
  query: string;
  shape: Shape;
  expected_pages?: number[];
  /** "any" (default): top-k contains ≥1 expected page → recall=1. "all": classical subset recall. */
  match_mode?: MatchMode;
  expected_classified?: ExpectedClassified;
  expected_topics_any?: string[];
  expected_related?: string[];
  /** Skip this entire query's checks unless DB has at least this many commands. Lets us keep
   * command-tree-dependent checks in the golden set without false-failing on slim dev DBs. */
  requires_commands_min?: number;
  notes?: string;
};

type Thresholds = {
  recall_at_5: number;
  recall_at_3: number;
  mrr: number;
  classifier_accuracy: number;
};

type GoldenSet = {
  _thresholds: Thresholds;
  queries: GoldenQuery[];
};

type QueryResult = {
  id: string;
  query: string;
  shape: Shape;
  recall_at_5: number;
  recall_at_3: number;
  reciprocal_rank: number;
  classifier_ok: boolean;
  related_ok: boolean;
  topics_ok: boolean;
  skipped: boolean;
  skip_reason?: string;
  top_pages: { id: number; title: string }[];
  classified_actual: Record<string, unknown>;
  notes: string[];
};

type Report = {
  generated_at: string;
  total_queries: number;
  metrics: {
    recall_at_5: number;
    recall_at_3: number;
    mrr: number;
    classifier_accuracy: number;
    related_block_accuracy: number;
    topics_accuracy: number;
  };
  per_shape: Record<string, { count: number; recall_at_5: number; mrr: number }>;
  results: QueryResult[];
};

// ── Loaders ────────────────────────────────────────────────────────────────

const FIXTURE_PATH = join(import.meta.dir, "../../fixtures/eval/queries.json");
const BASELINE_PATH = join(import.meta.dir, "../../fixtures/eval/baseline.json");

function loadGoldenSet(): GoldenSet {
  if (!existsSync(FIXTURE_PATH)) {
    console.error(`[eval] golden set not found at ${FIXTURE_PATH}`);
    process.exit(2);
  }
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  const parsed = JSON.parse(raw) as GoldenSet & { _doc?: string };
  if (!parsed.queries || !Array.isArray(parsed.queries)) {
    console.error("[eval] fixture missing 'queries' array");
    process.exit(2);
  }
  return parsed;
}

// ── Per-query evaluation ───────────────────────────────────────────────────

function evalQuery(q: GoldenQuery, commandsCount: number, k = 5): QueryResult {
  const empty: QueryResult = {
    id: q.id,
    query: q.query,
    shape: q.shape,
    recall_at_5: 1,
    recall_at_3: 1,
    reciprocal_rank: 1,
    classifier_ok: true,
    related_ok: true,
    topics_ok: true,
    skipped: false,
    top_pages: [],
    classified_actual: {},
    notes: [],
  };

  if (q.requires_commands_min && commandsCount < q.requires_commands_min) {
    return {
      ...empty,
      skipped: true,
      skip_reason: `requires commands ≥ ${q.requires_commands_min}, DB has ${commandsCount}`,
    };
  }

  const resp = searchAll(q.query, k * 2);
  const topIds = resp.pages.slice(0, k).map((p) => p.id);
  const top3Ids = resp.pages.slice(0, 3).map((p) => p.id);

  // Recall semantics — default "any" (≥1 expected page in top-k counts as full recall).
  // For QA-style retrieval we usually only need ONE good answer; classical subset recall
  // ("all" mode) is opt-in for cases where coverage actually matters.
  const expected = q.expected_pages ?? [];
  const mode: MatchMode = q.match_mode ?? "any";
  const recallFor = (ids: number[]): number => {
    if (expected.length === 0) return 1;
    if (mode === "any") {
      return expected.some((id) => ids.includes(id)) ? 1 : 0;
    }
    // "all" mode: classical subset recall
    return expected.filter((id) => ids.includes(id)).length / expected.length;
  };
  const recall_at_5 = recallFor(topIds);
  const recall_at_3 = recallFor(top3Ids);

  // Reciprocal rank: 1/rank of first expected page in top-k. 0 if none found.
  let rr = 0;
  if (expected.length > 0) {
    for (let i = 0; i < topIds.length; i++) {
      if (expected.includes(topIds[i] as number)) {
        rr = 1 / (i + 1);
        break;
      }
    }
  } else {
    rr = 1; // N/A — don't penalize MRR
  }

  // Classifier check: every key in expected_classified must match exactly.
  const notes: string[] = [];
  let classifier_ok = true;
  if (q.expected_classified) {
    for (const [key, want] of Object.entries(q.expected_classified)) {
      const got = (resp.classified as Record<string, unknown>)[key];
      if (got !== want) {
        classifier_ok = false;
        notes.push(`classifier.${key}: want=${JSON.stringify(want)} got=${JSON.stringify(got)}`);
      }
    }
  }

  // Related-block check: each name in expected_related must appear in resp.related.
  let related_ok = true;
  if (q.expected_related && q.expected_related.length > 0) {
    for (const key of q.expected_related) {
      if (!(key in resp.related) || resp.related[key as keyof typeof resp.related] == null) {
        related_ok = false;
        notes.push(`related.${key}: missing`);
      }
    }
  }

  // Topics check: at least one expected topic must appear in classified.topics.
  let topics_ok = true;
  if (q.expected_topics_any && q.expected_topics_any.length > 0) {
    const got = resp.classified.topics ?? [];
    const hit = q.expected_topics_any.some((t) => got.includes(t));
    if (!hit) {
      topics_ok = false;
      notes.push(`topics: want any of ${JSON.stringify(q.expected_topics_any)} got=${JSON.stringify(got)}`);
    }
  }

  if (expected.length > 0 && recall_at_5 === 0) {
    notes.push(`top-${k} pages: ${topIds.join(", ")} (none of expected ${expected.join(", ")})`);
  }

  return {
    id: q.id,
    query: q.query,
    shape: q.shape,
    recall_at_5,
    recall_at_3,
    reciprocal_rank: rr,
    classifier_ok,
    related_ok,
    topics_ok,
    skipped: false,
    top_pages: resp.pages.slice(0, 5).map((p) => ({ id: p.id, title: p.title })),
    classified_actual: { ...resp.classified },
    notes,
  };
}

// ── Aggregation ────────────────────────────────────────────────────────────

function aggregate(results: QueryResult[]): Report["metrics"] {
  const active = results.filter((r) => !r.skipped);
  const n = active.length;
  if (n === 0) {
    return {
      recall_at_5: 0,
      recall_at_3: 0,
      mrr: 0,
      classifier_accuracy: 0,
      related_block_accuracy: 0,
      topics_accuracy: 0,
    };
  }
  const sum = (f: (r: QueryResult) => number) => active.reduce((a, r) => a + f(r), 0);
  return {
    recall_at_5: sum((r) => r.recall_at_5) / n,
    recall_at_3: sum((r) => r.recall_at_3) / n,
    mrr: sum((r) => r.reciprocal_rank) / n,
    classifier_accuracy: sum((r) => (r.classifier_ok ? 1 : 0)) / n,
    related_block_accuracy: sum((r) => (r.related_ok ? 1 : 0)) / n,
    topics_accuracy: sum((r) => (r.topics_ok ? 1 : 0)) / n,
  };
}

function perShape(results: QueryResult[]): Report["per_shape"] {
  const out: Report["per_shape"] = {};
  for (const r of results) {
    if (r.skipped) continue;
    if (!out[r.shape]) {
      out[r.shape] = { count: 0, recall_at_5: 0, mrr: 0 };
    }
    const bucket = out[r.shape];
    bucket.count += 1;
    bucket.recall_at_5 += r.recall_at_5;
    bucket.mrr += r.reciprocal_rank;
  }
  for (const k of Object.keys(out)) {
    const b = out[k];
    if (!b) continue;
    b.recall_at_5 = b.recall_at_5 / b.count;
    b.mrr = b.mrr / b.count;
  }
  return out;
}

// ── Reporting ──────────────────────────────────────────────────────────────

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function printReport(report: Report, thresholds: Thresholds, baseline: Report | null): void {
  const m = report.metrics;
  console.log(`\n📊 Rosetta retrieval eval — ${report.total_queries} queries`);
  console.log(`   generated_at: ${report.generated_at}\n`);

  const rows: { label: string; value: number; threshold?: number }[] = [
    { label: "Recall@5", value: m.recall_at_5, threshold: thresholds.recall_at_5 },
    { label: "Recall@3", value: m.recall_at_3, threshold: thresholds.recall_at_3 },
    { label: "MRR", value: m.mrr, threshold: thresholds.mrr },
    {
      label: "Classifier accuracy",
      value: m.classifier_accuracy,
      threshold: thresholds.classifier_accuracy,
    },
    { label: "Related-block accuracy", value: m.related_block_accuracy },
    { label: "Topics accuracy", value: m.topics_accuracy },
  ];

  for (const row of rows) {
    const ok =
      row.threshold === undefined ? "  " : row.value >= row.threshold ? "✅" : "❌";
    const thresh = row.threshold === undefined ? "" : `  (≥ ${fmtPct(row.threshold)})`;
    let delta = "";
    if (baseline) {
      const prev = (baseline.metrics as Record<string, number>)[
        row.label.toLowerCase().replace(/[^a-z0-9]+/g, "_")
      ];
      // Map labels to baseline keys
      const map: Record<string, number> = {
        "Recall@5": baseline.metrics.recall_at_5,
        "Recall@3": baseline.metrics.recall_at_3,
        MRR: baseline.metrics.mrr,
        "Classifier accuracy": baseline.metrics.classifier_accuracy,
        "Related-block accuracy": baseline.metrics.related_block_accuracy,
        "Topics accuracy": baseline.metrics.topics_accuracy,
      };
      const b = map[row.label] ?? prev;
      if (typeof b === "number") {
        const d = row.value - b;
        if (Math.abs(d) >= 0.001) {
          delta = `  Δ ${d > 0 ? "+" : ""}${(d * 100).toFixed(1)}pp`;
        }
      }
    }
    console.log(`  ${ok}  ${row.label.padEnd(24)} ${fmtPct(row.value).padStart(7)}${thresh}${delta}`);
  }

  console.log("\n  Per shape:");
  for (const [shape, b] of Object.entries(report.per_shape)) {
    console.log(
      `    ${shape.padEnd(20)} n=${String(b.count).padStart(2)}  recall@5=${fmtPct(b.recall_at_5).padStart(7)}  mrr=${fmtPct(b.mrr).padStart(7)}`,
    );
  }

  // Skipped + failure detail
  const skipped = report.results.filter((r) => r.skipped);
  if (skipped.length > 0) {
    console.log(`\n  ⏭  ${skipped.length} queries skipped (env doesn't support):`);
    for (const s of skipped) console.log(`    [${s.id}] ${s.skip_reason}`);
  }

  const failures = report.results.filter(
    (r) =>
      !r.skipped &&
      (r.recall_at_5 < 1 || !r.classifier_ok || !r.related_ok || !r.topics_ok),
  );
  if (failures.length > 0) {
    console.log(`\n  ⚠️  ${failures.length} queries with issues:`);
    for (const f of failures) {
      console.log(`    [${f.id}] "${f.query}"`);
      for (const note of f.notes) console.log(`        ${note}`);
    }
  }
}

// ── Threshold + baseline gating ────────────────────────────────────────────

function checkThresholds(metrics: Report["metrics"], t: Thresholds): string[] {
  const fails: string[] = [];
  if (metrics.recall_at_5 < t.recall_at_5)
    fails.push(`recall@5 ${fmtPct(metrics.recall_at_5)} < ${fmtPct(t.recall_at_5)}`);
  if (metrics.recall_at_3 < t.recall_at_3)
    fails.push(`recall@3 ${fmtPct(metrics.recall_at_3)} < ${fmtPct(t.recall_at_3)}`);
  if (metrics.mrr < t.mrr) fails.push(`mrr ${fmtPct(metrics.mrr)} < ${fmtPct(t.mrr)}`);
  if (metrics.classifier_accuracy < t.classifier_accuracy)
    fails.push(
      `classifier ${fmtPct(metrics.classifier_accuracy)} < ${fmtPct(t.classifier_accuracy)}`,
    );
  return fails;
}

function checkRegression(curr: Report, base: Report, tolerance = 0.02): string[] {
  // Tolerance = 2pp; FTS5 BM25 tweaks shouldn't trigger on noise.
  const fails: string[] = [];
  const keys: (keyof Report["metrics"])[] = [
    "recall_at_5",
    "recall_at_3",
    "mrr",
    "classifier_accuracy",
  ];
  for (const k of keys) {
    const d = curr.metrics[k] - base.metrics[k];
    if (d < -tolerance) {
      fails.push(`${k} regressed ${(d * 100).toFixed(1)}pp (was ${fmtPct(base.metrics[k])}, now ${fmtPct(curr.metrics[k])})`);
    }
  }
  return fails;
}

// ── Main ───────────────────────────────────────────────────────────────────

export function runEval(filterPrefix?: string): Report {
  // Lazy import db to avoid pulling it at module-load (so test isolation rules
  // around DB_PATH still work — see extraction.instructions.md).
  const { db } = require("../db.ts") as typeof import("../db.ts");
  const commandsCount = (db.prepare("SELECT COUNT(*) as c FROM commands").get() as { c: number }).c;

  const set = loadGoldenSet();
  const queries = filterPrefix
    ? set.queries.filter((q) => q.id.startsWith(filterPrefix))
    : set.queries;

  const results = queries.map((q) => evalQuery(q, commandsCount));
  return {
    generated_at: new Date().toISOString(),
    total_queries: results.length,
    metrics: aggregate(results),
    per_shape: perShape(results),
    results,
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const wantJson = args.includes("--json");
  const wantUpdate = args.includes("--update-baseline");
  const filterIdx = args.indexOf("--filter");
  const filter = filterIdx >= 0 ? args[filterIdx + 1] : undefined;

  const set = loadGoldenSet();
  const report = runEval(filter);

  if (wantJson) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  const baseline: Report | null = existsSync(BASELINE_PATH)
    ? (JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as Report)
    : null;

  printReport(report, set._thresholds, baseline);

  if (wantUpdate) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`\n  💾 baseline updated → ${BASELINE_PATH}`);
    process.exit(0);
  }

  // Gate: thresholds + regression
  const thresholdFails = filter ? [] : checkThresholds(report.metrics, set._thresholds);
  const regressionFails = baseline && !filter ? checkRegression(report, baseline) : [];

  if (thresholdFails.length > 0 || regressionFails.length > 0) {
    console.log("\n  ❌ FAIL");
    for (const f of thresholdFails) console.log(`     threshold: ${f}`);
    for (const f of regressionFails) console.log(`     regression: ${f}`);
    console.log("\n  Run with --update-baseline if this is intentional.\n");
    process.exit(1);
  }

  console.log("\n  ✅ all checks passed\n");
  process.exit(0);
}
