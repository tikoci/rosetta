#!/usr/bin/env bun

/**
 * extract-hardware-catalog.ts — Build hardware_catalog + device_aliases from the
 * B-0017 research artifacts (ros-hardware-assessment.json, ros-www-assessment.json).
 *
 * hardware_catalog is the full /hardware + mikrotik.com/product device universe — a
 * superset of `devices` (accessories and legacy/EOL SKUs included), with an optional
 * link back to `devices.id` for the rows matrix.csv also tracks. `devices` itself is
 * untouched. See briefings/B-0017-hardware-overlay-device-resolution.md "Phased
 * implementation plan" for the schema rationale and issue #35 for the build spec.
 *
 * Identity: rosetta_device_id is a rosetta-curated stable key, not any one source's
 * own slug — slugify(matrix product name) for devices-linked rows, `hw-<hardware
 * slug>` for hardware/www-only rows (accessories, legacy SKUs). device_aliases then
 * maps every observed slug/code/name variant (matrix.csv, /hardware slug, /hardware
 * product link, /hardware Model-column table code, www requested code, www declared
 * "Product code", www compareProductsTrigger id) back to that one id.
 *
 * Series pages resolving to more than one current matrix row (e.g. rb1100-series ->
 * both "RB1100AHx4" and "RB1100AHx4 Dude Edition") attribute their slug to every
 * matched device (it's a real shared install guide for all of them), but attribute
 * each product link / table code only when exactly one matched device's own codes
 * claim it — so a www product lookup never picks up a sibling variant's spec page.
 * See attributeToken().
 *
 * Fails loudly (non-zero exit, DB untouched) on drift from fixtures/hardware-catalog/
 * baseline.json — category taxonomy changed, www page template changed, matrix
 * coverage regressed, a previously-resolved device stopped resolving, or the www
 * 404 rate swung sharply. Run with --update-baseline once a drift is confirmed
 * legitimate (not a silent breakage) to accept the new numbers.
 *
 * Usage:
 *   bun run src/extract-hardware-catalog.ts                  # validate + write DB
 *   bun run src/extract-hardware-catalog.ts --update-baseline # accept current stats as new baseline
 *   bun run src/extract-hardware-catalog.ts --check-only       # validate + report, skip DB write
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadMatrixRows, type MatrixRow, normCode, slugify } from "./assess-hardware.ts";
import { db, initDb } from "./db.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_MATRIX_CSV = resolve(PROJECT_ROOT, "matrix", "2026-07-07", "matrix.csv");
const HARDWARE_ASSESSMENT_PATH = resolve(PROJECT_ROOT, "ros-hardware-assessment.json");
const WWW_ASSESSMENT_PATH = resolve(PROJECT_ROOT, "ros-www-assessment.json");
export const BASELINE_PATH = resolve(PROJECT_ROOT, "fixtures", "hardware-catalog", "baseline.json");

// ── Input shapes (subset of ros-*-assessment.json actually consumed here) ──

export interface HardwarePage {
  slug: string;
  title: string;
  productLinks: string[];
  tableModelCodes: string[];
  category: string | null;
  cause: "matched-by-code" | "matched-by-table" | "matched-by-slug" | "no-product-link" | "unmatched";
  matchedMatrixNames: string[];
}

export interface HardwareAssessment {
  matrixRowCount: number;
  matchedByCode: number;
  matchedByTable: number;
  matchedBySlug: number;
  categories: Array<{ name: string; memberCount: number; members: string[] }>;
  uncategorizedPages: string[];
  pages: HardwarePage[];
}

export interface WwwProduct {
  code: string;
  title: string;
  tagline: string;
  discontinued: boolean;
  compareId: string;
  specs: Record<string, string>;
}

export interface WwwAssessment {
  candidateCount: number;
  notFoundCount: number;
  fieldFrequency: Record<string, number>;
  products: WwwProduct[];
}

// ── Output shapes ──

export interface CatalogRow {
  rosettaDeviceId: string;
  devicesId: number | null;
  category: string | null;
  discontinued: 0 | 1 | null;
  specsJson: string | null;
  sourceHardwareSlug: string | null;
  sourceWwwCode: string | null;
}

export interface AliasRow {
  alias: string;
  rosettaDeviceId: string;
  source: string;
}

export interface BuildResult {
  catalogRows: CatalogRow[];
  aliasRows: AliasRow[];
  unresolvedDevices: string[]; // matrix rows with no devices.id match (extract-devices out of sync)
  ambiguousTokens: Array<{ page: string; token: string; candidates: string[] }>;
}

// ── www product lookup ──

function buildWwwIndex(products: WwwProduct[]): Map<string, WwwProduct> {
  const byCode = new Map<string, WwwProduct>();
  for (const p of products) byCode.set(normCode(p.code), p);
  return byCode;
}

function findWwwProduct(codes: string[], wwwByCode: Map<string, WwwProduct>): WwwProduct | null {
  for (const c of codes) {
    const hit = wwwByCode.get(normCode(c));
    if (hit) return hit;
  }
  return null;
}

/** Merge www spec fields + title/tagline + the /hardware page's own title into one JSON blob. */
function buildSpecsJson(www: WwwProduct | null, hardwareTitle: string | null): string | null {
  if (!www && !hardwareTitle) return null;
  const obj: Record<string, string> = {};
  if (www) {
    for (const [k, v] of Object.entries(www.specs)) obj[k] = v;
    if (www.title) obj._www_title = www.title;
    if (www.tagline) obj._www_tagline = www.tagline;
  }
  if (hardwareTitle) obj._hardware_title = hardwareTitle;
  return Object.keys(obj).length > 0 ? JSON.stringify(obj) : null;
}

