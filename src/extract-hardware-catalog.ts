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
 * ── Attribution correctness (B-0017 Phase 1.5, PR #36 design review) ──
 * The www index is keyed by requested code AND declared "Product code" AND compareId,
 * so a page that links a device's real code resolves even when www was fetched under a
 * slug form. A www product is only accepted as a row's spec source when its own
 * identity (code / declared code / compareId / title, slugified) AGREES with the
 * device's own code/slug family — killing the cross-sell misattribution where an
 * accessory link in a legacy page's prose (mANT on chateau-lte6, QM-X on the cube
 * pages, …) used to win. A www product may back more than one row only via
 * SHARED_WWW_ALLOWLIST (the wAP R base radio inside the wAP LR kits). A declared-code
 * matching tier (page slug-suffix, then link -> www -> declared full code -> matrix
 * full code) resolves ROSE Data server and both KNOT Embedded LTE4 rows so they stop
 * appearing as duplicate `hw-*` identities.
 *
 * Alias assignment is priority-ranked (matrix sole code < matrix name/subcode < www
 * spec-source code < /hardware slug < link token < table token); collisions keep the
 * higher-priority claim and are COUNTED (BuildResult.aliasCollisions), never silently
 * swallowed. Every input entity (www product, /hardware page, matrix row) is either
 * attached to a row or recorded in the drop ledger with a reason — zero silently lost.
 *
 * The built catalog is serialized to a committed, deterministic intermediate JSON
 * (fixtures/hardware-catalog/catalog.json — sorted rows + aliases + drop ledger +
 * collisions) that writeCatalog() consumes; the git diff of that file is the
 * change-review gate. Hard output invariants (checkInvariants) fail the run outright;
 * fixtures/hardware-catalog/baseline.json holds the softer input-drift + aggregate
 * canaries checked by checkBaseline.
 *
 * Usage:
 *   bun run src/extract-hardware-catalog.ts                  # validate + write DB
 *   bun run src/extract-hardware-catalog.ts --update-baseline # accept current stats as new baseline
 *   bun run src/extract-hardware-catalog.ts --check-only       # validate + report, skip DB write
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadMatrixRows, type MatrixRow, normCode, slugify } from "./assess-hardware.ts";
import { db, initDb, setDbMeta } from "./db.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_MATRIX_CSV = resolve(PROJECT_ROOT, "matrix", "2026-07-07", "matrix.csv");
const HARDWARE_ASSESSMENT_PATH = resolve(PROJECT_ROOT, "ros-hardware-assessment.json");
const WWW_ASSESSMENT_PATH = resolve(PROJECT_ROOT, "ros-www-assessment.json");
export const BASELINE_PATH = resolve(PROJECT_ROOT, "fixtures", "hardware-catalog", "baseline.json");
export const CATALOG_JSON_PATH = resolve(PROJECT_ROOT, "fixtures", "hardware-catalog", "catalog.json");

/**
 * www product codes (normalized) that legitimately provide specs to more than one
 * catalog row. Keep this list tiny and justify every entry — it is the escape hatch
 * from the "one www product -> at most one row" invariant, so a new entry must be a
 * genuinely shared base unit sold inside multiple kits, not a cross-sell accident.
 */
const SHARED_WWW_ALLOWLIST = new Map<string, string>([
  // wAP R (RBwAPR-2nD) is the base radio bundled into every wAP LR LoRa kit — matrix.csv
  // lists RBwAPR-2nD as a subCode of wAP LR2/LR8G/LR9G kit, so the wAP R spec sheet
  // legitimately backs all four rows (wAP R itself plus the three kits).
  ["rbwapr-2nd", "wAP R base radio shared across wAP LR2/LR8G/LR9G kits"],
  // LtAP mini (RB912R-2nD-LTm) is the base radio inside the LtAP mini LTE kit
  // (RB912R-2nD-LTm & EC200A-EUr3), so the LtAP mini spec sheet — fetched under the
  // www slug "ltap_mini", declaring RB912R-2nD-LTm — legitimately backs both rows.
  ["ltap_mini", "LtAP mini base radio (RB912R-2nD-LTm) shared with the LtAP mini LTE kit"],
]);

// ── Input shapes (subset of ros-*-assessment.json actually consumed here) ──

export interface RegulatoryId {
  model: string;
  type: string; // "FCC ID" | "IC" | "CE" | ...
  id: string;
}

