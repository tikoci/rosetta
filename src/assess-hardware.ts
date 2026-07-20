#!/usr/bin/env bun

/**
 * assess-hardware.ts — Structural census of manual.mikrotik.com's /hardware section.
 *
 * Companion to assess-html.ts (Confluence-era) — same "splunk the structure before
 * designing a schema" purpose, applied to the 240-page /hardware Docusaurus section
 * (briefings/B-0017-hardware-overlay-device-resolution.md, Track A). Unlike /docs,
 * /hardware/<slug>.md 404s live (confirmed 2026-07-10) — no raw-Markdown endpoint, so
 * this fetches rendered HTML and parses it with linkedom, the same approach
 * assess-html.ts uses for the legacy Confluence export.
 *
 * Key discovery this script exploits: each single-device page's "Specifications"
 * section links to `mikrotik.com/product/<code>` — the exact value in matrix.csv's
 * "Product code" column. That link is a far more reliable cross-reference than
 * fuzzy slug-matching (B-0017 Track A Q1/Q3). Series pages (slug ends `-series`,
 * e.g. `basebox-series` = BaseBox 2/5/6) carry zero-to-several such links — not
 * necessarily one per member device — so link count is a lower bound, not a count,
 * of a series page's device membership.
 *
 * Usage:
 *   bun run src/assess-hardware.ts                    # live fetch, caches HTML to CACHE_DIR
 *   bun run src/assess-hardware.ts --from-cache        # re-analyze from CACHE_DIR, no network
 *   bun run src/assess-hardware.ts --limit=25          # cap page count (smoke-testing)
 *   bun run src/assess-hardware.ts --matrix=path.csv   # override matrix.csv path
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseHTML } from "linkedom";
import { MATRIX_CSV_RELATIVE_PATH } from "./paths.ts";
import { loadSitemapUrls } from "./rosetta-id.ts";

const BASE = "https://manual.mikrotik.com";
const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_CACHE_DIR = resolve(PROJECT_ROOT, "manual", "pages", "hardware");
const DEFAULT_MATRIX_CSV = resolve(PROJECT_ROOT, MATRIX_CSV_RELATIVE_PATH);
const FETCH_DELAY_MS = 150;

// ── CLI flags ──

const argv = process.argv.slice(2);
const FROM_CACHE = argv.includes("--from-cache");
const limitArg = argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
const matrixArg = argv.find((a) => a.startsWith("--matrix="));
const MATRIX_CSV = matrixArg ? matrixArg.slice("--matrix=".length) : DEFAULT_MATRIX_CSV;

// ── matrix.csv loading (mirrors extract-devices.ts's parser) ──

const DIGIT_SUPER_SUB: Record<string, string> = {
  "⁰": "0", "¹": "1", "²": "2", "³": "3", "⁴": "4",
  "⁵": "5", "⁶": "6", "⁷": "7", "⁸": "8", "⁹": "9",
};

function normalizeSuperscripts(s: string): string {
  return s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => DIGIT_SUPER_SUB[c] ?? c);
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      i++;
      let value = "";
      while (i < line.length) {
        if (line[i] === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            value += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          value += line[i];
          i++;
        }
      }
      fields.push(value);
      if (i < line.length && line[i] === ",") i++;
    } else {
      const nextComma = line.indexOf(",", i);
      if (nextComma === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, nextComma));
      i = nextComma + 1;
    }
  }
  return fields;
}

export interface MatrixRow {
  name: string;
  code: string;
  /** Product codes are sometimes compound ("ATLGM&RG520F-EU" for a kit) — split for matching. */
  subCodes: string[];
  nameSlug: string;
  codeSlugs: string[];
}

/**
 * Slugify a product name/code the way manual.mikrotik.com's own slugs are built —
 * discovered empirically during the 2026-07-10 diff pass (B-0017 Track A): `+` becomes
 * `-plus-` (not stripped), and superscript digits become `-<digit>` (though that rule
 * is itself inconsistent live — `hap-ac-2` has the dash, `hap-ac3` doesn't — so this is
 * a heuristic fallback, not a guaranteed match).
 */
export function slugify(s: string): string {
  let out = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => `-${DIGIT_SUPER_SUB[c] ?? c}`);
  out = out.replace(/\+/g, "-plus-").replace(/&/g, "-and-");
  out = out
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return out;
}

export function loadMatrixRows(csvPath: string): MatrixRow[] {
  const raw = readFileSync(csvPath, "utf-8").replace(/^﻿/, "");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  const rows: MatrixRow[] = [];
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line);
    if (f.length < 2) continue;
    const name = normalizeSuperscripts(f[0].trim());
    const code = f[1].trim();
    if (!name) continue;
    const subCodes = code
      .split("&")
      .map((c) => c.trim())
      .filter(Boolean);
    rows.push({ name, code, subCodes, nameSlug: slugify(name), codeSlugs: subCodes.map(slugify) });
  }
  return rows;
}

/** Normalize a product code for case/variant-insensitive comparison. */
export function normCode(code: string): string {
  return code.trim().toLowerCase();
}