// ── Per-device attribution (folds single- and multi-match /hardware pages together) ──

interface Attribution {
  slugs: Set<string>;
  linkTokens: Set<string>;
  tableTokens: Set<string>;
}

function getAttr(byName: Map<string, Attribution>, name: string): Attribution {
  let a = byName.get(name);
  if (!a) {
    a = { slugs: new Set(), linkTokens: new Set(), tableTokens: new Set() };
    byName.set(name, a);
  }
  return a;
}

/**
 * Which of a multi-match page's matchedMatrixNames a single token (product link or
 * table code) actually belongs to — checked against each candidate device's own
 * subCodes/nameSlug/codeSlugs. Returns the one matching name, or null if zero or
 * more than one device claims it (ambiguous — rare in practice for a concrete
 * per-device code, unlike the page's own shared slug).
 */
function attributeToken(token: string, candidateNames: string[], matrixRowByName: Map<string, MatrixRow>): string | null {
  const norm = normCode(token);
  const linkSlug = slugify(token.replace(/_/g, "-"));
  const matches = candidateNames.filter((name) => {
    const row = matrixRowByName.get(name);
    if (!row) return false;
    if (row.subCodes.some((c) => normCode(c) === norm)) return true;
    if (row.nameSlug === linkSlug) return true;
    if (row.codeSlugs.includes(linkSlug)) return true;
    return false;
  });
  return matches.length === 1 ? matches[0] : null;
}

type AddAliasFn = (alias: string, rosettaDeviceId: string, source: string) => void;

/**
 * www requested code, declared "Product code", and compareProductsTrigger id all as
 * aliases. Declared/compare codes are only recorded when they differ from the
 * requested code (the common case is agreement). Compound declared codes (kits,
 * e.g. "ATLGM&RG520F-EU") are also split on `&` so each atomic component code is
 * independently searchable, mirroring how matrix.csv's own subCodes are split.
 */
function addWwwAliases(addAlias: AddAliasFn, wwwProduct: WwwProduct | null, rosettaDeviceId: string) {
  if (!wwwProduct) return;
  addAlias(wwwProduct.code, rosettaDeviceId, "www-code");
  const declared = wwwProduct.specs["Product code"];
  if (declared && normCode(declared) !== normCode(wwwProduct.code)) {
    addAlias(declared, rosettaDeviceId, "www-declared-code");
    for (const part of declared.split("&").map((s) => s.trim())) {
      if (part && normCode(part) !== normCode(declared)) addAlias(part, rosettaDeviceId, "www-declared-code");
    }
  }
  if (wwwProduct.compareId && normCode(wwwProduct.compareId) !== normCode(wwwProduct.code)) {
    addAlias(wwwProduct.compareId, rosettaDeviceId, "www-compare-id");
  }
}

// ── Core build (pure — no DB, no filesystem) ──

