/**
 * extract-test-results.ts — Scrape MikroTik product pages for test results + block diagram URLs.
 *
 * Fetches each product page from mikrotik.com and extracts:
 *   - Ethernet test results (bridging/routing throughput at various packet sizes)
 *   - IPSec test results (tunnel throughput with various ciphers)
 *   - Block diagram PNG URL
 *   - Product page URL slug
 *
 * Idempotent: on a passing verdict, atomically replaces all test results and
 * updates device rows; a failed run exits non-zero with the table untouched.
 * Requires devices table to be populated first (via extract-devices.ts).
 *
 * Usage: bun run src/extract-test-results.ts [--concurrency N] [--delay MS]
 *
 * Product page URL slug discovery: fetches sitemap.xml once to build a validated
 * slug set, then applies (1) a hardcoded override table for the 15 products with
 * opaque/unpredictable slugs, (2) heuristic candidates validated against the sitemap,
 * (3) raw heuristics as a fallback for new products not yet in the sitemap.
 */

import { parseHTML } from "linkedom";
import { fetchTextWithRetry, type RetryOptions } from "./restraml.ts";

// ── CLI flags ──

const args = process.argv.slice(2);
function getFlag(name: string, fallback: number): number {
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && args[idx + 1]) return Number(args[idx + 1]);
  return fallback;
}

const CONCURRENCY = getFlag("concurrency", 4);
const DELAY_MS = getFlag("delay", 500);
const PRODUCT_BASE = "https://mikrotik.com/product/";
const SITEMAP_URL = "https://mikrotik.com/sitemap.xml";

// Identify the scraper: a default runtime UA looks like an anonymous bot to
// bot protection, and gives MikroTik no way to reach us about crawl load.
const REQUEST_HEADERS = {
  "User-Agent": "rosetta-docs-bot/1.0 (+https://github.com/tikoci/rosetta)",
  Accept: "text/html",
};

// Per-request retry budget for mikrotik.com fetches: the shared 5xx/429/network
// retry (a transient 503 blanked the whole next.123 table, #218), with a
// shorter per-attempt timeout than the restraml default — product pages are
// ~330 KB and answer in ~2s, so 30s without a byte is already a sick host.
const FETCH_RETRY: RetryOptions = { timeoutMs: 30_000 };

// Fail-loud threshold (#218): the share of products that may hard-fail
// (transport/HTTP errors after retries — NOT 404s) before the run fails.
// A healthy run has 0 hard errors (only a handful of genuine 404s for
// discontinued products); the next.123 incident was 155/155.
export const MAX_HARD_ERROR_RATE = 0.10;

// Fail-loud threshold for gone pages: a mass-404 (slug-scheme change, WAF
// answering 404s) with a few surviving rows must not ship as a quiet prune.
// Healthy baseline is 7/155 ≈ 5% genuine 404s for discontinued products, so
// 15% gives ~3x headroom for a bad discontinuation batch while a real
// scheme change drives missing toward 100% — far above the gate.
export const MAX_MISSING_RATE = 0.15;

