#!/usr/bin/env bun

/**
 * assess-www.ts — Structural census of mikrotik.com/product/<code> spec pages.
 *
 * Companion to assess-hardware.ts (B-0017 Track A). Where /hardware pages turned out to
 * be thin install/compliance manuals — 106 of 239 have zero <table> elements, and a
 * single-device page's own "Specifications" section is usually just a sentence linking
 * out to mikrotik.com/product/<code> rather than carrying spec data itself — the www
 * product page is where the actual structured spec fields live (CPU, switch chip, RAM,
 * PoE, certification, ~20-40 key/value pairs per page, confirmed live 2026-07-10).
 *
 * This matters beyond the 156 current matrix.csv rows: /hardware pages surfaced 234
 * distinct mikrotik.com/product/ link tokens, many for devices matrix.csv doesn't carry
 * at all (legacy/EOL candidates). This script fetches the union of matrix.csv codes and
 * every /hardware page's product-link token, so the resulting JSON also documents what
 * fields exist for those non-matrix devices — grounding for whether/how they'd extend a
 * future devices schema, not just the currently-tracked ones.
 *
 * Candidate codes come from ros-hardware-assessment.json (run assess-hardware.ts first)
 * plus matrix.csv directly. Product-code casing/spelling used is whatever a /hardware
 * page already linked (known-good); matrix-only codes containing "+" are also retried
 * with "plus" substituted, mirroring the spelled-out form /hardware pages use in links
 * (e.g. "CCR1009-7G-1C-1S+" -> "CCR1009-7G-1C-1Splus") — some matrix-only "+" codes may
 * still 404 under this heuristic; that's recorded as notFound, not silently dropped.
 *
 * Usage:
 *   bun run src/assess-www.ts                    # live fetch, caches HTML to CACHE_DIR
 *   bun run src/assess-www.ts --from-cache        # re-analyze from CACHE_DIR, no network
 *   bun run src/assess-www.ts --limit=25          # cap candidate count (smoke-testing)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseHTML } from "linkedom";
import { loadMatrixRows, normCode } from "./assess-hardware.ts";
import { curatedWwwCodes } from "./hardware-www-map.ts";

const PROJECT_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_CACHE_DIR = resolve(PROJECT_ROOT, "manual", "pages", "www");
const DEFAULT_MATRIX_CSV = resolve(PROJECT_ROOT, "matrix", "2026-07-07", "matrix.csv");
const HARDWARE_ASSESSMENT = resolve(PROJECT_ROOT, "ros-hardware-assessment.json");
const FETCH_DELAY_MS = 150;

// ── CLI flags ──

const argv = process.argv.slice(2);
const FROM_CACHE = argv.includes("--from-cache");
const limitArg = argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;

// ── Candidate code discovery ──

function loadCandidateCodes(): string[] {
  const codes = new Set<string>();
  const matrixRows = loadMatrixRows(DEFAULT_MATRIX_CSV);
  for (const r of matrixRows) {
    for (const c of r.subCodes) {
      codes.add(c);
      if (c.includes("+")) codes.add(c.replace(/\+/g, "plus"));
    }
  }
  if (existsSync(HARDWARE_ASSESSMENT)) {
    const hw = JSON.parse(readFileSync(HARDWARE_ASSESSMENT, "utf-8")) as {
      pages: Array<{ productLinks: string[] }>;
    };
    for (const p of hw.pages) for (const link of p.productLinks) codes.add(link);
  }
  // Curated backfill (hardware-www-map.toml): off-matrix product codes a maintainer
  // vouched for that neither matrix.csv nor any /hardware page links directly (e.g.
  // sxt-2 -> RBSXTG-2HnDr2-168). Without this seed the page never gets fetched and its specs
  // stay blank. Series members (www_codes) are seeded too so their specs land as well.
  for (const c of curatedWwwCodes()) codes.add(c);
  return [...codes];
}

// ── HTML fetching / caching ──

function cachePathFor(code: string): string {
  // Product codes can contain characters unsafe for filenames on some filesystems (/, :) —
  // none observed live so far, but sanitize defensively rather than assume.
  const safe = code.replace(/[^A-Za-z0-9_.+-]/g, "_");
  return resolve(DEFAULT_CACHE_DIR, `${safe}.html`);
}

async function fetchProductHtml(code: string): Promise<{ status: number; html: string }> {
  const url = `https://mikrotik.com/product/${encodeURIComponent(code)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    redirect: "follow",
    headers: { "User-Agent": "Mozilla/5.0 (rosetta assess-www.ts research script)" },
  });
  return { status: res.status, html: res.status === 200 ? await res.text() : "" };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Page parsing ──

interface ProductInfo {
  code: string;
  found: boolean;
  title: string;
  tagline: string;
  discontinued: boolean;
  /** From `compareProductsTrigger('...')` — sometimes a different, more specific code than the URL slug. */
  compareId: string;
  specs: Record<string, string>;
}

