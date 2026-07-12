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
import { lookupProperty, searchAll, searchChangelogs, searchVideos } from "../query.ts";
import { deriveRosettaId } from "../rosetta-id.ts";

// ── Types ──────────────────────────────────────────────────────────────────

type Shape =
  | "nl-question"
  | "command-path"
  | "version-question"
  | "device"
  | "topic-multi"
  | "ambiguous"
  // Direct-surface shapes (surface ≠ "search"); bucketed into surface_matrix, not per_shape.
  | "property"
  | "changelog"
  | "video";

type ExpectedClassified = {
  command_path?: string;
  version?: string;
  device?: string;
  property?: string;
};

type MatchMode = "any" | "all";

/**
 * Which retrieval surface a golden query exercises. `search` (the default) is the
 * `routeros_search`/`searchAll()` entry point and carries the durable recall/MRR/classifier
 * gate — it is the surface most exposed to the Confluence→Docusaurus corpus swap. The other
 * three dispatch to the dedicated MCP tools (`routeros_lookup_property`,
 * `routeros_search_changelogs`, video search) and feed a separate, informational
 * `surface_matrix` — a starting coverage board for surfaces the golden set never touched,
 * kept OUT of the search aggregates so those stay sensitive (issue #53). */
type Surface = "search" | "property" | "changelog" | "video";