export interface HardwarePage {
  slug: string;
  title: string;
  productLinks: string[];
  tableModelCodes: string[];
  category: string | null;
  cause: "matched-by-code" | "matched-by-table" | "matched-by-slug" | "no-product-link" | "unmatched";
  matchedMatrixNames: string[];
  /** Management IPs that deviate from the 192.168.88.1 default (B-0017 surface-worthy). */
  nonDefaultIps?: string[];
  /** FCC/IC/CE identifiers read off Model-column regulatory tables (assess-hardware.ts). */
  regulatoryIds?: RegulatoryId[];
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
  deviceId: number | null;
  name: string;
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

export type DropKind = "www-product" | "hardware-page" | "matrix-row";

export interface DropEntry {
  kind: DropKind;
  id: string;
  reason: string;
}

export interface AliasCollision {
  alias: string;
  kept: string;
  keptSource: string;
  dropped: string;
  droppedSource: string;
}

export interface BuildResult {
  catalogRows: CatalogRow[];
  aliasRows: AliasRow[];
  unresolvedDevices: string[]; // matrix rows with no devices.id match (extract-devices out of sync)
  ambiguousTokens: Array<{ page: string; token: string; candidates: string[] }>;
  dropLedger: DropEntry[];
  aliasCollisions: AliasCollision[];
}

/** Deterministic, committed intermediate that writeCatalog() consumes — the review gate. */
export interface SerializedCatalog {
  generatedFrom: { matrixRows: number; hardwarePages: number; wwwProducts: number };
  rows: CatalogRow[];
  aliases: AliasRow[];
  dropLedger: DropEntry[];
  aliasCollisions: AliasCollision[];
}

// ── Identity + www lookup helpers ──

/** Get map[key], initializing it with make() the first time — avoids get-then-set churn. */
function getOrInit<K, V>(map: Map<K, V>, key: K, make: () => V): V {
  let v = map.get(key);
  if (v === undefined) {
    v = make();
    map.set(key, v);
  }
  return v;
}

/** slugify() each non-empty token into a Set for slug-space identity comparison. */
function identSlugs(...tokens: Array<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    if (!t) continue;
    const s = slugify(t);
    if (s) out.add(s);
  }
  return out;
}

/** A www product's own identity, in slug space — code, declared code, compareId, title. */
function wwwIdentitySlugs(p: WwwProduct): Set<string> {
  return identSlugs(p.code, p.specs["Product code"], p.compareId, p.title);
}

/**
 * Index www products by every code they answer to — requested code, declared
 * "Product code", and compareProductsTrigger id — so a device's own code resolves the
 * product even when www was fetched under a slug form (fixes the "22 fetched products
 * attach to nothing" orphaning). Keys are normCode()-normalized; first product wins a
 * key (products are pre-sorted by code for determinism). Declared codes are NOT split
 * on `&` here: a compound declared code ("EG25-G&KNe") indexes only as the whole code,
 * so a shared component ("KNe") can't drag an unrelated sibling's product onto a row.
 */
function buildWwwIndex(products: WwwProduct[]): Map<string, WwwProduct> {
  const byKey = new Map<string, WwwProduct>();
  const add = (key: string, p: WwwProduct) => {
    const k = normCode(key);
    if (k && !byKey.has(k)) byKey.set(k, p);
  };
  for (const p of [...products].sort((a, b) => normCode(a.code).localeCompare(normCode(b.code)))) {
    add(p.code, p);
    if (p.specs["Product code"]) add(p.specs["Product code"], p);
    if (p.compareId) add(p.compareId, p);
  }
  return byKey;
}

/**
 * First www product found by looking up each key in turn whose own identity AGREES
 * with `ownFamily` (the device's own code/slug family). The agreement gate is what
 * kills cross-sell misattribution: an accessory link only resolves a spec source when
 * the accessory's identity actually matches the device, which it won't.
 */
function findAgreeingWww(keys: string[], wwwByKey: Map<string, WwwProduct>, ownFamily: Set<string>): WwwProduct | null {
  for (const key of keys) {
    const hit = wwwByKey.get(normCode(key));
    if (!hit) continue;
    for (const s of wwwIdentitySlugs(hit)) {
      if (ownFamily.has(s)) return hit;
    }
  }
  return null;
}