// Global run deadline: the batch loop breaks out once the fetch phase
// exceeds this. A healthy run finishes in ~2 minutes, so 15 minutes is
// generous headroom that still bounds a hung host at ~17 minutes of CI burn
// instead of ~80 (4 attempts × 30s timeout × ~39 batches). Overridable for
// genuinely slow links; a breached run exits 1 with the table untouched.
export const EXTRACTION_DEADLINE_MS = (() => {
  const raw = Number(process.env.ROSETTA_EXTRACT_DEADLINE_MS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : 15 * 60_000;
})();

// ── Slug overrides ──
// Products whose URL slugs are undiscoverable by heuristics alone.
// Derived from sitemap.xml research (2026-04-04 — all 15 missing devices resolved).
const SLUG_OVERRIDES: Record<string, string> = {
  "ATL LTE18 kit": "atl18",
  "CRS418-8P-8G-2S+5axQ2axQ-RM": "crs418_8p_8g_2s_wifi",
  "CRS518-16XS-2XQ-RM": "crs518_16xs_2xq",
  "Chateau LTE18 ax": "chateaulte18_ax",
  "FiberBox Plus": "fiberboxplus",
  "KNOT Embedded LTE4 Global": "knot_emb_lte4_global",
  "LHG LTE18 kit": "lhg_lte18",
  "LHG XL 5 ax": "lhg_5_ax_xl",
  "LHGG LTE7 kit": "lhgg_lte7",
  "RB5009UPr+S+OUT": "rb5009_out",
  "ROSE Data server (RDS)": "rds2216",
  "SXTsq 5 ax": "sxtsq_5ax",
  "cAP lite": "RBcAPL-2nD-307",
  "hEX refresh": "hex_2024",
  "wAP ax LTE7 kit": "wap_ax_lte7",
};

// ── Types ──

export interface TestResultRow {
  mode: string;
  configuration: string;
  packet_size: number;
  throughput_kpps: number | null;
  throughput_mbps: number | null;
}

interface ProductPageData {
  slug: string;
  ethernet_results: TestResultRow[];
  ipsec_results: TestResultRow[];
  block_diagram_url: string | null;
}

/** Per-product fetch outcome. `missing` (every slug variant 404'd) means the
 *  product page is genuinely gone; `error` (a transport failure or non-404
 *  HTTP status surviving retries) means the host is sick or blocking us. */
export type ProductFetchResult =
  | { status: "ok"; data: ProductPageData }
  | { status: "missing"; tried: number }
  | { status: "error"; detail: string };

/** End-of-run counts for the fail-loud verdict. */
export interface ExtractionOutcome {
  deviceCount: number;
  totalTests: number;
  /** Products failing with transport/HTTP errors after retries (not 404s). */
  hardErrors: number;
  /** Products whose page is simply gone (all slug variants 404). */
  missing: number;
  /** Whether the sitemap seed load succeeded. */
  sitemapOk: boolean;
  /** Whether the fetch phase hit the global run deadline. */
  timedOut: boolean;
}

/**
 * Fail-loud verdict (#218): next.123 shipped an empty device_test_results
 * table because every fetch failed and the extractor still exited 0. Returns
 * an error message when the run must fail, null when it may proceed.
 */
export function evaluateExtractionOutcome(o: ExtractionOutcome): string | null {
  if (o.timedOut) {
    return `extract-test-results: global extraction deadline ` +
      `(${Math.round(EXTRACTION_DEADLINE_MS / 60000)} min) exceeded with only ` +
      `${o.totalTests} rows collected — refusing to ship partial test results ` +
      `(raise ROSETTA_EXTRACT_DEADLINE_MS if this link is genuinely slow)`;
  }
  if (o.totalTests === 0) {
    return `extract-test-results: 0 test-result rows for ${o.deviceCount} devices ` +
      `(${o.hardErrors} unreachable, ${o.missing} pages missing` +
      `${o.sitemapOk ? "" : ", sitemap seed failed"}) — ` +
      `refusing to ship an empty device_test_results table`;
  }
  if (o.deviceCount > 0 && o.hardErrors / o.deviceCount > MAX_HARD_ERROR_RATE) {
    return `extract-test-results: ${o.hardErrors}/${o.deviceCount} product pages failed ` +
      `with transport/HTTP errors (over the ${MAX_HARD_ERROR_RATE * 100}% threshold) — ` +
      `mikrotik.com may be blocking or down; refusing to ship partial test results`;
  }
  if (o.deviceCount > 0 && o.missing / o.deviceCount > MAX_MISSING_RATE) {
    return `extract-test-results: ${o.missing}/${o.deviceCount} product pages 404'd ` +
      `(over the ${MAX_MISSING_RATE * 100}% threshold) — ` +
      `the slug scheme may have changed; refusing to ship partial test results`;
  }
  return null;
}

// ── HTML Parsing ──

/** Parse a performance-table element into test result rows. */
export function parsePerformanceTable(table: Element): { testType: string; rows: TestResultRow[] } {
  const rows: TestResultRow[] = [];

  // Header row: first <tr> in <thead> has [product_code, test_description]
  const thead = table.querySelector("thead");
  if (!thead) return { testType: "unknown", rows };

  const headerRows = thead.querySelectorAll("tr");
  if (headerRows.length < 2) return { testType: "unknown", rows };

  // Determine test type from header description
  const headerCells = headerRows[0].querySelectorAll("td");
  const testDesc = headerCells.length >= 2 ? (headerCells[1].textContent || "").trim().toLowerCase() : "";
  const testType = testDesc.includes("ipsec") ? "ipsec" : "ethernet";

  // Determine packet sizes from the second header row
  // Structure: [Mode, Configuration, (1518|1400) byte, 512 byte, 64 byte]
  // The colspan=2 means each size has kpps + Mbps columns
  const sizeRow = headerRows[1];
  const sizeCells = sizeRow.querySelectorAll("td");
  const packetSizes: number[] = [];
  for (const cell of sizeCells) {
    const text = (cell.textContent || "").trim();
    const match = text.match(/^(\d+)\s*byte/i);
    if (match) packetSizes.push(Number.parseInt(match[1], 10));
  }

  // If we couldn't find sizes in the header, use defaults
  if (packetSizes.length === 0) {
    if (testType === "ipsec") {
      packetSizes.push(1400, 512, 64);
    } else {
      packetSizes.push(1518, 512, 64);
    }
  }

  // Parse data rows from <tbody>
  const tbody = table.querySelector("tbody");
  if (!tbody) return { testType, rows };

  for (const tr of tbody.querySelectorAll("tr")) {
    const cells = tr.querySelectorAll("td");
    if (cells.length < 2) continue;

    const mode = (cells[0].textContent || "").trim();
    const config = (cells[1].textContent || "").trim();

    // Each packet size has 2 columns: kpps, Mbps
    // Strip thousands-separator commas before parsing (e.g. "7,112.3" → 7112.3)
    const parseNum = (s: string) => Number.parseFloat(s.replace(/,/g, "").trim());
    for (let i = 0; i < packetSizes.length; i++) {
      const kppsIdx = 2 + i * 2;
      const mbpsIdx = 3 + i * 2;
      if (kppsIdx >= cells.length) break;

      const kpps = parseNum((cells[kppsIdx].textContent || "").trim());
      const mbps = mbpsIdx < cells.length
        ? parseNum((cells[mbpsIdx].textContent || "").trim())
        : null;

      rows.push({
        mode,
        configuration: config,
        packet_size: packetSizes[i],
        throughput_kpps: Number.isNaN(kpps) ? null : kpps,
        throughput_mbps: mbps !== null && Number.isNaN(mbps) ? null : mbps,
      });
    }
  }

  return { testType, rows };
}

/** Generate candidate URL slugs for a product.
 *  MikroTik slugs are wildly inconsistent — some use lowercased names with underscores,
 *  some use product codes with original casing, and + is sometimes "plus", sometimes dropped.
 *  Unicode superscripts (², ³) are transliterated to digits.
 *  We try multiple variants and use the first that returns 200. */
function generateSlugs(name: string, code: string | null): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    if (s && !seen.has(s)) {
      seen.add(s);
      slugs.push(s);
    }
  };

  // Normalize Unicode superscripts to regular digits
  const norm = (s: string) =>
    s.replace(/²/g, "2").replace(/³/g, "3").replace(/¹/g, "1");

  const cleanName = norm(name);

  // 1. Lowercased name: + → plus, non-alphanum → _
  add(cleanName.toLowerCase().replace(/\+/g, "plus").replace(/[^a-z0-9plus]+/g, "_").replace(/^_|_$/g, ""));

  // 2. Lowercased name: drop + entirely
  add(cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));

  if (code) {
    const cleanCode = norm(code);

    // 3. Product code as-is (original casing, + → plus, strip other specials)
    add(cleanCode.replace(/\+/g, "plus").replace(/[^a-zA-Z0-9plus-]+/g, "").replace(/^-|-$/g, ""));

    // 4. Product code as-is (original casing)
    add(cleanCode.replace(/[^a-zA-Z0-9-]+/g, "").replace(/^-|-$/g, ""));

    // 5. Lowercased code: + → plus
    add(cleanCode.toLowerCase().replace(/\+/g, "plus").replace(/[^a-z0-9plus]+/g, "_").replace(/^_|_$/g, ""));

    // 6. Lowercased code: drop +
    add(cleanCode.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  }

  return slugs;
}

