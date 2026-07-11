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
import { loadSitemapUrls } from "./rosetta-id.ts";

const BASE = "https://manual.mikrotik.com";
const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_CACHE_DIR = resolve(PROJECT_ROOT, "manual", "pages", "hardware");
const DEFAULT_MATRIX_CSV = resolve(PROJECT_ROOT, "matrix", "2026-07-07", "matrix.csv");
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

interface MatrixRow {
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
function slugify(s: string): string {
  let out = s.replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => `-${DIGIT_SUPER_SUB[c] ?? c}`);
  out = out.replace(/\+/g, "-plus-").replace(/&/g, "-and-");
  out = out
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return out;
}

function loadMatrixRows(csvPath: string): MatrixRow[] {
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
function normCode(code: string): string {
  return code.trim().toLowerCase();
}

/** A www-style product link token ("cap_ac") normalized to the same slug space as slugify(). */
function normLinkToken(token: string): string {
  return slugify(token.replace(/_/g, "-"));
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

interface PageInfo {
  slug: string;
  url: string;
  title: string;
  wordCount: number;
  tableCount: number;
  headings: Array<{ level: number; text: string }>;
  productLinks: string[];
  nonDefaultIps: string[];
  isSeries: boolean;
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
  };
}

// ── Matrix cross-reference ──

type MatchCause = "matched-by-code" | "matched-by-slug" | "no-product-link" | "unmatched";

interface Classification {
  slug: string;
  cause: MatchCause;
  matchedMatrixNames: string[];
}

/**
 * Two-tier match: (1) exact product-code match via the page's `mikrotik.com/product/<x>`
 * link(s) against matrix.csv's Product code column — the reliable case (e.g. `RBcAP2nD`).
 * (2) slug fallback — some pages link to a www-style slug instead of the real code (e.g.
 * `cap_ac`, discovered live 2026-07-10), so also try slugify()-normalized comparison of
 * the link token, and the page's own /hardware slug, against matrix name/code slugs.
 * A page with zero product links and no slug hit is the strongest accessory/info-page
 * signal; a page with links that hit neither tier is the strongest legacy/EOL signal.
 */
function classify(page: PageInfo, matrixRows: MatrixRow[]): Classification {
  // A series page can cover several devices via a mix of mechanisms (one product link
  // resolves by exact code, a sibling link only resolves via the slug fallback) — union
  // both tiers per page rather than short-circuiting on the first hit. Found live via
  // rb1100-series: "RB1100Dx4" matches "RB1100AHx4 Dude Edition" by code, but the
  // sibling link "rb1100ahx4" only matches plain "RB1100AHx4" by slug — short-circuiting
  // on the code tier silently dropped the plain variant.
  const wanted = new Set(page.productLinks.map(normCode));
  const byCode = matrixRows.filter((r) => r.subCodes.some((c) => wanted.has(normCode(c))));

  const slugCandidates = new Set([page.slug, ...page.productLinks.map(normLinkToken)]);
  const bySlug = matrixRows.filter(
    (r) => slugCandidates.has(r.nameSlug) || r.codeSlugs.some((cs) => slugCandidates.has(cs)),
  );

  const matched = new Map<string, MatrixRow>();
  for (const r of byCode) matched.set(r.name, r);
  for (const r of bySlug) matched.set(r.name, r);

  if (matched.size > 0) {
    const cause: MatchCause = byCode.length > 0 ? "matched-by-code" : "matched-by-slug";
    return { slug: page.slug, cause, matchedMatrixNames: [...matched.values()].map((r) => r.name) };
  }

  if (page.productLinks.length === 0) {
    return { slug: page.slug, cause: "no-product-link", matchedMatrixNames: [] };
  }
  return { slug: page.slug, cause: "unmatched", matchedMatrixNames: [] };
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

  const classifications = pages.map((p) => classify(p, matrixRows));
  const byCause: Record<MatchCause, Classification[]> = {
    "matched-by-code": [],
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
  console.log(`\n--- Matrix cross-reference (product-code link, then slug fallback) ---`);
  console.log(`  matched-by-code (product-code link hits matrix.csv "Product code"): ${byCause["matched-by-code"].length}`);
  console.log(`  matched-by-slug (link/page slug hits matrix.csv name/code slug):    ${byCause["matched-by-slug"].length}`);
  console.log(`  unmatched (has product link(s), neither tier hit — legacy/EOL candidate): ${byCause.unmatched.length}`);
  console.log(`  no-product-link (no mikrotik.com/product link at all — accessory/info-page candidate): ${byCause["no-product-link"].length}`);
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

  // ── Write JSON summary (mirrors ros-html-assessment.json convention) ──
  const summary = {
    pageCount: pages.length,
    seriesPageCount: seriesPages.length,
    medianWordCount: median,
    matrixRowCount: matrixRows.length,
    matchedByCode: byCause["matched-by-code"].length,
    matchedBySlug: byCause["matched-by-slug"].length,
    unmatched: byCause.unmatched.length,
    noProductLink: byCause["no-product-link"].length,
    seriesWithMultipleMatches: seriesWithMultipleMatches.length,
    matrixRowsWithNoHardwarePage: matrixRowsWithNoHardwarePage.map((r) => r.name),
    headingFrequency: Object.fromEntries(sortedHeadings),
    pagesWithNonDefaultIp: pagesWithNonDefaultIp.map((p) => ({ slug: p.slug, ips: p.nonDefaultIps })),
    pages: pages.map((p) => {
      const c = classifications.find((cl) => cl.slug === p.slug);
      return {
        slug: p.slug,
        title: p.title,
        url: p.url,
        wordCount: p.wordCount,
        tableCount: p.tableCount,
        isSeries: p.isSeries,
        productLinks: p.productLinks,
        nonDefaultIps: p.nonDefaultIps,
        cause: c?.cause,
        matchedMatrixNames: c?.matchedMatrixNames ?? [],
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