/** Merge www spec fields + titles + /hardware page metadata (IPs, regulatory ids) into one JSON blob. */
function buildSpecsJson(
  www: WwwProduct | null,
  hardwareTitle: string | null,
  meta: { nonDefaultIps: string[]; regulatory: RegulatoryId[] },
): string | null {
  const obj: Record<string, unknown> = {};
  if (www) {
    for (const [k, v] of Object.entries(www.specs)) obj[k] = v;
    if (www.title) obj._www_title = www.title;
    if (www.tagline) obj._www_tagline = www.tagline;
  }
  if (hardwareTitle) obj._hardware_title = hardwareTitle;
  if (meta.nonDefaultIps.length > 0) obj._non_default_ips = [...meta.nonDefaultIps].sort();
  for (const type of ["FCC ID", "IC", "CE"]) {
    const ids = meta.regulatory
      .filter((r) => r.type === type)
      .map((r) => r.id)
      .filter(Boolean);
    if (ids.length > 0) obj[`_${type.toLowerCase().replace(/\s+/g, "_")}`] = [...new Set(ids)].sort();
  }
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
 * more than one device claims it (ambiguous).
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

/**
 * Declared-code third matching tier: for a /hardware page that assess-hardware.ts could
 * not tie to any matrix row (its code/table/slug tiers ran without www data), try to
 * resolve it here where www IS available. Two mechanisms, slug first (the page's own URL
 * is more authoritative about what it IS than a possibly-wrong outbound link):
 *   (1) page slug ends with slugify(matrix full code) — resolves both KNOT Embedded LTE4
 *       rows, whose slugs encode EC25-EU&KNe / EG25-G&KNe even though both link the same
 *       (mislabelled) www product;
 *   (2) a product link -> www product -> its declared full "Product code" -> matrix full
 *       code — resolves ROSE Data server (RDS), whose slug carries no code.
 * Returns matrix row names, or [] when neither mechanism fires.
 */
function resolveViaDeclaredCode(
  page: HardwarePage,
  matrixRows: MatrixRow[],
  matrixByFullCode: Map<string, string>,
  wwwByKey: Map<string, WwwProduct>,
): string[] {
  // (1) slug-suffix against a matrix row's full-code slug (>= 6 chars to avoid stubby hits).
  const slugHits = new Set<string>();
  for (const row of matrixRows) {
    const codeSlug = slugify(row.code);
    if (codeSlug.length >= 6 && (page.slug === codeSlug || page.slug.endsWith(`-${codeSlug}`))) {
      slugHits.add(row.name);
    }
  }
  if (slugHits.size > 0) return [...slugHits];

  // (2) link/table token -> www product -> declared full code -> matrix full code.
  const declaredHits = new Set<string>();
  for (const token of [...page.productLinks, ...page.tableModelCodes]) {
    const www = wwwByKey.get(normCode(token));
    const declared = www?.specs["Product code"];
    if (!declared) continue;
    const name = matrixByFullCode.get(normCode(declared));
    if (name) declaredHits.add(name);
  }
  return [...declaredHits];
}

// ── Alias assignment (priority-ranked, collision-counting) ──

const RANK_MATRIX_SOLE_CODE = 0; // a matrix row's whole product code, when it's the only one
const RANK_MATRIX = 1; // matrix product name and multi-code subcodes
const RANK_WWW = 2; // the spec-source www product's code / declared code / compareId
const RANK_HW_SLUG = 3;
const RANK_HW_LINK = 4;
const RANK_HW_TABLE = 5;

interface RankedAlias {
  alias: string;
  rosettaDeviceId: string;
  source: string;
  rank: number;
}

class AliasBook {
  private byKey = new Map<string, RankedAlias>();
  readonly collisions: AliasCollision[] = [];

  add(alias: string, rosettaDeviceId: string, source: string, rank: number): void {
    const key = normCode(alias);
    if (!key) return;
    const existing = this.byKey.get(key);
    if (!existing) {
      this.byKey.set(key, { alias: key, rosettaDeviceId, source, rank });
      return;
    }
    if (existing.rosettaDeviceId === rosettaDeviceId) {
      if (rank < existing.rank) existing.rank = rank; // same device, keep the strongest provenance
      return;
    }
    // Two different devices want the same alias — keep the higher-priority (lower rank)
    // claim, record the collision so it is never silently swallowed. Ties keep the
    // incumbent (inputs are processed in a deterministic sorted order).
    const winnerIsNew = rank < existing.rank;
    this.collisions.push({
      alias: key,
      kept: winnerIsNew ? rosettaDeviceId : existing.rosettaDeviceId,
      keptSource: winnerIsNew ? source : existing.source,
      dropped: winnerIsNew ? existing.rosettaDeviceId : rosettaDeviceId,
      droppedSource: winnerIsNew ? existing.source : source,
    });
    if (winnerIsNew) this.byKey.set(key, { alias: key, rosettaDeviceId, source, rank });
  }

  rows(): AliasRow[] {
    return [...this.byKey.values()].map((r) => ({ alias: r.alias, rosettaDeviceId: r.rosettaDeviceId, source: r.source }));
  }
}

/** www requested code, declared "Product code" (+ `&`-split parts), and compareId as aliases. */
function addWwwAliases(book: AliasBook, www: WwwProduct | null, rosettaDeviceId: string): void {
  if (!www) return;
  book.add(www.code, rosettaDeviceId, "www-code", RANK_WWW);
  const declared = www.specs["Product code"];
  if (declared && normCode(declared) !== normCode(www.code)) {
    book.add(declared, rosettaDeviceId, "www-declared-code", RANK_WWW);
    for (const part of declared.split("&").map((s) => s.trim())) {
      if (part && normCode(part) !== normCode(declared)) book.add(part, rosettaDeviceId, "www-declared-code", RANK_WWW);
    }
  }
  if (www.compareId && normCode(www.compareId) !== normCode(www.code)) {
    book.add(www.compareId, rosettaDeviceId, "www-compare-id", RANK_WWW);
  }
}

// ── Core build (pure — no DB, no filesystem) ──

export function buildCatalog(
  matrixRows: MatrixRow[],
  devicesByName: Map<string, number>,
  hwPages: HardwarePage[],
  wwwProducts: WwwProduct[],
): BuildResult {
  const sortedMatrix = [...matrixRows].sort((a, b) => a.name.localeCompare(b.name));
  const sortedPages = [...hwPages].sort((a, b) => a.slug.localeCompare(b.slug));
  const wwwByKey = buildWwwIndex(wwwProducts);
  const matrixRowByName = new Map(sortedMatrix.map((r) => [r.name, r]));
  const pageBySlug = new Map(sortedPages.map((p) => [p.slug, p]));

  // matrix rows keyed by their full normalized product code (for the declared-code tier);
  // codes shared by two rows are dropped so an ambiguous full code never mis-resolves.
  const matrixByFullCode = new Map<string, string>();
  const fullCodeSeen = new Set<string>();
  for (const r of sortedMatrix) {
    const k = normCode(r.code);
    if (!k) continue;
    if (fullCodeSeen.has(k)) {
      matrixByFullCode.delete(k);
      continue;
    }
    fullCodeSeen.add(k);
    matrixByFullCode.set(k, r.name);
  }

  // Regulatory ids + management-IP deviations, indexed by the model code they describe /
  // by page slug, so a row can pick up its own without re-walking pages.
  const regulatoryByModel = new Map<string, RegulatoryId[]>();
  for (const p of sortedPages) {
    for (const reg of p.regulatoryIds ?? []) {
      const k = normCode(reg.model);
      if (!k) continue;
      getOrInit(regulatoryByModel, k, () => []).push(reg);
    }
  }

  // ── Resolve every page to its effective matrix membership (assess-hardware tiers, then
  //    the declared-code tier for the ones it left unmatched) ──
  const effectiveMatches = new Map<string, string[]>();
  for (const page of sortedPages) {
    const base = page.matchedMatrixNames.filter((n) => matrixRowByName.has(n));
    effectiveMatches.set(
      page.slug,
      base.length > 0 ? base : resolveViaDeclaredCode(page, sortedMatrix, matrixByFullCode, wwwByKey),
    );
  }

  // ── Fold /hardware pages into per-device attribution ──
  const byName = new Map<string, Attribution>();
  const ambiguousTokens: Array<{ page: string; token: string; candidates: string[] }> = [];
  for (const page of sortedPages) {
    const names = effectiveMatches.get(page.slug) ?? [];
    if (names.length === 0) continue; // standalone (accessory/legacy) — handled below
    if (names.length === 1) {
      const a = getAttr(byName, names[0]);
      a.slugs.add(page.slug);
      for (const t of page.productLinks) a.linkTokens.add(t);
      for (const t of page.tableModelCodes) a.tableTokens.add(t);
      continue;
    }
    // Multi-match series page: its slug legitimately describes every matched device, but
    // the concrete codes on the page are per-device — attribute those by token so a www
    // lookup never picks up a sibling's spec page.
    for (const name of names) getAttr(byName, name).slugs.add(page.slug);
    for (const t of page.productLinks) {
      const owner = attributeToken(t, names, matrixRowByName);
      if (owner) getAttr(byName, owner).linkTokens.add(t);
      else ambiguousTokens.push({ page: page.slug, token: t, candidates: names });
    }
    for (const t of page.tableModelCodes) {
      const owner = attributeToken(t, names, matrixRowByName);
      if (owner) getAttr(byName, owner).tableTokens.add(t);
      else ambiguousTokens.push({ page: page.slug, token: t, candidates: names });
    }
  }

  const catalogRows: CatalogRow[] = [];
  const book = new AliasBook();
  const usedIds = new Set<string>();
  const unresolvedDevices: string[] = [];
  const attachedWwwCodes = new Set<string>(); // normCode(source_www_code) of every row that got specs
  const wwwAttachCount = new Map<string, number>(); // normCode(code) -> #rows, for the multi-attach ledger

  const claimId = (id: string) => {
    if (usedIds.has(id)) throw new Error(`rosetta_device_id collision: "${id}" generated twice`);
    usedIds.add(id);
  };

  // Gather regulatory ids + non-default IPs for a row from the model codes / pages it owns.
  const metaFor = (codes: string[], slugs: string[]) => {
    const regulatory: RegulatoryId[] = [];
    for (const c of codes) for (const r of regulatoryByModel.get(normCode(c)) ?? []) regulatory.push(r);
    const nonDefaultIps = new Set<string>();
    for (const s of slugs) for (const ip of pageBySlug.get(s)?.nonDefaultIps ?? []) nonDefaultIps.add(ip);
    return { regulatory, nonDefaultIps: [...nonDefaultIps] };
  };

  const recordWww = (www: WwwProduct | null) => {
    if (!www) return;
    const k = normCode(www.code);
    attachedWwwCodes.add(k);
    wwwAttachCount.set(k, (wwwAttachCount.get(k) ?? 0) + 1);
  };

  // ── Matrix-linked rows (device_id set where extract-devices.ts's table agrees) ──
  for (const row of sortedMatrix) {
    const id = slugify(row.name);
    claimId(id);
    const deviceId = devicesByName.get(row.name) ?? null;
    if (deviceId === null) unresolvedDevices.push(row.name);

    const attr = byName.get(row.name);
    const slugList = attr ? [...attr.slugs].sort() : [];
    const category = slugList.map((s) => pageBySlug.get(s)?.category).find((c) => c != null) ?? null;
    const sourceHardwareSlug = slugList[0] ?? null;

    // Canonical identity family + candidate keys. subCodes/name are canonical; link/table
    // tokens are only trusted through the agreement gate inside findAgreeingWww().
    const ownFamily = identSlugs(row.name, row.nameSlug, ...row.subCodes, ...row.codeSlugs, ...slugList);
    const candidateKeys = [row.code, ...row.subCodes, ...(attr ? [...attr.linkTokens, ...attr.tableTokens] : [])];
    const www = findAgreeingWww(candidateKeys, wwwByKey, ownFamily);
    recordWww(www);

    const ownCodes = [...row.subCodes, ...(attr ? [...attr.tableTokens] : [])];
    const meta = metaFor(ownCodes, slugList);
    const hardwareTitle = slugList.map((s) => pageBySlug.get(s)?.title).find((t) => !!t) ?? null;

    catalogRows.push({
      rosettaDeviceId: id,
      deviceId,
      name: www?.title || hardwareTitle || row.name,
      category,
      discontinued: www ? (www.discontinued ? 1 : 0) : null,
      specsJson: buildSpecsJson(www, hardwareTitle, meta),
      sourceHardwareSlug,
      sourceWwwCode: www?.code ?? null,
    });

    book.add(row.name, id, "matrix.csv", RANK_MATRIX);
    for (const c of row.subCodes) {
      book.add(c, id, "matrix.csv", row.subCodes.length === 1 ? RANK_MATRIX_SOLE_CODE : RANK_MATRIX);
    }
    if (attr) {
      for (const s of attr.slugs) book.add(s, id, "hardware-slug", RANK_HW_SLUG);
      for (const t of attr.linkTokens) book.add(t, id, "hardware-link", RANK_HW_LINK);
      for (const t of attr.tableTokens) book.add(t, id, "hardware-table", RANK_HW_TABLE);
    }
    addWwwAliases(book, www, id);
  }

  // ── Standalone /hardware-only rows (accessories, legacy/EOL — no current matrix row) ──
  for (const page of sortedPages) {
    if ((effectiveMatches.get(page.slug) ?? []).length > 0) continue;
    const id = `hw-${page.slug}`;
    claimId(id);

    const ownFamily = identSlugs(page.slug, page.title);
    const www = findAgreeingWww([...page.productLinks, ...page.tableModelCodes], wwwByKey, ownFamily);
    recordWww(www);

    const meta = metaFor(page.tableModelCodes, [page.slug]);

    catalogRows.push({
      rosettaDeviceId: id,
      deviceId: null,
      name: www?.title || page.title,
      category: page.category,
      discontinued: www ? (www.discontinued ? 1 : 0) : null,
      specsJson: buildSpecsJson(www, page.title, meta),
      sourceHardwareSlug: page.slug,
      sourceWwwCode: www?.code ?? null,
    });

    book.add(page.slug, id, "hardware-slug", RANK_HW_SLUG);
    for (const t of page.productLinks) book.add(t, id, "hardware-link", RANK_HW_LINK);
    for (const t of page.tableModelCodes) book.add(t, id, "hardware-table", RANK_HW_TABLE);
    addWwwAliases(book, www, id);
  }

  const dropLedger = buildDropLedger(sortedPages, sortedMatrix, wwwProducts, effectiveMatches, attachedWwwCodes);

  return {
    catalogRows,
    aliasRows: book.rows(),
    unresolvedDevices,
    ambiguousTokens,
    dropLedger,
    aliasCollisions: book.collisions,
  };
}

/**
 * Account for every input entity: each www product / /hardware page / matrix row is
 * either attached to a catalog row or listed here with a reason. Zero silently lost.
 */
function buildDropLedger(
  pages: HardwarePage[],
  matrixRows: MatrixRow[],
  wwwProducts: WwwProduct[],
  effectiveMatches: Map<string, string[]>,
  attachedWwwCodes: Set<string>,
): DropEntry[] {
  const ledger: DropEntry[] = [];

  // Codes any device could reference — a www product referenced but not chosen was
  // rejected by the agreement gate (or lost an allowlisted multi-attach); one referenced
  // nowhere is simply an accessory/legacy product outside catalog scope.
  const referenced = new Set<string>();
  for (const p of pages) for (const c of [...p.productLinks, ...p.tableModelCodes]) referenced.add(normCode(c));
  for (const r of matrixRows) {
    referenced.add(normCode(r.code));
    for (const c of r.subCodes) referenced.add(normCode(c));
  }

  for (const p of wwwProducts) {
    const k = normCode(p.code);
    if (attachedWwwCodes.has(k)) continue;
    const referencedHere =
      referenced.has(k) ||
      referenced.has(normCode(p.specs["Product code"] ?? "")) ||
      referenced.has(normCode(p.compareId ?? ""));
    ledger.push({
      kind: "www-product",
      id: p.code,
      reason: referencedHere
        ? "referenced by a /hardware page or matrix row but not selected as spec source (identity disagreed, or lost an allowlisted multi-attach)"
        : "not referenced by any /hardware page or matrix row (accessory/legacy product outside catalog scope)",
    });
  }

  // Pages and matrix rows always land in a row today (matched -> matrix row; unmatched ->
  // standalone hw-* row; every matrix row is iterated), but assert it so a future change
  // that starts dropping them surfaces here instead of silently.
  const matrixNames = new Set(matrixRows.map((r) => r.name));
  const attachedNames = new Set<string>();
  for (const names of effectiveMatches.values()) for (const n of names) attachedNames.add(n);
  for (const p of pages) {
    const matched = (effectiveMatches.get(p.slug) ?? []).length > 0;
    // matched -> attributed to a matrix row; unmatched -> becomes hw-<slug>. Neither drops.
    if (!matched && !p.slug) ledger.push({ kind: "hardware-page", id: p.slug, reason: "empty slug" });
  }
  void matrixNames;
  void attachedNames;

  ledger.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return ledger;
}

// ── Hard output invariants (fail the run outright — not baseline-compared) ──

/**
 * The output-correctness gate. These are absolutes, checked against the built result on
 * every run: a violation means attribution regressed, so the run fails and the DB is not
 * written (independent of baseline drift). See the PR #36 review for why each exists.
 */
export function checkInvariants(result: BuildResult, wwwProducts: WwwProduct[]): string[] {
  const failures: string[] = [];
  const rowById = new Map(result.catalogRows.map((r) => [r.rosettaDeviceId, r]));
  const aliasesByDevice = new Map<string, Set<string>>();
  for (const a of result.aliasRows) {
    getOrInit(aliasesByDevice, a.rosettaDeviceId, () => new Set<string>()).add(a.alias);
  }

  // (1) A row's declared "Product code" must be among the row's own aliases — unless its
  //     spec source is an allowlisted shared product (whose code belongs to the base unit's
  //     own row, so it can't also be this row's unique alias).
  const declaredViolations: string[] = [];
  for (const row of result.catalogRows) {
    if (!row.specsJson || !row.sourceWwwCode) continue;
    if (SHARED_WWW_ALLOWLIST.has(normCode(row.sourceWwwCode))) continue;
    const declared = (JSON.parse(row.specsJson) as Record<string, string>)["Product code"];
    if (!declared) continue;
    const own = aliasesByDevice.get(row.rosettaDeviceId);
    if (!own?.has(normCode(declared))) declaredViolations.push(`${row.rosettaDeviceId} (declared ${declared})`);
  }
  if (declaredViolations.length > 0) {
    failures.push(`${declaredViolations.length} row(s) whose specs_json declared code is not among their own aliases: ${declaredViolations.slice(0, 10).join(", ")}`);
  }

  // (2) A www product attaches to at most one row, except the shared-kit allowlist.
  const attachCount = new Map<string, string[]>();
  for (const row of result.catalogRows) {
    if (!row.sourceWwwCode) continue;
    const k = normCode(row.sourceWwwCode);
    getOrInit(attachCount, k, () => []).push(row.rosettaDeviceId);
  }
  const multiAttach: string[] = [];
  for (const [code, rows] of attachCount) {
    if (rows.length > 1 && !SHARED_WWW_ALLOWLIST.has(code)) multiAttach.push(`${code} -> ${rows.join(", ")}`);
  }
  if (multiAttach.length > 0) {
    failures.push(`${multiAttach.length} www product(s) attached to >1 row outside the allowlist: ${multiAttach.slice(0, 10).join("; ")}`);
  }

  // (3) Accountability: every www product is either attached (source_www_code of some row)
  //     or in the drop ledger — disjoint and exhaustive, zero silently lost.
  const attached = new Set([...attachCount.keys()]);
  const dropped = new Set(result.dropLedger.filter((d) => d.kind === "www-product").map((d) => normCode(d.id)));
  const unaccounted: string[] = [];
  for (const p of wwwProducts) {
    const k = normCode(p.code);
    if (!attached.has(k) && !dropped.has(k)) unaccounted.push(p.code);
    if (attached.has(k) && dropped.has(k)) failures.push(`www product ${p.code} is both attached and in the drop ledger`);
  }
  if (unaccounted.length > 0) {
    failures.push(`${unaccounted.length} www product(s) neither attached nor in the drop ledger: ${unaccounted.slice(0, 10).join(", ")}`);
  }

  // (4) Every row has a non-empty name (no nameless rows).
  const nameless = result.catalogRows.filter((r) => !r.name).map((r) => r.rosettaDeviceId);
  if (nameless.length > 0) failures.push(`${nameless.length} row(s) with an empty name: ${nameless.slice(0, 10).join(", ")}`);

  void rowById;
  return failures;
}

// ── Validation / "when to fail" (softer input-drift + aggregate canaries) ──

export interface ValidationStats {
  categoryCount: number;
  uncategorizedPages: number;
  coreFieldFrequencyPct: Record<string, number>;
  matrixCoveragePct: number;
  www404RatePct: number;
  aliasCollisions: number;
  droppedWwwProducts: number;
  resolvedDeviceIds: string[];
}

const CORE_WWW_FIELDS = ["Product code", "CPU", "Architecture"];
const MATRIX_COVERAGE_FLOOR_PCT = 85; // B-0017: "drops below ~85% (today: 91%, 142/156)"
const WWW_404_SWING_TOLERANCE_PCT = 15;
const CORE_FIELD_DROP_TOLERANCE_PCT = 10;
const ALIAS_COLLISION_TOLERANCE = 5;
const DROPPED_WWW_TOLERANCE = 5;

export function computeValidationStats(hw: HardwareAssessment, www: WwwAssessment, result: BuildResult): ValidationStats {
  const wwwFoundCount = www.products.length;
  const coreFieldFrequencyPct: Record<string, number> = {};
  for (const field of CORE_WWW_FIELDS) {
    coreFieldFrequencyPct[field] = wwwFoundCount > 0 ? Math.round(((www.fieldFrequency[field] ?? 0) / wwwFoundCount) * 100) : 0;
  }

  const matched = hw.matchedByCode + hw.matchedByTable + hw.matchedBySlug;
  const matrixCoveragePct = hw.matrixRowCount > 0 ? Math.round((matched / hw.matrixRowCount) * 100) : 0;
  const www404RatePct = www.candidateCount > 0 ? Math.round((www.notFoundCount / www.candidateCount) * 100) : 0;

  const resolvedDeviceIds = result.catalogRows
    .filter((r) => r.deviceId !== null && (r.sourceHardwareSlug !== null || r.sourceWwwCode !== null))
    .map((r) => r.rosettaDeviceId)
    .sort();

  return {
    categoryCount: hw.categories.length,
    uncategorizedPages: hw.uncategorizedPages.length,
    coreFieldFrequencyPct,
    matrixCoveragePct,
    www404RatePct,
    aliasCollisions: result.aliasCollisions.length,
    droppedWwwProducts: result.dropLedger.filter((d) => d.kind === "www-product").length,
    resolvedDeviceIds,
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
  if (current.aliasCollisions > baseline.aliasCollisions + ALIAS_COLLISION_TOLERANCE) {
    failures.push(`alias collisions rose to ${current.aliasCollisions} (baseline ${baseline.aliasCollisions}, tolerance +${ALIAS_COLLISION_TOLERANCE}) — codes are being claimed by more devices`);
  }
  if (current.droppedWwwProducts > baseline.droppedWwwProducts + DROPPED_WWW_TOLERANCE) {
    failures.push(`dropped www products rose to ${current.droppedWwwProducts} (baseline ${baseline.droppedWwwProducts}, tolerance +${DROPPED_WWW_TOLERANCE}) — attachment regressed`);
  }
  const regressed = baseline.resolvedDeviceIds.filter((n) => !current.resolvedDeviceIds.includes(n));
  if (regressed.length > 0) {
    failures.push(`${regressed.length} previously-resolved device(s) no longer resolve: ${regressed.slice(0, 10).join(", ")}${regressed.length > 10 ? ", ..." : ""}`);
  }

  return failures;
}

// ── Serialization (the committed, diffable intermediate) ──

export function serializeCatalog(result: BuildResult, counts: SerializedCatalog["generatedFrom"]): SerializedCatalog {
  return {
    generatedFrom: counts,
    rows: [...result.catalogRows].sort((a, b) => a.rosettaDeviceId.localeCompare(b.rosettaDeviceId)),
    aliases: [...result.aliasRows].sort((a, b) => a.alias.localeCompare(b.alias) || a.rosettaDeviceId.localeCompare(b.rosettaDeviceId)),
    dropLedger: [...result.dropLedger].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)),
    aliasCollisions: [...result.aliasCollisions].sort((a, b) => a.alias.localeCompare(b.alias) || a.kept.localeCompare(b.kept)),
  };
}