/** Fetch sitemap.xml and return the set of all valid product slugs.
 *  Retries transient failures, then returns an empty set on persistent error
 *  (callers fall back to heuristics). */
export async function fetchSitemap(retry: RetryOptions = {}): Promise<Set<string>> {
  try {
    const resp = await fetchTextWithRetry(SITEMAP_URL, { headers: REQUEST_HEADERS }, { ...FETCH_RETRY, ...retry });
    if (!resp.ok) {
      console.warn(`  [sitemap] HTTP ${resp.status} — falling back to heuristics`);
      return new Set();
    }
    const xml = resp.text;
    const slugs = new Set<string>();
    const re = /\/product\/([^<"]+)/g;
    while (true) {
      const m = re.exec(xml);
      if (m === null) break;
      slugs.add(m[1]);
    }
    console.log(`  [sitemap] ${slugs.size} product slugs loaded`);
    return slugs;
  } catch (e) {
    console.warn(`  [sitemap] fetch failed (${(e as Error).message}) — falling back to heuristics`);
    return new Set();
  }
}

/** Build ordered slug candidates for a product.
 *  Priority: (1) override table, (2) generated slugs that appear in sitemap,
 *  (3) remaining generated slugs as fallback. */
function buildSlugCandidates(name: string, code: string | null, sitemapSlugs: Set<string>): string[] {
  const slugs: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    if (s && !seen.has(s)) { seen.add(s); slugs.push(s); }
  };

  // 1. Override table (highest priority — known-opaque slugs)
  const override = SLUG_OVERRIDES[name];
  if (override) add(override);

  // 2. Heuristic candidates validated against sitemap
  const generated = generateSlugs(name, code);
  if (sitemapSlugs.size > 0) {
    for (const s of generated) {
      if (sitemapSlugs.has(s)) add(s);
    }
  }

  // 3. All remaining heuristic candidates (fallback for new products not yet in sitemap)
  for (const s of generated) add(s);

  return slugs;
}

/** Fetch and parse a single product page, trying multiple slug candidates.
 *  A 404 moves to the next variant (wrong slug guess); any other failure —
 *  transport error or non-404 status surviving retries — stops the variants
 *  (a sick host won't answer a different slug) and reports a hard error. */
export async function fetchProductPage(
  slugs: string[],
  retry: RetryOptions = {},
): Promise<ProductFetchResult> {
  const opts = { ...FETCH_RETRY, ...retry };
  for (const slug of slugs) {
    const url = `${PRODUCT_BASE}${slug}`;
    let resp: Awaited<ReturnType<typeof fetchTextWithRetry>>;
    try {
      // The body is read inside the retry loop: a mid-body reset retries
      // instead of becoming this product's hard error after the headers.
      resp = await fetchTextWithRetry(url, { headers: REQUEST_HEADERS }, opts);
    } catch (e) {
      return { status: "error", detail: `fetch failed: ${(e as Error).message}` };
    }
    if (resp.ok) {
      // A parse throw is one product's hard error, not a reason to let
      // Promise.all reject and kill the other 154 products' results.
      let data: ProductPageData | null;
      try {
        data = parseProductHtml(resp.text, slug);
      } catch (e) {
        return { status: "error", detail: `unparseable page at ${slug}: ${(e as Error).message}` };
      }
      if (data) return { status: "ok", data };
      return { status: "error", detail: `unparseable page at ${slug}` };
    }
    if (resp.status !== 404) {
      return { status: "error", detail: `HTTP ${resp.status}` };
    }
    // 404: wrong slug guess — try the next variant silently.
  }
  return { status: "missing", tried: slugs.length };
}

/** Parse product page HTML into structured data. Returns null when the page
 *  carries nothing we recognize — no benchmark rows and no block diagram link.
 *  A 200 with zero parseable content is a soft-404, a bot-wall page, or markup
 *  drift, never a product without benchmarks; recording it `ok` would let a
 *  site-wide drift pass with 0 hard errors behind only the QA row floor. A
 *  page with a diagram but no tables stays `ok` (some products genuinely lack
 *  benchmark tables). */
function parseProductHtml(html: string, slug: string): ProductPageData | null {

  const { document } = parseHTML(html);

  // Parse performance tables
  const tables = document.querySelectorAll("table.performance-table");
  const ethernet_results: TestResultRow[] = [];
  const ipsec_results: TestResultRow[] = [];

  for (const table of tables) {
    const { testType, rows } = parsePerformanceTable(table);
    if (testType === "ipsec") {
      ipsec_results.push(...rows);
    } else {
      ethernet_results.push(...rows);
    }
  }

  // Find block diagram URL
  let block_diagram_url: string | null = null;
  const links = document.querySelectorAll("a");
  for (const a of links) {
    const text = (a.textContent || "").trim();
    if (text === "Block Diagram") {
      const href = a.getAttribute("href");
      if (href) {
        block_diagram_url = href.startsWith("http")
          ? href
          : `https://cdn.mikrotik.com${href}`;
      }
      break;
    }
  }

  if (ethernet_results.length === 0 && ipsec_results.length === 0 && block_diagram_url === null) {
    return null;
  }
  return { slug, ethernet_results, ipsec_results, block_diagram_url };
}

/** Sleep helper for rate limiting. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main ──
async function main(): Promise<void> {
  const { db, initDb } = await import("./db.ts");

  initDb();

  // Get all devices from DB
  const devices = db.prepare("SELECT id, product_name, product_code FROM devices ORDER BY product_name").all() as Array<{
    id: number;
    product_name: string;
    product_code: string | null;
  }>;

  if (devices.length === 0) {
    console.error("No devices in database. Run extract-devices.ts first.");
    process.exit(1);
  }

  console.log(`Found ${devices.length} devices in database`);

  // Fetch sitemap once to validate slugs and prioritize correct candidates
  console.log("Loading product sitemap...");
  const sitemapSlugs = await fetchSitemap();

  // Build device -> candidate slugs mapping
  const deviceSlugs: Array<{ id: number; name: string; slugs: string[] }> = [];
  for (const dev of devices) {
    const slugs = buildSlugCandidates(dev.product_name, dev.product_code, sitemapSlugs);
    deviceSlugs.push({ id: dev.id, name: dev.product_name, slugs });
  }

  // Prepare statements (no writes yet — the verdict below runs first, so a
  // failed run leaves the previous table untouched instead of wiped/partial).
  const insertTest = db.prepare(`INSERT OR IGNORE INTO device_test_results (
    device_id, test_type, mode, configuration, packet_size,
    throughput_kpps, throughput_mbps
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`);

  const updateDevice = db.prepare(`UPDATE devices
    SET product_url = ?, block_diagram_url = ?
    WHERE id = ?`);

  const clearTests = db.prepare("DELETE FROM device_test_results");

  console.log(`Fetching ${deviceSlugs.length} product pages (concurrency=${CONCURRENCY}, delay=${DELAY_MS}ms)...`);

  // Fetch all products with rate limiting
  const allResults: Array<{ deviceId: number; name: string; firstSlug: string; result: ProductFetchResult }> = [];
  let processed = 0;
  let timedOut = false;
  const startedAt = Date.now();

  for (let i = 0; i < deviceSlugs.length; i += CONCURRENCY) {
    if (Date.now() - startedAt > EXTRACTION_DEADLINE_MS) {
      timedOut = true;
      console.warn(`  [deadline] global extraction deadline exceeded after ${processed}/${deviceSlugs.length} products`);
      break;
    }
    const batch = deviceSlugs.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (dev) => {
        const result = await fetchProductPage(dev.slugs);
        return { deviceId: dev.id, name: dev.name, firstSlug: dev.slugs[0], result };
      }),
    );
    allResults.push(...batchResults);
    processed += batch.length;

    const pct = Math.round((processed / deviceSlugs.length) * 100);
    process.stdout.write(`\r  ${processed}/${deviceSlugs.length} (${pct}%)`);

    if (i + CONCURRENCY < deviceSlugs.length) {
      await sleep(DELAY_MS);
    }
  }
  console.log(""); // newline after progress

  // Tally the run before touching the DB: the verdict decides whether any
  // write happens at all.
  let totalTests = 0;
  let devicesWithTests = 0;
  let devicesWithDiagrams = 0;
  let hardErrors = 0;
  let missingPages = 0;

  for (const { name, firstSlug, result } of allResults) {
    if (result.status === "missing") {
      missingPages++;
      console.warn(`  [missing] ${name} (${firstSlug}, all ${result.tried} slug variants 404)`);
      continue;
    }
    if (result.status === "error") {
      hardErrors++;
      console.warn(`  [error] ${name} (${firstSlug}: ${result.detail})`);
      continue;
    }
    const rows = result.data.ethernet_results.length + result.data.ipsec_results.length;
    if (rows > 0) devicesWithTests++;
    if (result.data.block_diagram_url) devicesWithDiagrams++;
    totalTests += rows;
  }

  console.log(`Test results: ${totalTests} rows for ${devicesWithTests} devices`);
  console.log(`Block diagrams: ${devicesWithDiagrams} devices`);
  if (missingPages > 0) {
    console.warn(`Missing pages: ${missingPages} products (all slug variants 404)`);
  }
  if (hardErrors > 0) {
    console.warn(`Hard errors: ${hardErrors} products (transport/HTTP failures after retries)`);
  }

  // Fail loudly, never ship an empty or badly-gapped table (#218). Nothing
  // has been written yet, so a failing run keeps the previous table intact.
  const verdict = evaluateExtractionOutcome({
    deviceCount: devices.length,
    totalTests,
    hardErrors,
    missing: missingPages,
    sitemapOk: sitemapSlugs.size > 0,
    timedOut,
  });
  if (verdict) {
    console.error(verdict);
    process.exit(1);
  }

  // Idempotent rebuild, atomically: clear + insert in one transaction.
  const insertAll = db.transaction(
    (results: Array<{ deviceId: number; result: ProductFetchResult }>) => {
      clearTests.run();
      for (const { deviceId, result } of results) {
        if (result.status !== "ok") continue;
        const data = result.data;

        // Update device with URL and block diagram
        updateDevice.run(
          `https://mikrotik.com/product/${data.slug}`,
          data.block_diagram_url,
          deviceId,
        );

        // Insert test results
        const rows = [
          ...data.ethernet_results.map((r) => ({ ...r, test_type: "ethernet" as const })),
          ...data.ipsec_results.map((r) => ({ ...r, test_type: "ipsec" as const })),
        ];

        for (const r of rows) {
          insertTest.run(
            deviceId,
            r.test_type,
            r.mode,
            r.configuration,
            r.packet_size,
            r.throughput_kpps,
            r.throughput_mbps,
          );
        }
      }
    },
  );
  insertAll(allResults);
}

if (import.meta.main) {
  await main();
}