export function buildCatalog(
  matrixRows: MatrixRow[],
  devicesByName: Map<string, number>,
  hwPages: HardwarePage[],
  wwwProducts: WwwProduct[],
): BuildResult {
  const wwwByCode = buildWwwIndex(wwwProducts);
  const matrixRowByName = new Map(matrixRows.map((r) => [r.name, r]));
  const byName = new Map<string, Attribution>();
  const ambiguousTokens: Array<{ page: string; token: string; candidates: string[] }> = [];

  for (const page of hwPages) {
    if (page.matchedMatrixNames.length === 0) continue; // standalone (accessory/legacy) — handled below
    if (page.matchedMatrixNames.length === 1) {
      const a = getAttr(byName, page.matchedMatrixNames[0]);
      a.slugs.add(page.slug);
      for (const t of page.productLinks) a.linkTokens.add(t);
      for (const t of page.tableModelCodes) a.tableTokens.add(t);
      continue;
    }
    // Multi-match series page: the page itself legitimately describes every matched
    // device (it's a shared install guide), so its slug is safe to attribute to all
    // of them for category/source_hardware_slug purposes. Only the *codes on* the
    // page are ambiguous per-device — those get per-token attribution below, so a
    // www product lookup never picks up a sibling's code.
    for (const name of page.matchedMatrixNames) getAttr(byName, name).slugs.add(page.slug);
    for (const t of page.productLinks) {
      const owner = attributeToken(t, page.matchedMatrixNames, matrixRowByName);
      if (owner) getAttr(byName, owner).linkTokens.add(t);
      else ambiguousTokens.push({ page: page.slug, token: t, candidates: page.matchedMatrixNames });
    }
    for (const t of page.tableModelCodes) {
      const owner = attributeToken(t, page.matchedMatrixNames, matrixRowByName);
      if (owner) getAttr(byName, owner).tableTokens.add(t);
      else ambiguousTokens.push({ page: page.slug, token: t, candidates: page.matchedMatrixNames });
    }
  }

  const catalogRows: CatalogRow[] = [];
  const aliasMap = new Map<string, AliasRow>(); // keyed by normCode(alias) for O(1) collision dedup
  const usedIds = new Set<string>();
  const unresolvedDevices: string[] = [];

  const addAlias = (alias: string, rosettaDeviceId: string, source: string) => {
    const key = normCode(alias);
    if (!key) return;
    const existing = aliasMap.get(key);
    if (existing && existing.rosettaDeviceId !== rosettaDeviceId) return; // first-claimed wins
    if (existing) return;
    aliasMap.set(key, { alias: key, rosettaDeviceId, source });
  };

  const claimId = (id: string) => {
    if (usedIds.has(id)) throw new Error(`rosetta_device_id collision: "${id}" generated twice`);
    usedIds.add(id);
  };

  // ── Matrix-linked rows (devices_id set where extract-devices.ts's table agrees) ──
  for (const row of matrixRows) {
    const id = slugify(row.name);
    claimId(id);
    const devicesId = devicesByName.get(row.name) ?? null;
    if (devicesId === null) unresolvedDevices.push(row.name);

    const attr = byName.get(row.name);
    const category = attr ? (hwPages.find((p) => attr.slugs.has(p.slug))?.category ?? null) : null;
    const sourceHardwareSlug = attr && attr.slugs.size > 0 ? [...attr.slugs].sort()[0] : null;

    const candidateCodes = [...row.subCodes, ...(attr ? [...attr.linkTokens, ...attr.tableTokens] : [])];
    const wwwProduct = findWwwProduct(candidateCodes, wwwByCode);

    catalogRows.push({
      rosettaDeviceId: id,
      devicesId,
      category,
      discontinued: wwwProduct ? (wwwProduct.discontinued ? 1 : 0) : null,
      specsJson: buildSpecsJson(wwwProduct, null),
      sourceHardwareSlug,
      sourceWwwCode: wwwProduct?.code ?? null,
    });

    addAlias(row.name, id, "matrix.csv");
    for (const c of row.subCodes) addAlias(c, id, "matrix.csv");
    if (attr) {
      for (const s of attr.slugs) addAlias(s, id, "hardware-slug");
      for (const t of attr.linkTokens) addAlias(t, id, "hardware-link");
      for (const t of attr.tableTokens) addAlias(t, id, "hardware-table");
    }
    addWwwAliases(addAlias, wwwProduct, id);
  }

  // ── Standalone /hardware-only rows (accessories, legacy/EOL — no current matrix row) ──
  for (const page of hwPages) {
    if (page.matchedMatrixNames.length > 0) continue;
    const id = `hw-${page.slug}`;
    claimId(id);

    const candidateCodes = [...page.productLinks, ...page.tableModelCodes];
    const wwwProduct = findWwwProduct(candidateCodes, wwwByCode);

    catalogRows.push({
      rosettaDeviceId: id,
      devicesId: null,
      category: page.category,
      discontinued: wwwProduct ? (wwwProduct.discontinued ? 1 : 0) : null,
      specsJson: buildSpecsJson(wwwProduct, page.title),
      sourceHardwareSlug: page.slug,
      sourceWwwCode: wwwProduct?.code ?? null,
    });

    addAlias(page.slug, id, "hardware-slug");
    for (const t of page.productLinks) addAlias(t, id, "hardware-link");
    for (const t of page.tableModelCodes) addAlias(t, id, "hardware-table");
    addWwwAliases(addAlias, wwwProduct, id);
  }

  return { catalogRows, aliasRows: [...aliasMap.values()], unresolvedDevices, ambiguousTokens };
}