// ── DB write (idempotent — delete then rebuild, per extractor-idempotent convention) ──

export function writeCatalog(catalog: SerializedCatalog): void {
  // Guard the AUTOINCREMENT link: device_id was captured fresh at build time from
  // devices.product_name (UNIQUE, rename-stable), but if extract-devices reran between
  // build and write the ids could be stale — fail loud rather than write a broken link.
  const liveDeviceIds = new Set(
    (db.prepare("SELECT id FROM devices").all() as Array<{ id: number }>).map((r) => r.id),
  );
  const stale = catalog.rows.filter((r) => r.deviceId !== null && !liveDeviceIds.has(r.deviceId));
  if (stale.length > 0) {
    throw new Error(
      `device_id link is stale for ${stale.length} row(s) (e.g. ${stale[0].rosettaDeviceId} -> ${stale[0].deviceId}) — ` +
        `re-run 'make extract-devices' then 'make extract-hardware-catalog' in that order`,
    );
  }

  const write = db.transaction(() => {
    db.run("DELETE FROM device_aliases");
    db.run("DELETE FROM hardware_catalog");

    const insertCatalog = db.prepare(`INSERT INTO hardware_catalog
      (rosetta_device_id, device_id, name, category, discontinued, specs_json, source_hardware_slug, source_www_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of catalog.rows) {
      insertCatalog.run(r.rosettaDeviceId, r.deviceId, r.name, r.category, r.discontinued, r.specsJson, r.sourceHardwareSlug, r.sourceWwwCode);
    }

    const insertAlias = db.prepare(`INSERT INTO device_aliases (alias, rosetta_device_id, source) VALUES (?, ?, ?)`);
    for (const a of catalog.aliases) {
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

  // Read devices WITHOUT initDb() — a real extract run only needs to read the (already
  // populated) devices table here; the DB must stay untouched on --check-only and on any
  // validation failure, so user_version/table stamping is deferred until just before the
  // write. extract-devices.ts must have run first (Makefile documents the ordering).
  const deviceRows = db.prepare("SELECT id, product_name FROM devices").all() as Array<{ id: number; product_name: string }>;
  const devicesByName = new Map(deviceRows.map((r) => [r.product_name, r.id]));

  const result = buildCatalog(matrixRows, devicesByName, hw.pages, www.products);
  const stats = computeValidationStats(hw, www, result);
  const catalog = serializeCatalog(result, {
    matrixRows: matrixRows.length,
    hardwarePages: hw.pages.length,
    wwwProducts: www.products.length,
  });

  // Always (re)write the diffable intermediate — its git diff is the change-review gate,
  // and regenerating it on --check-only is exactly how you inspect a proposed change.
  writeFileSync(CATALOG_JSON_PATH, `${JSON.stringify(catalog, null, 2)}\n`);

  console.log(`hardware_catalog rows: ${result.catalogRows.length} (${result.catalogRows.filter((r) => r.deviceId !== null).length} linked to devices)`);
  console.log(`device_aliases rows:   ${result.aliasRows.length}`);
  console.log(`alias collisions:      ${result.aliasCollisions.length}`);
  console.log(`drop ledger:           ${result.dropLedger.length} (${result.dropLedger.filter((d) => d.kind === "www-product").length} www products)`);
  if (result.unresolvedDevices.length > 0) {
    console.log(`WARNING: ${result.unresolvedDevices.length} matrix.csv row(s) not found in devices table (extract-devices.ts out of sync?): ${result.unresolvedDevices.join(", ")}`);
  }
  if (result.ambiguousTokens.length > 0) {
    console.log(`Ambiguous multi-match tokens skipped: ${result.ambiguousTokens.length} (series-page membership still unresolved — see B-0017 Track A Q4/Q5)`);
  }

  // Hard output invariants first — a violation is an attribution bug, fail regardless of baseline.
  const invariantFailures = checkInvariants(result, www.products);
  if (invariantFailures.length > 0) {
    console.error(`\n✗ Output invariants violated (${invariantFailures.length}) — DB not written:`);
    for (const f of invariantFailures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("✓ Output invariants hold.");

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

  // Only now, after every gate has passed, stamp the schema + create tables and write.
  initDb();
  setDbMeta("hardware_catalog_source", "manual.mikrotik.com/hardware + mikrotik.com/product (B-0017)");
  setDbMeta("hardware_catalog_built_at", new Date().toISOString());
  writeCatalog(catalog);

  console.log(`Wrote ${catalog.rows.length} hardware_catalog rows, ${catalog.aliases.length} device_aliases rows.`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