/**
 * Aggressive canonical form that collapses the whole naming-surface variance the
 * 2026-07-11 human review kept flagging as "declared code looks different — verify":
 * case, the `-`/`_`/space separators, and `+`<->`plus` / `&`<->`and`. One rule folds
 * `CCR2004-16G-2S+`, `ccr2004_16g_2splus`, and `CCR2004-16G-2SplusRM` onto the same
 * key. This is deliberately lossier than slugify() (which preserves separators as `-`);
 * slugify() stays for building/matching real URL slugs, canon() is only for identity
 * comparison across the three naming surfaces (matrix code, /hardware slug, www code).
 */
export function canon(s: string): string {
  return (s || "").toLowerCase().replace(/\+/g, "plus").replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
}

/**
 * canon() with a trailing hardware revision (`r2`, `r3`) or www order/packaging suffix
 * (`-307`, `-149`, `-168`) dropped — both are metadata, not device identity. The human
 * review confirmed these are the same device (`RBGroove52HPnr2` == `RBGroove52HPn`,
 * `RBcAPL-2nD-307` == `RBcAPL-2nD`). Kept as a *separate* looser key so a same-family
 * revision only matches when nothing exact does.
 *
 * Stripping happens on the ORIGINAL string (case + separators intact), NOT on canon()'s
 * lowercased/stripped output, so it only removes *true* metadata:
 *   - a revision suffix is a lowercase `r` + digits at the end (`...HPnr2`); MikroTik's
 *     model designators use an uppercase `R` (`R11e-LR8`, `-LR9`, `-LR2`), so those survive.
 *   - a packaging suffix is `-`/`_` + exactly three digits (`-307`); an inline model number
 *     like `RB750` has no separator before its digits, so it survives.
 * (Regression: the old form stripped `r\d+$`/`\d{3}$` from the lowercased string, collapsing
 * `R11e-LR8`/`-LR9`/`-LR2` all to `r11el` and `RB750` to `rb` — see PR #37 review.)
 */
export function canonNoRev(s: string): string {
  const stripped = (s || "").replace(/r\d+$/, "").replace(/[-_]\d{3}$/, "");
  return canon(stripped);
}

/** Both canonical forms for a string, empty forms dropped. */
export function canonForms(s: string): string[] {
  return [...new Set([canon(s), canonNoRev(s)].filter(Boolean))];
}

/**
 * Product-link tokens seen on /hardware pages that stand in for something *other* than
 * the page's own primary device — cross-sell/accessory links or broken links on
 * MikroTik's side (all confirmed in the 2026-07-11 human review): `qm_x` (appears on
 * several unrelated SXTsq/Cube pages), `acsmaufl`/`mant_lte_5o`/`acrpsma`/`lora_antenna_kit`
 * (antennas & pigtails linked from KNOT/Chateau/LtAP/NetBox device pages). Never treat
 * these as a device identity; they otherwise bind a device to an accessory's www page.
 */
export const BOGUS_PRODUCT_TOKENS = new Set([
  "qm_x",
  "acsmaufl",
  "mant_lte_5o",
  "acrpsma",
  "lora_antenna_kit",
]);

/** Is this product-link token a known accessory/broken stand-in rather than a device? */
export function isBogusProductToken(token: string): boolean {
  return BOGUS_PRODUCT_TOKENS.has(token.trim().toLowerCase());
}

// ── HTML fetching / caching ──

function cachePathFor(slug: string): string {
  return resolve(DEFAULT_CACHE_DIR, `${slug}.html`);
}