// ── Validation / "when to fail" ──

export interface ValidationStats {
  categoryCount: number;
  uncategorizedPages: number;
  coreFieldFrequencyPct: Record<string, number>;
  matrixCoveragePct: number;
  www404RatePct: number;
  resolvedDeviceNames: string[];
}

const CORE_WWW_FIELDS = ["Product code", "CPU", "Architecture"];
const MATRIX_COVERAGE_FLOOR_PCT = 85; // B-0017: "drops below ~85% (today: 91%, 142/156)"
const WWW_404_SWING_TOLERANCE_PCT = 15;
const CORE_FIELD_DROP_TOLERANCE_PCT = 10;

export function computeValidationStats(hw: HardwareAssessment, www: WwwAssessment, catalogRows: CatalogRow[]): ValidationStats {
  const wwwFoundCount = www.products.length;
  const coreFieldFrequencyPct: Record<string, number> = {};
  for (const field of CORE_WWW_FIELDS) {
    coreFieldFrequencyPct[field] = wwwFoundCount > 0 ? Math.round(((www.fieldFrequency[field] ?? 0) / wwwFoundCount) * 100) : 0;
  }

  const matched = hw.matchedByCode + hw.matchedByTable + hw.matchedBySlug;
  const matrixCoveragePct = hw.matrixRowCount > 0 ? Math.round((matched / hw.matrixRowCount) * 100) : 0;
  const www404RatePct = www.candidateCount > 0 ? Math.round((www.notFoundCount / www.candidateCount) * 100) : 0;

  const resolvedDeviceNames = catalogRows
    .filter((r) => r.devicesId !== null && (r.sourceHardwareSlug !== null || r.sourceWwwCode !== null))
    .map((r) => r.rosettaDeviceId)
    .sort();

  return {
    categoryCount: hw.categories.length,
    uncategorizedPages: hw.uncategorizedPages.length,
    coreFieldFrequencyPct,
    matrixCoveragePct,
    www404RatePct,
    resolvedDeviceNames,
  };
}

export function checkBaseline(current: ValidationStats, baseline: ValidationStats): string[] {
  const failures: string[] = [];

  if (current.categoryCount !== baseline.categoryCount) {
    failures.push(`category count is ${current.categoryCount}, expected ${baseline.categoryCount} — /hardware sidebar taxonomy or extraction regex likely changed`);
  }
  if (current.uncategorizedPages > baseline.uncategorizedPages) {
    failures.push(`${current.uncategorizedPages} uncategorized /hardware pages (baseline: ${baseline.uncategorizedPages})`);
  }
  for (const field of CORE_WWW_FIELDS) {
    const cur = current.coreFieldFrequencyPct[field] ?? 0;
    const base = baseline.coreFieldFrequencyPct[field] ?? 0;
    if (cur < base - CORE_FIELD_DROP_TOLERANCE_PCT) {
      failures.push(`www "${field}" field frequency dropped to ${cur}% (baseline ${base}%) — www page template likely changed`);
    }
  }
  if (current.matrixCoveragePct < MATRIX_COVERAGE_FLOOR_PCT) {
    failures.push(`matrix.csv /hardware coverage is ${current.matrixCoveragePct}% (floor: ${MATRIX_COVERAGE_FLOOR_PCT}%)`);
  }
  if (Math.abs(current.www404RatePct - baseline.www404RatePct) > WWW_404_SWING_TOLERANCE_PCT) {
    failures.push(`www 404 rate is ${current.www404RatePct}% (baseline ${baseline.www404RatePct}%, tolerance ±${WWW_404_SWING_TOLERANCE_PCT}pp) — site restructured or we're being rate-limited`);
  }
  const regressed = baseline.resolvedDeviceNames.filter((n) => !current.resolvedDeviceNames.includes(n));
  if (regressed.length > 0) {
    failures.push(`${regressed.length} previously-resolved device(s) no longer resolve: ${regressed.slice(0, 10).join(", ")}${regressed.length > 10 ? ", ..." : ""}`);
  }

  return failures;
}

