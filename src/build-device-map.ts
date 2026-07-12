#!/usr/bin/env bun

/**
 * build-device-map.ts — the reviewable device→URL map (B-0017 Track A).
 *
 * Joins the three device naming surfaces into ONE diffable table, one row per matrix.csv
 * device, so a human (or MikroTik) can double-check the whole mapping at a glance instead of
 * probing the MCP for errors. Everything that resolves by the canonical matcher in
 * assess-hardware.ts is marked `auto`; the genuine odd-balls are pulled from the hand-curated
 * device-exceptions.toml. Emits device-map.tsv (committed).
 *
 * This doubles as a CI drift gate: it exits non-zero when
 *   (a) a matrix device resolves to neither a rule nor a curated exception, or
 *   (b) a curated exception has become redundant (the device now auto-resolves) — so stale
 *       exceptions get pruned rather than silently accumulating.
 * Run it after `make assess-hardware` / `make assess-www` (it reads their committed JSON).
 *
 * Usage:
 *   bun run src/build-device-map.ts            # write device-map.tsv + validate (exit 1 on drift)
 *   bun run src/build-device-map.ts --check     # validate only, do not rewrite the TSV
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import exceptions from "../device-exceptions.toml";
import { canonForms, loadMatrixRows, type MatrixRow } from "./assess-hardware.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const MATRIX_CSV = resolve(PROJECT_ROOT, "matrix", "2026-07-07", "matrix.csv");
const HARDWARE_ASSESSMENT = resolve(PROJECT_ROOT, "ros-hardware-assessment.json");
const WWW_ASSESSMENT = resolve(PROJECT_ROOT, "ros-www-assessment.json");
const OUT_TSV = resolve(PROJECT_ROOT, "device-map.tsv");
const OUT_UNMATCHED_TSV = resolve(PROJECT_ROOT, "hardware-unmatched.tsv");

const CHECK_ONLY = process.argv.includes("--check");

const HW_BASE = "https://manual.mikrotik.com/hardware";
const WWW_BASE = "https://mikrotik.com/product";

interface Exception {
  class: "curated-alias" | "no-hardware-page" | "no-www-product" | "accessory";
  hardware_slug?: string;
  www_code?: string;
  note?: string;
}
const EXCEPTIONS = exceptions as Record<string, Exception>;

interface HwPage {
  slug: string;
  title?: string;
  url?: string;
  category: string | null;
  cause: string;
  matchedMatrixNames: string[];
  mentionedCodes?: string[];
  isSeries: boolean;
}
interface WwwProduct {
  code: string;
  specs: Record<string, string>;
}

function loadJson<T>(path: string): T {
  if (!existsSync(path)) throw new Error(`Missing ${path} — run 'make assess-hardware' / 'make assess-www' first.`);
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

// ── Resolve helpers ──

/** Name → the /hardware pages whose (fixed) matchedMatrixNames claim it. */
function buildHwIndex(pages: HwPage[]): Map<string, HwPage[]> {
  const idx = new Map<string, HwPage[]>();
  for (const p of pages) {
    for (const name of p.matchedMatrixNames) {
      const list = idx.get(name) ?? [];
      list.push(p);
      idx.set(name, list);
    }
  }
  return idx;
}

/** Canonical www index over both requested code and declared "Product code". */
function buildWwwIndex(products: WwwProduct[]): Map<string, WwwProduct> {
  const idx = new Map<string, WwwProduct>();
  for (const p of products) {
    for (const key of [p.code, p.specs?.["Product code"]]) {
      if (!key) continue;
      for (const f of canonForms(key)) if (!idx.has(f)) idx.set(f, p);
    }
  }
  return idx;
}

function resolveWww(r: MatrixRow, wwwIdx: Map<string, WwwProduct>): WwwProduct | undefined {
  for (const c of [r.code, ...r.subCodes, r.name]) {
    for (const f of canonForms(c)) {
      const p = wwwIdx.get(f);
      if (p) return p;
    }
  }
  return undefined;
}

/** Prefer the device's own (non-series) page for the URL when several pages claim it. */
function pickHwPage(r: MatrixRow, pages: HwPage[]): HwPage | undefined {
  if (pages.length <= 1) return pages[0];
  const ownForms = new Set([r.code, r.name, ...r.subCodes].flatMap(canonForms));
  const own = pages.find((p) => canonForms(p.slug).some((f) => ownForms.has(f)));
  return own ?? pages.find((p) => !p.isSeries) ?? pages[0];
}

// ── Main ──

const matrixRows = loadMatrixRows(MATRIX_CSV);
const hwPages = loadJson<{ pages: HwPage[] }>(HARDWARE_ASSESSMENT).pages;
const wwwProducts = loadJson<{ products: WwwProduct[] }>(WWW_ASSESSMENT).products;

const hwIndex = buildHwIndex(hwPages);
const wwwIndex = buildWwwIndex(wwwProducts);

interface MapRow {
  name: string;
  code: string;
  category: string;
  resolution: string;
  hw_url: string;
  www_url: string;
  needs_review: string;
  note: string;
}

const rows: MapRow[] = [];
const problems: string[] = [];
const usedExceptions = new Set<string>();