type GoldenQuery = {
  id: string;
  query: string;
  shape: Shape;
  /** Which retrieval surface to exercise. Default "search" (searchAll). See {@link Surface}. */
  surface?: Surface;
  /** Stable identity for Docusaurus-sourced pages — see src/rosetta-id.ts. `pages.id` is NOT
   * stable across extraction runs (extract-docusaurus.ts re-mints it as a fresh rowid every
   * time), so golden-set expectations must pin to rosetta_id, not the numeric id. */
  expected_rosetta_ids?: string[];
  /** "any" (default): top-k contains ≥1 expected page → recall=1. "all": classical subset recall. */
  match_mode?: MatchMode;
  expected_classified?: ExpectedClassified;
  expected_topics_any?: string[];
  expected_related?: string[];
  /** surface: "property" — assert lookupProperty(name, path?) resolves. When `path` is given,
   * a high-confidence (path→page-linked) row is required, so a broken Docusaurus path→page
   * link or a dropped property fails loudly. Optional `page` pins the resolving page's
   * rosetta_id (catches a property that migrated to the wrong page in the new manual). */
  expected_property?: { name: string; path?: string; page?: string };
  /** surface: "changelog" — a top-k searchChangelogs() result's description must contain this
   * substring (case-insensitive); pair with expected_version to scope to a release. */
  expected_changelog_contains?: string;
  /** surface: "changelog" — restrict/assert the changelog version (e.g. "7.22"). */
  expected_version?: string;
  /** surface: "video" — a top-k searchVideos() hit's title/chapter/excerpt must contain this
   * substring (case-insensitive), or match expected_video_id. */
  expected_video_contains?: string;
  expected_video_id?: string;
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
  surface: Surface;
  recall_at_5: number;
  recall_at_3: number;
  reciprocal_rank: number;
  classifier_ok: boolean;
  related_ok: boolean;
  topics_ok: boolean;
  /** For non-search surfaces: did the dedicated tool return the expected result in top-k? */
  surface_hit?: boolean;
  skipped: boolean;
  skip_reason?: string;
  top_pages: { id: number; title: string; rosetta_id: string }[];
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
  /** Informational coverage board for the dedicated non-search surfaces (property/changelog/
   * video). Per-surface hit@5. NOT part of the search recall/MRR/classifier gate (issue #53) —
   * tracked in baseline.json so regressions are visible, gated softly (see main). */
  surface_matrix: Record<string, { count: number; hit_at_5: number }>;
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
    surface: "search",
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
  const topRosettaIds = resp.pages.slice(0, k).map((p) => deriveRosettaId(p.url));
  const top3RosettaIds = resp.pages.slice(0, 3).map((p) => deriveRosettaId(p.url));

  // Recall semantics — default "any" (≥1 expected page in top-k counts as full recall).
  // For QA-style retrieval we usually only need ONE good answer; classical subset recall
  // ("all" mode) is opt-in for cases where coverage actually matters.
  const expected = q.expected_rosetta_ids ?? [];
  const mode: MatchMode = q.match_mode ?? "any";
  const recallFor = (ids: string[]): number => {
    if (expected.length === 0) return 1;
    if (mode === "any") {
      return expected.some((id) => ids.includes(id)) ? 1 : 0;
    }
    // "all" mode: classical subset recall
    return expected.filter((id) => ids.includes(id)).length / expected.length;
  };
  const recall_at_5 = recallFor(topRosettaIds);
  const recall_at_3 = recallFor(top3RosettaIds);

  // Reciprocal rank: 1/rank of first expected page in top-k. 0 if none found.
  let rr = 0;
  if (expected.length > 0) {
    for (let i = 0; i < topRosettaIds.length; i++) {
      if (expected.includes(topRosettaIds[i] as string)) {
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
    notes.push(`top-${k} pages: ${topRosettaIds.join(", ")} (none of expected ${expected.join(", ")})`);
  }

  return {
    id: q.id,
    query: q.query,
    shape: q.shape,
    surface: "search",
    recall_at_5,
    recall_at_3,
    reciprocal_rank: rr,
    classifier_ok,
    related_ok,
    topics_ok,
    skipped: false,
    top_pages: resp.pages.slice(0, 5).map((p) => ({ id: p.id, title: p.title, rosetta_id: deriveRosettaId(p.url) })),
    classified_actual: { ...resp.classified },
    notes,
  };
}

// ── Direct-surface evaluation (property / changelog / video) ─────────────────
// These dispatch to the dedicated query functions rather than searchAll. A "hit" is a
// pass; the aggregate lives in surface_matrix, never mixed into the search recall metrics.
// recall_at_5 mirrors the hit (1/0) only so shared per-query printing/failure-detection works.

function evalSurfaceQuery(q: GoldenQuery, commandsCount: number, k = 5): QueryResult {
  const base: QueryResult = {
    id: q.id,
    query: q.query,
    shape: q.shape,
    surface: q.surface ?? "search",
    recall_at_5: 1,
    recall_at_3: 1,
    reciprocal_rank: 1,
    classifier_ok: true,
    related_ok: true,
    topics_ok: true,
    surface_hit: true,
    skipped: false,
    top_pages: [],
    classified_actual: {},
    notes: [],
  };

  if (q.requires_commands_min && commandsCount < q.requires_commands_min) {
    return { ...base, skipped: true, skip_reason: `requires commands ≥ ${q.requires_commands_min}, DB has ${commandsCount}` };
  }

  const notes: string[] = [];
  let hit = false;

  // A surface query with no expectation asserts nothing — a fixture-author mistake that must
  // show RED (drag surface_matrix down + appear in the failures block), never pass for free or
  // quietly skip. Hard-fail loudly rather than skip, so silent coverage loss can't merge.
  const misconfigured = (reason: string): QueryResult => {
    notes.push(`MISCONFIGURED: ${reason}`);
    return { ...base, surface_hit: false, recall_at_5: 0, recall_at_3: 0, reciprocal_rank: 0, notes };
  };

  if (q.surface === "property") {
    const ep = q.expected_property;
    if (!ep) return misconfigured("surface=property but no expected_property");
    const rows = lookupProperty(ep.name, ep.path);
    if (ep.path) {
      // path given → require a high-confidence (path→page-linked) row, else the link/property is broken
      const highRows = rows.filter((r) => r.confidence === "high");
      hit = ep.page
        ? highRows.some((r) => deriveRosettaId(r.page_url) === ep.page)
        : highRows.length > 0;
      if (!hit) {
        notes.push(
          `property ${ep.path} → ${ep.name}: ${rows.length} row(s), ${highRows.length} high-confidence` +
            (ep.page ? `; want page=${ep.page}, got=${highRows.map((r) => deriveRosettaId(r.page_url)).join("|") || "none"}` : ""),
        );
      }
    } else {
      hit = ep.page
        ? rows.some((r) => deriveRosettaId(r.page_url) === ep.page)
        : rows.length > 0;
      if (!hit) notes.push(`property ${ep.name}: ${rows.length} row(s)${ep.page ? `, none on page ${ep.page}` : " (none found)"}`);
    }
  } else if (q.surface === "changelog") {
    // Require at least one assertion: the substring, or a version scope (the version filter is
    // applied to searchChangelogs, so "rows exist for vX" is a real, if weak, check). Neither ⇒
    // "any changelog result passes" = vacuous.
    if (!q.expected_changelog_contains && !q.expected_version) {
      return misconfigured("surface=changelog but neither expected_changelog_contains nor expected_version set");
    }
    const rows = searchChangelogs(q.query, { version: q.expected_version, limit: k });
    const want = q.expected_changelog_contains?.toLowerCase();
    hit = rows.length > 0 && (want ? rows.some((r) => r.description.toLowerCase().includes(want)) : true);
    if (!hit) {
      notes.push(
        `changelog "${q.query}"${q.expected_version ? ` (v${q.expected_version})` : ""}: ${rows.length} result(s)` +
          (want ? `, none containing "${q.expected_changelog_contains}"` : ""),
      );
    }
  } else if (q.surface === "video") {
    // Require at least one criterion, else the row predicate collapses to "any result passes".
    if (!q.expected_video_contains && !q.expected_video_id) {
      return misconfigured("surface=video but neither expected_video_contains nor expected_video_id set");
    }
    const rows = searchVideos(q.query, k);
    const want = q.expected_video_contains?.toLowerCase();
    hit =
      rows.length > 0 &&
      rows.some(
        (r) =>
          (q.expected_video_id ? r.video_id === q.expected_video_id : false) ||
          (want ? `${r.title} ${r.chapter_title ?? ""} ${r.excerpt}`.toLowerCase().includes(want) : false),
      );
    if (!hit) {
      notes.push(
        `video "${q.query}": ${rows.length} result(s)` +
          (want ? `, none containing "${q.expected_video_contains}"` : "") +
          (q.expected_video_id ? `, none matching id ${q.expected_video_id}` : ""),
      );
    }
  } else {
    return misconfigured(`unknown surface "${q.surface}"`);
  }

  return { ...base, surface_hit: hit, recall_at_5: hit ? 1 : 0, recall_at_3: hit ? 1 : 0, reciprocal_rank: hit ? 1 : 0, notes };
}

// ── Aggregation ────────────────────────────────────────────────────────────

function aggregate(results: QueryResult[]): Report["metrics"] {
  // Search-surface only — the durable recall/MRR/classifier gate. Direct-surface queries
  // (property/changelog/video) live in surface_matrix and never dilute these numbers (#53).
  const active = results.filter((r) => !r.skipped && r.surface === "search");
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

function surfaceMatrix(results: QueryResult[]): Report["surface_matrix"] {
  const out: Report["surface_matrix"] = {};
  for (const r of results) {
    if (r.skipped || r.surface === "search") continue;
    if (!out[r.surface]) out[r.surface] = { count: 0, hit_at_5: 0 };
    const b = out[r.surface];
    if (!b) continue;
    b.count += 1;
    b.hit_at_5 += r.surface_hit ? 1 : 0;
  }
  for (const k of Object.keys(out)) {
    const b = out[k];
    if (b && b.count > 0) b.hit_at_5 = b.hit_at_5 / b.count;
  }
  return out;
}

function perShape(results: QueryResult[]): Report["per_shape"] {
  const out: Report["per_shape"] = {};
  for (const r of results) {
    if (r.skipped || r.surface !== "search") continue;
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

  console.log("\n  Per shape (search surface):");
  for (const [shape, b] of Object.entries(report.per_shape)) {
    console.log(
      `    ${shape.padEnd(20)} n=${String(b.count).padStart(2)}  recall@5=${fmtPct(b.recall_at_5).padStart(7)}  mrr=${fmtPct(b.mrr).padStart(7)}`,
    );
  }

  const surfaces = Object.entries(report.surface_matrix);
  if (surfaces.length > 0) {
    console.log("\n  Direct-surface matrix (informational — not part of the search gate):");
    for (const [surface, b] of surfaces) {
      const prev = baseline?.surface_matrix?.[surface];
      let delta = "";
      if (prev && typeof prev.hit_at_5 === "number") {
        const d = b.hit_at_5 - prev.hit_at_5;
        if (Math.abs(d) >= 0.001) delta = `  Δ ${d > 0 ? "+" : ""}${(d * 100).toFixed(1)}pp`;
      }
      console.log(`    ${surface.padEnd(20)} n=${String(b.count).padStart(2)}  hit@5=${fmtPct(b.hit_at_5).padStart(7)}${delta}`);
    }
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

/**
 * Per-query "was passing, now failing" detection for the direct surfaces. Small-N robust
 * (a single flip in a 3-query surface is 33pp — a pp-based gate would be brittle), so this
 * keys on individual query ids from the baseline's stored results rather than the aggregate.
 * Returned as WARNINGS, not hard failures: the direct-surface matrix is informational in
 * this first cut (issue #53) — a genuine ETL/MCP regression it catches gets triaged into the
 * Bug Ledger / a follow-up issue, not silently gated. Firm up to a hard gate once the matrix
 * has enough queries and a stable floor.
 */
function checkSurfaceRegression(curr: Report, base: Report): string[] {
  const wasHit = new Map<string, boolean>();
  for (const r of base.results) {
    if (r.surface && r.surface !== "search") wasHit.set(r.id, r.surface_hit === true);
  }
  const warns: string[] = [];
  for (const r of curr.results) {
    if (r.surface === "search" || r.skipped) continue;
    if (wasHit.get(r.id) === true && r.surface_hit !== true) {
      warns.push(`[${r.surface}] ${r.id} "${r.query}" was passing, now MISSES`);
    }
  }
  return warns;
}

function checkFixtureMisconfiguration(report: Report): string[] {
  return report.results
    .filter((r) => !r.skipped && r.notes.some((note) => note.startsWith("MISCONFIGURED: ")))
    .map((r) => `[${r.surface}] ${r.id}: ${r.notes.filter((note) => note.startsWith("MISCONFIGURED: ")).join("; ")}`);
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

  const results = queries.map((q) =>
    (q.surface ?? "search") === "search" ? evalQuery(q, commandsCount) : evalSurfaceQuery(q, commandsCount),
  );
  return {
    generated_at: new Date().toISOString(),
    total_queries: results.length,
    metrics: aggregate(results),
    per_shape: perShape(results),
    surface_matrix: surfaceMatrix(results),
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

  // Soft surface-matrix regression (warn, non-fatal — see checkSurfaceRegression).
  const surfaceWarns = baseline && !filter ? checkSurfaceRegression(report, baseline) : [];
  if (surfaceWarns.length > 0) {
    console.log(`\n  ⚠️  ${surfaceWarns.length} direct-surface regression(s) — triage into the Bug Ledger, not auto-gated:`);
    for (const w of surfaceWarns) console.log(`     surface: ${w}`);
  }

  // Gate: fixture validity + search-surface thresholds/regression. Direct-surface misses stay
  // informational, but an invalid golden query definition must fail CI instead of reducing
  // coverage silently.
  const fixtureFails = checkFixtureMisconfiguration(report);
  const thresholdFails = filter ? [] : checkThresholds(report.metrics, set._thresholds);
  const regressionFails = baseline && !filter ? checkRegression(report, baseline) : [];

  if (fixtureFails.length > 0 || thresholdFails.length > 0 || regressionFails.length > 0) {
    console.log("\n  ❌ FAIL");
    for (const f of fixtureFails) console.log(`     fixture: ${f}`);
    for (const f of thresholdFails) console.log(`     threshold: ${f}`);
    for (const f of regressionFails) console.log(`     regression: ${f}`);
    console.log("\n  Run with --update-baseline if this is intentional.\n");
    process.exit(1);
  }

  console.log("\n  ✅ all checks passed\n");
  process.exit(0);
}