async function fetchHtml(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Page parsing ──

export interface PageInfo {
  slug: string;
  url: string;
  title: string;
  wordCount: number;
  tableCount: number;
  headings: Array<{ level: number; text: string }>;
  productLinks: string[];
  nonDefaultIps: string[];
  isSeries: boolean;
  /** Raw article text, kept for the cross-mention pass — not written to the JSON summary. */
  bodyText: string;
  /** Docusaurus sidebar category this page's own page belongs to (see extractSidebarCategory). */
  category: string | null;
  /** Full sibling membership of `category`, read off this same page's expanded sidebar subtree. */
  categoryMembers: string[];
  /** Product codes read from a table's "Model" column (see extractModelColumnCodes). */
  tableModelCodes: string[];
  /** Regulatory identifiers (FCC ID / IC / CE) per model, from Model-column tables. */
  regulatoryIds: RegulatoryId[];
}

/** A regulatory identifier tied to a specific product model on a /hardware page. */
export type RegulatoryType = "FCC ID" | "IC" | "CE";
export interface RegulatoryId {
  model: string;
  type: RegulatoryType;
  id: string;
}

/**
 * The value shape is a more reliable signal than a possibly-misaligned column header: on
 * several /hardware tables the FCC-ID and IC columns are swapped or share a mangled header,
 * so a header-classified "FCC ID" cell actually holds an IC value and vice-versa. MikroTik's
 * ISED Canada (IC) IDs are always "<numeric company number>-<product>" (7442A-…); their FCC
 * IDs are "<grantee code><product>" with grantee TV7 and no leading numeric-hyphen. CE marks
 * match neither, so they fall through to the header classification unchanged. Grounded in
 * ros-hardware-assessment.json: e.g. lhg-series "7442A-LHG2ND" (IC, header said FCC) and
 * ltap-mini-kit-series "TV7RB912R-2NDLTM" (FCC, header said IC).
 */
function canonicalizeRegulatoryType(headerType: RegulatoryType, id: string): RegulatoryType {
  if (/^\d+[A-Za-z]?-/.test(id)) return "IC";
  if (/^TV7/i.test(id)) return "FCC ID";
  return headerType;
}

/**
 * Docusaurus server-renders the *whole* sidebar on every page, but only auto-expands the
 * category containing the current page — every other category collapses to just its own
 * link, no children in the DOM. That means a single page's HTML only discloses its own
 * category's full membership, not the other 11. But since every page is a member of exactly
 * one category, and we cache all 239 pages, the union of each page's own expanded-category
 * block reconstructs the *complete* 12-category taxonomy with zero hand-curation — confirmed
 * live 2026-07-10: 239/239 pages resolve to exactly one of 12 categories (Switches, LTE
 * products, Ethernet routers, Wireless systems, Indoor wireless, IoT products, Accessories,
 * 60 GHz products, RouterBOARD, Data over Powerlines, Interfaces, Antennas), no leftovers.
 * This is MikroTik's own maintained product taxonomy, not a documentation-only artifact —
 * www.mikrotik.com's global nav groups products under matching category names.
 *
 * Category titles are HTML-attribute text, sometimes quoted ("60 GHz products", contains a
 * space) and sometimes bare (title=Switches, single word) — both forms must be matched.
 */
function extractSidebarCategory(html: string): { name: string; members: Array<{ slug: string; title: string }> } | null {
  const sidebarStart = html.indexOf("theme-doc-sidebar");
  if (sidebarStart === -1) return null;
  const sidebarEnd = html.indexOf("</nav>", sidebarStart);
  const sidebar = html.slice(sidebarStart, sidebarEnd === -1 ? undefined : sidebarEnd);

  const titleRe = 'title=(?:"([^"]*)"|([^ >]+))';
  const activeRe = new RegExp(`aria-expanded=true[^>]*href=([^ >]+)><span ${titleRe}`);
  const active = activeRe.exec(sidebar);
  if (!active) return null;
  const name = active[2] || active[3];

  const ulStart = sidebar.indexOf("<ul class=menu__list>", active.index + active[0].length);
  const ulEnd = sidebar.indexOf("</ul>", ulStart);
  if (ulStart === -1 || ulEnd === -1) return { name, members: [] };
  const membersHtml = sidebar.slice(ulStart, ulEnd);

  const memberRe = new RegExp(`href=([^ >]+)><span ${titleRe}`, "g");
  const members: Array<{ slug: string; title: string }> = [];
  for (const m of membersHtml.matchAll(memberRe)) {
    const slug = m[1].replace(/^\/hardware\//, "").replace(/\/$/, "");
    if (slug) members.push({ slug, title: m[2] || m[3] });
  }
  return { name, members };
}

function parsePage(slug: string, url: string, html: string): PageInfo {
  const { document } = parseHTML(html);
  const article = document.querySelector("article") ?? document.body;

  const h1 = article?.querySelector("h1");
  const title = h1?.textContent?.trim() || slug;

  const headings: Array<{ level: number; text: string }> = [];
  for (const el of article?.querySelectorAll("h1, h2, h3") ?? []) {
    const level = Number(el.tagName.slice(1));
    const text = el.textContent?.replace(/​/g, "").trim() || "";
    if (level > 1 && text) headings.push({ level, text });
  }

  const text = article?.textContent || "";
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const tableCount = article?.querySelectorAll("table").length ?? 0;

  const productLinks = new Set<string>();
  for (const a of article?.querySelectorAll("a[href*='mikrotik.com/product/']") ?? []) {
    const href = a.getAttribute("href") || "";
    const m = href.match(/mikrotik\.com\/product\/([^/?#]+)/);
    if (m) productLinks.add(decodeURIComponent(m[1]));
  }

  const ipMatches = text.match(/192\.168\.\d{1,3}\.\d{1,3}/g) ?? [];
  const nonDefaultIps = [...new Set(ipMatches)].filter((ip) => ip !== "192.168.88.1");

  const categoryInfo = extractSidebarCategory(html);
  const tableModelCodes = extractModelColumnCodes(article);
  const regulatoryIds = extractRegulatoryIds(article);

  return {
    slug,
    url,
    title,
    wordCount,
    tableCount,
    headings,
    productLinks: [...productLinks],
    nonDefaultIps,
    isSeries: slug.endsWith("-series"),
    bodyText: text,
    category: categoryInfo?.name ?? null,
    categoryMembers: categoryInfo?.members.map((m) => m.slug) ?? [],
    tableModelCodes,
    regulatoryIds,
  };
}

/** Leading FCC ID / IC / CE label of a regulatory table's non-model column header. */
function classifyRegulatoryColumn(header: string): RegulatoryType | null {
  const h = header.trim();
  if (/^fcc\s*id/i.test(h)) return "FCC ID";
  if (/^ic\b/i.test(h) || /^ic[A-Z0-9]/.test(h)) return "IC";
  if (/^ce\b/i.test(h) || /^ce[A-Z0-9]/.test(h)) return "CE";
  return null;
}

/**
 * The same Model-column regulatory tables extractModelColumnCodes() reads for matching
 * also carry FCC ID / IC / CE columns, one identifier per model row. Issue #35 asked
 * whether those regulatory IDs could serve as device identity; capturing them here lets
 * extract-hardware-catalog.ts land them on catalog rows and answer that with counts
 * instead of discarding them. Model + id-type are read from the header; the id is the
 * clean cell value (the header cell text is DOM-mangled, but tbody cells are clean).
 */
function extractRegulatoryIds(article: Element | null): RegulatoryId[] {
  const out: RegulatoryId[] = [];
  for (const table of article?.querySelectorAll("table") ?? []) {
    const headerRow = table.querySelector("thead tr") ?? table.querySelector("tr");
    if (!headerRow) continue;
    const headers = [...headerRow.children].map((c) => c.textContent?.trim() ?? "");
    const modelIdx = headers.findIndex((h) => h.toLowerCase() === "model" || /^model[A-Z0-9]/.test(h));
    if (modelIdx === -1) continue;
    const idCols = headers
      .map((h, i) => ({ i, type: i === modelIdx ? null : classifyRegulatoryColumn(h) }))
      .filter((c): c is { i: number; type: RegulatoryType } => c.type !== null);
    if (idCols.length === 0) continue;
    for (const row of table.querySelector("tbody")?.children ?? []) {
      const cells = [...row.children].map((c) => c.textContent?.trim() ?? "");
      const model = cells[modelIdx];
      if (!model || model === "-") continue;
      for (const col of idCols) {
        const id = cells[col.i];
        if (id && id !== "-" && id.toLowerCase() !== "none") {
          out.push({ model, type: canonicalizeRegulatoryType(col.type, id), id });
        }
      }
    }
  }
  return out;
}

/**
 * Some regulatory tables (FCC ID, IC) on series/kit pages carry an explicit "Model" column
 * enumerating every device model the declaration covers — a structured, high-confidence
 * signal distinct from the free-text cross-mention pass. Found live 2026-07-10 while
 * investigating the 10 linkless series pages: `sxtsa-series`'s FCC ID table's Model column
 * (`RBSXTG-5HPnD-SAr2`, `RBSXTG-5HPacD-SAr2`) resolves `SXT SA5 ac`, a matrix.csv row the
 * link-based two-tier match couldn't reach at all (that page carries zero product links).
 * Not every series page has such a table (`wap-series`, `crs-series`, `mant-series`, and
 * others have only frequency/power tables with no Model column, or no tables at all) — this
 * closes part of the linkless-series gap, not all of it.
 */
function extractModelColumnCodes(article: Element | null): string[] {
  const codes = new Set<string>();
  for (const table of article?.querySelectorAll("table") ?? []) {
    const headerRow = table.querySelector("thead tr") ?? table.querySelector("tr");
    if (!headerRow) continue;
    const headers = [...headerRow.children].map((c) => c.textContent?.trim().toLowerCase() ?? "");
    const modelIdx = headers.indexOf("model");
    if (modelIdx === -1) continue;
    const bodyRows = table.querySelector("tbody")?.children ?? [];
    for (const row of bodyRows) {
      const cells = [...row.children];
      const val = cells[modelIdx]?.textContent?.trim();
      if (val && val !== "-" && val.toLowerCase() !== "none") codes.add(val);
    }
  }
  return [...codes];
}

// ── Cross-mention pass (body-text scan, no new network calls) ──

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does this page's prose mention a matrix.csv product code that isn't already captured
 * as a `mikrotik.com/product/` link? Primary payoff: 10 of 30 series pages carry zero
 * product links at all (B-0017 Track A, 2026-07-10 exhaustive pass) — their member
 * devices, if named at all, are named in prose/tables instead. Codes under 4 chars are
 * skipped as too prone to false-positive substring hits in generic text.
 */
function findMentionedCodes(bodyText: string, allCodes: string[], exclude: Set<string>): string[] {
  const found = new Set<string>();
  for (const code of allCodes) {
    if (code.length < 4 || exclude.has(normCode(code))) continue;
    const re = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(code)}(?![A-Za-z0-9])`, "i");
    if (re.test(bodyText)) found.add(code);
  }
  return [...found];
}

const LIFECYCLE_KEYWORDS = /\b(replac(?:es|ed|ing|ement)|successor|discontinued|end.of.life)\b/i;

// ── Matrix cross-reference ──

/**
 * Canonical subcodes that appear (as an `&`-split component) in more than one matrix row —
 * i.e. shared bases/modules that don't identify a single device. Excluded from code/table
 * matching so a shared base like `D53G-5HacD2HnD-TC` (Chateau LTE6-US + LTE12) or a shared
 * module like `R11e-LTE7` (every LTE7 kit) doesn't bind all its siblings to one page.
 */
export function computeSharedSubCodes(matrixRows: MatrixRow[]): Set<string> {
  const rowsPerCanon = new Map<string, Set<string>>();
  for (const r of matrixRows) {
    for (const sc of r.subCodes) {
      const c = canon(sc);
      if (!c) continue;
      const names = rowsPerCanon.get(c) ?? new Set<string>();
      names.add(r.name);
      rowsPerCanon.set(c, names);
    }
  }
  return new Set([...rowsPerCanon].filter(([, rows]) => rows.size > 1).map(([c]) => c));
}

type MatchCause = "matched-by-code" | "matched-by-table" | "matched-by-slug" | "no-product-link" | "unmatched";

interface Classification {
  slug: string;
  cause: MatchCause;
  matchedMatrixNames: string[];
  /** Rows this page claims *only* via its regulatory-table Model column (weak). main()
   *  suppresses these when another page claims the same row by code/slug. */
  tableOnlyNames: string[];
}

/**
 * Match a page's product-link/table/slug identities against matrix.csv rows, canonically.
 *
 * Three tiers, in *precedence* order (2026-07-11 human review corrected the old ordering):
 *   (1) matched-by-code — an exact product-code via the page's `mikrotik.com/product/<x>`
 *       link (e.g. `RBcAP2nD`). High precision: a link token equal to a matrix Product code.
 *   (2) matched-by-slug — the page's *own* `/hardware/<slug>`, or a www-style link token
 *       (e.g. `cap_ac`), canonically equals a matrix name/code. This now includes the FULL
 *       compound code slug (`ATLGM&EG18-EA` -> canon `atlgmandeg18ea`, page `atlgm-and-eg18-ea`);
 *       the old code split on `&` first and never tried the whole thing, silently missing it.
 *   (3) matched-by-table — a regulatory FCC/IC "Model" column entry (see extractModelColumnCodes).
 *       DEMOTED below slug: a Model column lists *every covered variant*, so on a multi-variant
 *       page like `chateau-lte6-us` it otherwise binds every Chateau LTE to that one page. It is
 *       now a last resort, used only when the device has no page of its own (see the cross-page
 *       suppression in main()).
 *
 * All comparison is via canon()/canonNoRev() rather than normCode()/slugify() literal equality,
 * collapsing the `+`/`plus`/`_`/`-`/case/`rN` variance the review flagged 64× as "looks different".
 * Bogus accessory/broken link tokens (see BOGUS_PRODUCT_TOKENS) are dropped before matching.
 */
export function classify(page: PageInfo, matrixRows: MatrixRow[], sharedSubCodes: Set<string>): Classification {
  const usableLinks = page.productLinks.filter((l) => !isBogusProductToken(l));

  // A matrix row's canonical CODE identity: the full compound code, plus each `&`-split
  // subcode EXCEPT ones shared across multiple rows. A shared base like `D53G-5HacD2HnD-TC`
  // (in both Chateau LTE6-US and LTE12) doesn't identify a device — the `&EG06-A` vs
  // `&EG120K-EA` module suffix is the discriminator — so matching the bare base binds every
  // sibling LTE variant (the "Chateau LTE12 falls back to lte6-us" bug). Its own-name slug
  // is what actually tells the variants apart, so name is in the slug tier, not here.
  const uniqueSubForms = (r: MatrixRow) =>
    r.subCodes.filter((sc) => !sharedSubCodes.has(canon(sc))).flatMap(canonForms);
  const rowCodeForms = (r: MatrixRow) => new Set([...canonForms(r.code), ...uniqueSubForms(r)]);
  const rowSlugForms = (r: MatrixRow) =>
    new Set([...canonForms(r.code), ...canonForms(r.name), ...uniqueSubForms(r)]);

  // Page code/table/slug identities: canon of the FULL token — do NOT split on `&`, which
  // would reintroduce shared-base over-matching from the page side (a page's table lists the
  // full `D53G-5HacD2HnD-TC&EG06-A`, which must match only LTE6-US's full code, not LTE12's).
  // The page's OWN slug is kept separate from its www-style link tokens: the slug is the page's
  // filename and can canon-collide with an unrelated variant, whereas an explicit product link
  // is a corroborated self-identification.
  const linkForms = new Set(usableLinks.flatMap(canonForms));
  const tableForms = new Set(page.tableModelCodes.flatMap(canonForms));
  const ownSlugForms = new Set(canonForms(page.slug));
  const titleForms = new Set(canonForms(page.title));

  // Tier 1: exact product-code link.
  const byCode = matrixRows.filter((r) => [...rowCodeForms(r)].some((f) => linkForms.has(f)));

  // Tier 3: regulatory-table Model column (WEAK — covers, not identifies).
  const byTable = matrixRows.filter((r) => [...rowCodeForms(r)].some((f) => tableForms.has(f)));

  // Tier 2 (slug), split by evidence strength:
  //   byLinkSlug — a www-style LINK token canonically equals a row name/code (corroborated).
  //   byOwnSlug  — the page's OWN /hardware slug canonically equals a row name/code.
  const byLinkSlug = matrixRows.filter((r) => [...rowSlugForms(r)].some((f) => linkForms.has(f)));
  const byOwnSlug = matrixRows.filter((r) => [...rowSlugForms(r)].some((f) => ownSlugForms.has(f)));

  // A row named by an explicit token (code/link/table) is corroborated. A bare own-slug hit that
  // names a DIFFERENT device than the corroborated set is a canon slug collision — e.g.
  // /hardware/hap-ax-2 is titled "hAP ax³" and links hap_ax3, but its slug canon-equals the
  // matrix name "hAP ax2", so it wrongly claimed BOTH (PR #37 review, assess-hardware.ts:457).
  // Keep an own-slug hit only when it is corroborated, OR the page has no corroborated match at
  // all (its slug is the sole identity — many device pages carry no product link), OR the page
  // TITLE agrees with it. The title clause is essential when a page's product link is wrong:
  // /hardware/hap-ac-lite-tc is titled "hAP ac lite TC" and its slug matches that device, but its
  // link points at the non-TC RB952Ui-5ac2nD — without the title check the correct TC match would
  // be dropped as a "collision" against the mislinked non-TC device.
  const corroborated = new Set([...byCode, ...byLinkSlug, ...byTable].map((r) => r.name));
  const titleAgrees = (r: MatrixRow) => [...rowSlugForms(r)].some((f) => titleForms.has(f));
  const bySlug = [
    ...byLinkSlug,
    ...byOwnSlug.filter((r) => corroborated.size === 0 || corroborated.has(r.name) || titleAgrees(r)),
  ];

  // Union all tiers (a series page covers several devices via a mix of mechanisms), but the
  // reported `cause` reflects the STRONGEST tier that hit — code > slug > table.
  const matched = new Map<string, MatrixRow>();
  for (const r of byTable) matched.set(r.name, r);
  for (const r of bySlug) matched.set(r.name, r);
  for (const r of byCode) matched.set(r.name, r);

  if (matched.size > 0) {
    const cause: MatchCause =
      byCode.length > 0 ? "matched-by-code" : bySlug.length > 0 ? "matched-by-slug" : "matched-by-table";
    // Track table-only claims separately so main() can suppress them when a device is
    // claimed more strongly by another page (the Chateau-LTE7-bound-to-lte6-us bug).
    const tableOnly = byTable
      .filter((r) => !byCode.includes(r) && !bySlug.includes(r))
      .map((r) => r.name);
    return { slug: page.slug, cause, matchedMatrixNames: [...matched.values()].map((r) => r.name), tableOnlyNames: tableOnly };
  }

  if (usableLinks.length === 0 && page.tableModelCodes.length === 0) {
    return { slug: page.slug, cause: "no-product-link", matchedMatrixNames: [], tableOnlyNames: [] };
  }
  return { slug: page.slug, cause: "unmatched", matchedMatrixNames: [], tableOnlyNames: [] };
}

// ── Main ──

async function main() {
  console.log(FROM_CACHE ? `Discovering pages from cache: ${DEFAULT_CACHE_DIR}` : `Discovering pages from sitemap: ${BASE}/sitemap.xml`);

  let slugToUrl: Map<string, string>;
  if (FROM_CACHE) {
    if (!existsSync(DEFAULT_CACHE_DIR)) throw new Error(`Cache dir missing: ${DEFAULT_CACHE_DIR}`);
    const files = readdirSync(DEFAULT_CACHE_DIR).filter((f) => f.endsWith(".html"));
    slugToUrl = new Map(files.map((f) => {
      const slug = f.slice(0, -".html".length);
      return [slug, `${BASE}/hardware/${slug}`];
    }));
  } else {
    const sitemapUrls = await loadSitemapUrls();
    slugToUrl = new Map();
    for (const u of sitemapUrls) {
      const path = new URL(u).pathname.replace(/^\/+|\/+$/g, "");
      if (!path.startsWith("hardware/")) continue;
      const slug = path.slice("hardware/".length);
      if (!slug) continue; // bare /hardware/ index route
      slugToUrl.set(slug, u);
    }
  }

  let slugs = [...slugToUrl.keys()].sort();
  if (LIMIT) slugs = slugs.slice(0, LIMIT);
  console.log(`Pages in scope: ${slugs.length}`);

  mkdirSync(DEFAULT_CACHE_DIR, { recursive: true });

  const pages: PageInfo[] = [];
  let fetchErrors = 0;

  for (const slug of slugs) {
    const url = slugToUrl.get(slug) ?? `${BASE}/hardware/${slug}`;
    const cacheFile = cachePathFor(slug);
    let html: string;

    if (FROM_CACHE) {
      html = readFileSync(cacheFile, "utf-8");
    } else {
      try {
        html = await fetchHtml(url);
        writeFileSync(cacheFile, html);
        await delay(FETCH_DELAY_MS);
      } catch (e) {
        console.log(`  ERROR: ${url}: ${e}`);
        fetchErrors++;
        continue;
      }
    }

    pages.push(parsePage(slug, url, html));
  }

  console.log(`Fetched/read: ${pages.length}, errors: ${fetchErrors}`);

  // ── Cross-reference against matrix.csv ──
  const matrixRows = loadMatrixRows(MATRIX_CSV);
  console.log(`Matrix rows loaded: ${matrixRows.length} (from ${MATRIX_CSV})`);

  const sharedSubCodes = computeSharedSubCodes(matrixRows);
  const classifications = pages.map((p) => classify(p, matrixRows, sharedSubCodes));

  // Cross-page table-suppression: a regulatory-table Model column enumerates every device a
  // declaration COVERS, not the page's own subject — so `chateau-lte6-us`'s table lists LTE7,
  // LTE12, … and would bind them all to that one page. Drop a page's table-only claim on any
  // row that some *other* page claims more strongly (by code or own slug). Confirmed via the
  // human review flagging "Chateau LTE7 WRONG … falls back to lte6-us".
  const stronglyClaimed = new Set<string>();
  for (const c of classifications) {
    for (const name of c.matchedMatrixNames) {
      if (!c.tableOnlyNames.includes(name)) stronglyClaimed.add(name);
    }
  }
  for (const c of classifications) {
    if (c.tableOnlyNames.length === 0) continue;
    c.matchedMatrixNames = c.matchedMatrixNames.filter(
      (name) => !(c.tableOnlyNames.includes(name) && stronglyClaimed.has(name)),
    );
    // Suppression can empty a page whose only claim was table-only; its "matched-by-table"
    // cause is then stale (a matched-by-table with zero names). Downgrade to unmatched so the
    // cause always reflects the surviving matches (PR #37 review, assess-hardware.ts:567).
    if (c.matchedMatrixNames.length === 0 && c.cause === "matched-by-table") {
      c.cause = "unmatched";
    }
  }

  const byCause: Record<MatchCause, Classification[]> = {
    "matched-by-code": [],
    "matched-by-table": [],
    "matched-by-slug": [],
    "no-product-link": [],
    unmatched: [],
  };
  for (const c of classifications) byCause[c.cause].push(c);

  const seriesPages = pages.filter((p) => p.isSeries);
  const seriesWithMultipleMatches = classifications.filter(
    (c) => c.slug.endsWith("-series") && c.matchedMatrixNames.length > 1,
  );

  const matchedMatrixNames = new Set(classifications.flatMap((c) => c.matchedMatrixNames));
  const matrixRowsWithNoHardwarePage = matrixRows.filter((r) => !matchedMatrixNames.has(r.name));

  // ── Cross-mention pass: body-text scan for codes not already linked ──
  const allCodes = [...new Set(matrixRows.flatMap((r) => r.subCodes))];
  const codeToRow = new Map<string, MatrixRow>();
  for (const r of matrixRows) for (const c of r.subCodes) codeToRow.set(normCode(c), r);

  const mentionedBySlug = new Map<string, { codes: string[]; names: string[] }>();
  for (const p of pages) {
    const linked = new Set(p.productLinks.map(normCode));
    const codes = findMentionedCodes(p.bodyText, allCodes, linked);
    if (codes.length === 0) continue;
    const names = [...new Set(codes.map((c) => codeToRow.get(normCode(c))?.name).filter((n): n is string => !!n))];
    mentionedBySlug.set(p.slug, { codes, names });
  }

  const linklessSeries = seriesPages.filter((p) => p.productLinks.length === 0);
  const linklessSeriesInferred = linklessSeries.map((p) => ({
    slug: p.slug,
    inferredMatrixNames: mentionedBySlug.get(p.slug)?.names ?? [],
  }));

  const lifecyclePages = pages.filter((p) => LIFECYCLE_KEYWORDS.test(p.bodyText));

  // ── Sidebar category taxonomy (union of each page's own expanded-category block) ──
  const categories = new Map<string, Set<string>>();
  const uncategorizedPages: string[] = [];
  for (const p of pages) {
    if (!p.category) {
      uncategorizedPages.push(p.slug);
      continue;
    }
    const set = categories.get(p.category) ?? new Set<string>();
    for (const m of p.categoryMembers) set.add(m);
    set.add(p.slug);
    categories.set(p.category, set);
  }
  const categorySummary = [...categories.entries()]
    .map(([name, members]) => ({ name, memberCount: members.size, members: [...members].sort() }))
    .sort((a, b) => b.memberCount - a.memberCount);

  // ── Heading frequency (boilerplate detection) ──
  const headingFreq: Record<string, number> = {};
  for (const p of pages) {
    for (const h of p.headings) {
      if (h.level !== 2) continue; // top-level sections are the boilerplate signal
      headingFreq[h.text] = (headingFreq[h.text] || 0) + 1;
    }
  }
  const sortedHeadings = Object.entries(headingFreq).sort(([, a], [, b]) => b - a);

  const pagesWithNonDefaultIp = pages.filter((p) => p.nonDefaultIps.length > 0);
  const wordCounts = pages.map((p) => p.wordCount).sort((a, b) => a - b);
  const median = wordCounts[Math.floor(wordCounts.length / 2)] ?? 0;

  // ── Console report ──
  console.log("\n=== /hardware Structural Assessment ===\n");
  console.log(`Pages:                    ${pages.length}`);
  console.log(`Series pages (-series):   ${seriesPages.length}`);
  console.log(`Median word count:        ${median}`);
  console.log(`Pages w/ non-default IP:  ${pagesWithNonDefaultIp.length}`);
  console.log(`\n--- Matrix cross-reference (product-code link, then Model-column table, then slug fallback) ---`);
  console.log(`  matched-by-code (product-code link hits matrix.csv "Product code"): ${byCause["matched-by-code"].length}`);
  console.log(`  matched-by-table (table Model-column code hits matrix.csv "Product code"): ${byCause["matched-by-table"].length}`);
  console.log(`  matched-by-slug (link/page slug hits matrix.csv name/code slug):    ${byCause["matched-by-slug"].length}`);
  console.log(`  unmatched (has product link(s)/table code(s), no tier hit — legacy/EOL candidate): ${byCause.unmatched.length}`);
  console.log(`  no-product-link (no mikrotik.com/product link or Model-column table — accessory/info-page candidate): ${byCause["no-product-link"].length}`);
  console.log(`  series pages resolving >1 matrix row: ${seriesWithMultipleMatches.length}`);
  console.log(`\nmatrix.csv rows with NO /hardware page match at all: ${matrixRowsWithNoHardwarePage.length}`);
  if (matrixRowsWithNoHardwarePage.length > 0) {
    console.log(`  ${matrixRowsWithNoHardwarePage.map((r) => r.name).join(", ")}`);
  }

  console.log(`\n--- "no-product-link" pages (sample, candidate accessories/info-pages) ---`);
  for (const c of byCause["no-product-link"].slice(0, 30)) {
    const p = pages.find((pg) => pg.slug === c.slug);
    console.log(`  ${c.slug} — "${p?.title}" (${p?.wordCount} words, series=${p?.isSeries})`);
  }

  console.log(`\n--- "unmatched" pages (sample, candidate legacy/EOL devices) ---`);
  for (const c of byCause.unmatched.slice(0, 30)) {
    const p = pages.find((pg) => pg.slug === c.slug);
    console.log(`  ${c.slug} — "${p?.title}" — links: ${p?.productLinks.join(", ")}`);
  }

  console.log(`\n--- Top 25 h2 section headings (boilerplate-frequency signal) ---`);
  for (const [heading, count] of sortedHeadings.slice(0, 25)) {
    console.log(`  [${count}x] ${heading}`);
  }

  console.log(`\n--- Pages with non-default management IP ---`);
  for (const p of pagesWithNonDefaultIp) {
    console.log(`  ${p.slug} — ${p.nonDefaultIps.join(", ")}`);
  }

  console.log(`\n--- Sidebar category taxonomy (${categorySummary.length} categories, ${uncategorizedPages.length} uncategorized pages) ---`);
  for (const c of categorySummary) {
    console.log(`  ${c.name}: ${c.memberCount} members`);
  }
  if (uncategorizedPages.length > 0) {
    console.log(`  uncategorized: ${uncategorizedPages.join(", ")}`);
  }

  console.log(`\n--- Linkless series pages (0 product links) — inferred members via body-text mention ---`);
  for (const s of linklessSeriesInferred) {
    console.log(`  ${s.slug} — inferred: ${s.inferredMatrixNames.join(", ") || "(none found)"}`);
  }

  console.log(`\n--- Pages mentioning replacement/lifecycle keywords (replaces/successor/discontinued): ${lifecyclePages.length} ---`);
  for (const p of lifecyclePages.slice(0, 30)) {
    console.log(`  ${p.slug}`);
  }

  // ── Write JSON summary (mirrors ros-html-assessment.json convention) ──
  const summary = {
    pageCount: pages.length,
    seriesPageCount: seriesPages.length,
    medianWordCount: median,
    matrixRowCount: matrixRows.length,
    matchedByCode: byCause["matched-by-code"].length,
    matchedByTable: byCause["matched-by-table"].length,
    matchedBySlug: byCause["matched-by-slug"].length,
    unmatched: byCause.unmatched.length,
    noProductLink: byCause["no-product-link"].length,
    seriesWithMultipleMatches: seriesWithMultipleMatches.length,
    matrixRowsWithNoHardwarePage: matrixRowsWithNoHardwarePage.map((r) => r.name),
    headingFrequency: Object.fromEntries(sortedHeadings),
    pagesWithNonDefaultIp: pagesWithNonDefaultIp.map((p) => ({ slug: p.slug, ips: p.nonDefaultIps })),
    linklessSeriesInferredMembers: linklessSeriesInferred,
    lifecycleKeywordPages: lifecyclePages.map((p) => p.slug),
    categories: categorySummary,
    uncategorizedPages,
    pages: pages.map((p) => {
      const c = classifications.find((cl) => cl.slug === p.slug);
      const mention = mentionedBySlug.get(p.slug);
      return {
        slug: p.slug,
        title: p.title,
        url: p.url,
        wordCount: p.wordCount,
        tableCount: p.tableCount,
        isSeries: p.isSeries,
        productLinks: p.productLinks,
        tableModelCodes: p.tableModelCodes,
        regulatoryIds: p.regulatoryIds,
        nonDefaultIps: p.nonDefaultIps,
        category: p.category,
        cause: c?.cause,
        matchedMatrixNames: c?.matchedMatrixNames ?? [],
        // Cross-mention pass (2026-07-10): codes/names found in body prose that aren't
        // already captured as a product link — a weaker, unlinked signal kept separate
        // from matchedMatrixNames rather than merged into it (B-0017 "no surprises" ask).
        mentionedCodes: mention?.codes ?? [],
        inferredMatrixNames: mention?.names ?? [],
        mentionsLifecycleKeyword: LIFECYCLE_KEYWORDS.test(p.bodyText),
      };
    }),
  };

  const outPath = resolve(PROJECT_ROOT, "ros-hardware-assessment.json");
  await Bun.write(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nFull assessment written to ${outPath}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