// ── DB write (idempotent — delete then rebuild, per extractor-idempotent convention) ──

export function writeCatalog(result: BuildResult): void {
  const write = db.transaction(() => {
    db.run("DELETE FROM device_aliases");
    db.run("DELETE FROM hardware_catalog");

    const insertCatalog = db.prepare(`INSERT INTO hardware_catalog
      (rosetta_device_id, devices_id, category, discontinued, specs_json, source_hardware_slug, source_www_code)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const r of result.catalogRows) {
      insertCatalog.run(r.rosettaDeviceId, r.devicesId, r.category, r.discontinued, r.specsJson, r.sourceHardwareSlug, r.sourceWwwCode);
    }

    const insertAlias = db.prepare(`INSERT INTO device_aliases (alias, rosetta_device_id, source) VALUES (?, ?, ?)`);
    for (const a of result.aliasRows) {
      insertAlias.run(a.alias, a.rosettaDeviceId, a.source);
    }
  });
  write();
}

// ── Main (filesystem + DB wiring) ──

async function main() {
  const argv = process.argv.slice(2);
  const UPDATE_BASELINE = argv.includes("--update-baseline");
  const CHECK_ONLY = argv.includes("--check-only");

  if (!existsSync(HARDWARE_ASSESSMENT_PATH) || !existsSync(WWW_ASSESSMENT_PATH)) {
    console.error(`Missing assessment artifacts — run 'make assess-hardware' and 'make assess-www' first.`);
    console.error(`  expected: ${HARDWARE_ASSESSMENT_PATH}`);
    console.error(`  expected: ${WWW_ASSESSMENT_PATH}`);
    process.exit(2);
  }

  const hw = JSON.parse(readFileSync(HARDWARE_ASSESSMENT_PATH, "utf-8")) as HardwareAssessment;
  const www = JSON.parse(readFileSync(WWW_ASSESSMENT_PATH, "utf-8")) as WwwAssessment;
  const matrixRows = loadMatrixRows(DEFAULT_MATRIX_CSV);

  initDb();
  const devicesByName = new Map(
    (db.prepare("SELECT id, product_name FROM devices").all() as Array<{ id: number; product_name: string }>).map((r) => [
      r.product_name,
      r.id,
    ]),
  );

  const result = buildCatalog(matrixRows, devicesByName, hw.pages, www.products);
  const stats = computeValidationStats(hw, www, result.catalogRows);

  console.log(`hardware_catalog rows: ${result.catalogRows.length} (${result.catalogRows.filter((r) => r.devicesId !== null).length} linked to devices)`);
  console.log(`device_aliases rows:   ${result.aliasRows.length}`);
  if (result.unresolvedDevices.length > 0) {
    console.log(`WARNING: ${result.unresolvedDevices.length} matrix.csv row(s) not found in devices table (extract-devices.ts out of sync?): ${result.unresolvedDevices.join(", ")}`);
  }
  if (result.ambiguousTokens.length > 0) {
    console.log(`Ambiguous multi-match tokens skipped: ${result.ambiguousTokens.length} (series-page membership still unresolved — see B-0017 Track A Q4/Q5)`);
  }

  if (UPDATE_BASELINE) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(stats, null, 2)}\n`);
    console.log(`Baseline updated: ${BASELINE_PATH}`);
  } else {
    if (!existsSync(BASELINE_PATH)) {
      console.error(`No baseline at ${BASELINE_PATH} — run with --update-baseline once to establish one.`);
      process.exit(2);
    }
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as ValidationStats;
    const failures = checkBaseline(stats, baseline);
    if (failures.length > 0) {
      console.error(`\n✗ Validation failed against baseline (${failures.length} issue(s)) — DB not written:`);
      for (const f of failures) console.error(`  - ${f}`);
      console.error(`\nIf this drift is legitimate (confirmed, not a silent breakage), re-run with --update-baseline.`);
      process.exit(1);
    }
    console.log("✓ Validation passed against baseline.");
  }

  if (CHECK_ONLY) {
    console.log("--check-only: skipping DB write.");
    return;
  }

  writeCatalog(result);

  console.log(`Wrote ${result.catalogRows.length} hardware_catalog rows, ${result.aliasRows.length} device_aliases rows.`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