function parseProductPage(code: string, html: string): ProductInfo {
  const { document } = parseHTML(html);

  const h1 = document.querySelector("h1");
  const title = h1?.textContent?.trim() || code;
  const tagline = h1?.nextElementSibling?.tagName === "P" ? (h1.nextElementSibling.textContent?.trim() ?? "") : "";

  const discontinued = /class="[^"]*uppercase[^"]*"[^>]*>\s*Discontinued\s*</.test(html);
  const compareMatch = html.match(/compareProductsTrigger\('([^']+)'\)/);
  const compareId = compareMatch ? compareMatch[1] : "";

  // Spec fields render as <li class="flex gap-2 ..."><span class="...font-bold">Key</span>
  // <span class="...font-light...">Value</span></li> — DOM traversal rather than regex
  // since values occasionally wrap Livewire conditional-render comments.
  const specs: Record<string, string> = {};
  for (const li of document.querySelectorAll("li")) {
    const spans = [...li.children].filter((c) => c.tagName === "SPAN");
    if (spans.length < 2) continue;
    const keyEl = spans.find((s) => s.className.includes("font-bold"));
    const valEl = spans.find((s) => s.className.includes("font-light"));
    if (!keyEl || !valEl) continue;
    const key = keyEl.textContent?.trim();
    const val = valEl.textContent?.replace(/\s+/g, " ").trim();
    if (key) specs[key] = val ?? "";
  }

  return { code, found: true, title, tagline, discontinued, compareId, specs };
}

// ── Main ──

async function main() {
  const candidates = loadCandidateCodes().sort((a, b) => a.localeCompare(b));
  const codes = LIMIT ? candidates.slice(0, LIMIT) : candidates;
  console.log(`Candidate product codes: ${codes.length}`);
  console.log(FROM_CACHE ? `Reading from cache: ${DEFAULT_CACHE_DIR}` : `Fetching from mikrotik.com/product/*`);

  mkdirSync(DEFAULT_CACHE_DIR, { recursive: true });

  const products: ProductInfo[] = [];
  const notFound: string[] = [];
  let fetchErrors = 0;

  for (const code of codes) {
    const cacheFile = cachePathFor(code);
    let html: string;
    let status: number;

    if (FROM_CACHE) {
      if (!existsSync(cacheFile)) {
        notFound.push(code);
        continue;
      }
      html = readFileSync(cacheFile, "utf-8");
      if (html === "") {
        notFound.push(code);
        continue;
      }
    } else {
      try {
        const res = await fetchProductHtml(code);
        status = res.status;
        html = res.html;
        // Cache both hits and misses (empty file = confirmed 404) so --from-cache reruns
        // don't re-treat a known-404 candidate as "never checked".
        writeFileSync(cacheFile, html);
        await delay(FETCH_DELAY_MS);
      } catch (e) {
        console.log(`  ERROR: ${code}: ${e}`);
        fetchErrors++;
        continue;
      }
      if (status !== 200) {
        notFound.push(code);
        continue;
      }
    }

    products.push(parseProductPage(code, html));
  }

  console.log(`Fetched/read: ${products.length}, not found (404): ${notFound.length}, errors: ${fetchErrors}`);

  // ── Field-frequency census (schema-design signal) ──
  const fieldFreq: Record<string, number> = {};
  for (const p of products) {
    for (const k of Object.keys(p.specs)) fieldFreq[k] = (fieldFreq[k] || 0) + 1;
  }
  const sortedFields = Object.entries(fieldFreq).sort(([, a], [, b]) => b - a);

  const discontinuedProducts = products.filter((p) => p.discontinued);

  // Product code as declared by the page's own "Product code" spec field vs. the code we
  // requested it under — mismatches mean the /hardware link or matrix.csv code isn't the
  // canonical code (e.g. hex_2024 -> declared code E50UG).
  const codeMismatches = products
    .filter((p) => p.specs["Product code"] && normCode(p.specs["Product code"]) !== normCode(p.code))
    .map((p) => ({ requestedAs: p.code, declaredCode: p.specs["Product code"] }));

  // ── Console report ──
  console.log("\n=== mikrotik.com/product Structural Assessment ===\n");
  console.log(`Products found:        ${products.length}`);
  console.log(`Not found (404):       ${notFound.length}`);
  console.log(`Discontinued:          ${discontinuedProducts.length}`);
  console.log(`Requested-code !== declared "Product code": ${codeMismatches.length}`);

  console.log(`\n--- Top 40 spec field names (schema-design signal) ---`);
  for (const [field, count] of sortedFields.slice(0, 40)) {
    console.log(`  [${count}x] ${field}`);
  }

  console.log(`\n--- Requested-code / declared-code mismatches (sample) ---`);
  for (const m of codeMismatches.slice(0, 20)) {
    console.log(`  requested "${m.requestedAs}" -> declared "${m.declaredCode}"`);
  }

  console.log(`\n--- Discontinued products (sample) ---`);
  for (const p of discontinuedProducts.slice(0, 30)) {
    console.log(`  ${p.code} — "${p.title}"`);
  }

  // ── Write JSON summary ──
  const summary = {
    candidateCount: codes.length,
    foundCount: products.length,
    notFoundCount: notFound.length,
    notFound,
    discontinuedCount: discontinuedProducts.length,
    fieldFrequency: Object.fromEntries(sortedFields),
    codeMismatches,
    products: products.map((p) => ({
      code: p.code,
      title: p.title,
      tagline: p.tagline,
      discontinued: p.discontinued,
      compareId: p.compareId,
      specs: p.specs,
    })),
  };

  const outPath = resolve(PROJECT_ROOT, "ros-www-assessment.json");
  await Bun.write(outPath, JSON.stringify(summary, null, 2));
  console.log(`\nFull assessment written to ${outPath}`);
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