for (const r of matrixRows) {
  const hwPagesForRow = hwIndex.get(r.name) ?? [];
  const hwPage = pickHwPage(r, hwPagesForRow);
  const wwwProduct = resolveWww(r, wwwIndex);

  const autoHw = hwPage ? `${HW_BASE}/${hwPage.slug}` : "";
  const autoWww = wwwProduct ? `${WWW_BASE}/${encodeURIComponent(wwwProduct.code)}` : "";
  const category = hwPage?.category ?? "";
  const exc = EXCEPTIONS[r.name];

  if (autoHw && autoWww) {
    // Clean auto-resolution. If this device is ALSO in exceptions, the exception is now stale.
    if (exc) problems.push(`STALE exception "${r.name}" — now auto-resolves (hw+www), remove it from device-exceptions.toml`);
    rows.push({ name: r.name, code: r.code, category, resolution: "auto", hw_url: autoHw, www_url: autoWww, needs_review: "", note: "" });
    continue;
  }

  // Partial or no auto-resolution → must be covered by a curated exception.
  if (!exc) {
    const missing = [!autoHw && "hw", !autoWww && "www"].filter(Boolean).join("+");
    problems.push(`UNCOVERED "${r.name}" — missing ${missing}, not in device-exceptions.toml (add a curated entry or a matcher rule)`);
    rows.push({ name: r.name, code: r.code, category, resolution: "UNRESOLVED", hw_url: autoHw, www_url: autoWww, needs_review: `missing-${missing}`, note: "" });
    continue;
  }

  usedExceptions.add(r.name);
  const hwUrl = autoHw || (exc.hardware_slug ? `${HW_BASE}/${exc.hardware_slug}` : "");
  const wwwUrl = autoWww || (exc.www_code ? `${WWW_BASE}/${exc.www_code}` : "");
  const hasBothUrls = Boolean(hwUrl && wwwUrl);
  const needsReviewClasses = new Set(["no-hardware-page", "no-www-product", "accessory"]);
  const needsReview =
    needsReviewClasses.has(exc.class)
      ? exc.class
      : exc.class === "curated-alias"
        ? (hasBothUrls ? "" : exc.class)
        : exc.class;
  rows.push({
    name: r.name,
    code: r.code,
    category,
    resolution: exc.class,
    hw_url: hwUrl,
    www_url: wwwUrl,
    needs_review: needsReview,
    note: exc.note ?? "",
  });
}

// Any exception key not matching a current matrix row is stale (device renamed/removed).
for (const key of Object.keys(EXCEPTIONS)) {
  if (!matrixRows.some((r) => r.name === key)) {
    problems.push(`STALE exception "${key}" — no matching matrix.csv row (renamed/removed?)`);
  }
}

// ── Emit ──
// In --check mode we do NOT rewrite the committed artifact; instead we verify it byte-for-byte
// against the freshly computed output, so a stale committed TSV (matcher/exception changed but the
// file wasn't regenerated) fails the gate rather than passing silently (PR #37 review).
async function emitOrCheck(path: string, content: string, label: string): Promise<void> {
  if (!CHECK_ONLY) {
    await Bun.write(path, content);
    console.log(`Wrote ${label} to ${path}`);
    return;
  }
  const committed = existsSync(path) ? readFileSync(path, "utf-8") : "";
  if (committed !== content) {
    problems.push(`STALE artifact ${path} — committed content differs from freshly computed ${label}; run 'make device-map' and commit the result`);
  }
}

function rowsToTsv(headers: readonly string[], dataRows: readonly (readonly unknown[])[]): string {
  return `${[
    headers.join("\t"),
    ...dataRows.map((row) => row.map((cell) => String(cell).replace(/\t|\n/g, " ")).join("\t")),
  ].join("\n")}\n`;
}

const HEADERS: (keyof MapRow)[] = ["name", "code", "category", "resolution", "hw_url", "www_url", "needs_review", "note"];
const tsv = rowsToTsv(HEADERS, rows.map((row) => HEADERS.map((h) => row[h])));

await emitOrCheck(OUT_TSV, tsv, `${rows.length} device rows`);

// ── Audit view: /hardware pages that map to NO matrix device ──
// The reverse of device-map.tsv. A /hardware page with no matrix row is usually a genuine
// non-device (accessory, antenna, interface) or a series/index page — but it can also be a
// real device MISSING from matrix.csv. This artifact makes that set human-auditable instead of
// invisible (B-0018 "How to audit"). Not a drift gate: MikroTik adds/retires pages routinely.
const UNMATCHED_HEADERS = ["slug", "category", "is_series", "cause", "url", "mentioned_codes"] as const;
const unmatchedRows = hwPages
  .filter((p) => !p.matchedMatrixNames?.length)
  .sort((a, b) => (a.category ?? "").localeCompare(b.category ?? "") || a.slug.localeCompare(b.slug))
  .map((p) => [
    p.slug,
    p.category ?? "",
    p.isSeries ? "yes" : "",
    p.cause,
    p.url ?? `${HW_BASE}/${p.slug}`,
    (p.mentionedCodes ?? []).join(" "),
  ]);
const unmatchedTsv = rowsToTsv(UNMATCHED_HEADERS, unmatchedRows);
await emitOrCheck(OUT_UNMATCHED_TSV, unmatchedTsv, `${unmatchedRows.length} unmatched /hardware pages`);

// ── Summary + drift gate ──
const byRes: Record<string, number> = {};
for (const row of rows) byRes[row.resolution] = (byRes[row.resolution] || 0) + 1;
console.log("Resolution breakdown:");
for (const [k, v] of Object.entries(byRes).sort(([, a], [, b]) => b - a)) console.log(`  ${k}: ${v}`);
console.log(`Curated exceptions used: ${usedExceptions.size}/${Object.keys(EXCEPTIONS).length}`);

if (problems.length) {
  console.error(`\nDRIFT (${problems.length}):`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log("\nNo drift — every device resolves by rule or a live curated exception.");
