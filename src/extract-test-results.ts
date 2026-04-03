/**
 * extract-test-results.ts — Scrape MikroTik product pages for test results + block diagram URLs.
 *
 * Fetches each product page from mikrotik.com and extracts:
 *   - Ethernet test results (bridging/routing throughput at various packet sizes)
 *   - IPSec test results (tunnel throughput with various ciphers)
 *   - Block diagram PNG URL
 *   - Product page URL slug
 *
 * Idempotent: deletes all existing test results, updates device rows.
 * Requires devices table to be populated first (via extract-devices.ts).
 *
 * Usage: bun run src/extract-test-results.ts [--concurrency N] [--delay MS]
 *
 * Product page URL slug discovery: fetches the product matrix page to build
 * a name→slug mapping, then fetches each product page by slug.
 */

import { parseHTML } from "linkedom";
import { db, initDb } from "./db.ts";

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

// ── Types ──

interface TestResultRow {
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

// ── HTML Parsing ──

/** Decode HTML entities like &#110;&#111;&#110;&#101; to text. */
function decodeEntities(html: string): string {
  const { document } = parseHTML("<div></div>");
  const el = document.createElement("div");
  el.innerHTML = html;
  return el.textContent || "";
}

/** Parse a performance-table element into test result rows. */
function parsePerformanceTable(table: Element): { testType: string; rows: TestResultRow[] } {
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
    for (let i = 0; i < packetSizes.length; i++) {
      const kppsIdx = 2 + i * 2;
      const mbpsIdx = 3 + i * 2;
      if (kppsIdx >= cells.length) break;

      const kpps = Number.parseFloat((cells[kppsIdx].textContent || "").trim());
      const mbps = mbpsIdx < cells.length
        ? Number.parseFloat((cells[mbpsIdx].textContent || "").trim())
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
    add(cleanCode.replace(/\+/g, "plus").replace(/[^a-zA-Z0-9plus\-]+/g, "").replace(/^-|-$/g, ""));

    // 4. Product code as-is (original casing)
    add(cleanCode.replace(/[^a-zA-Z0-9\-]+/g, "").replace(/^-|-$/g, ""));

    // 5. Lowercased code: + → plus
    add(cleanCode.toLowerCase().replace(/\+/g, "plus").replace(/[^a-z0-9plus]+/g, "_").replace(/^_|_$/g, ""));

    // 6. Lowercased code: drop +
    add(cleanCode.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  }

  return slugs;
}

/** Fetch and parse a single product page, trying multiple slug candidates. */
async function fetchProductPage(slugs: string[]): Promise<ProductPageData | null> {
  for (const slug of slugs) {
    const url = `${PRODUCT_BASE}${slug}`;
    try {
      const resp = await fetch(url);
      if (resp.ok) {
        const html = await resp.text();
        return parseProductHtml(html, slug);
      }
      // Don't warn for intermediary attempts — only the last slug matters
    } catch {
      // network error, try next slug
    }
  }
  console.warn(`  [404] ${slugs[0]} (tried ${slugs.length} variants)`);
  return null;
}

/** Parse product page HTML into structured data. */
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

  return { slug, ethernet_results, ipsec_results, block_diagram_url };
}

/** Sleep helper for rate limiting. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main ──

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

// Build device → candidate slugs mapping
const deviceSlugs: Array<{ id: number; name: string; slugs: string[] }> = [];
for (const dev of devices) {
  const slugs = generateSlugs(dev.product_name, dev.product_code);
  deviceSlugs.push({ id: dev.id, name: dev.product_name, slugs });
}

// Idempotent: clear existing test results
db.run("DELETE FROM device_test_results");

// Prepare statements
const insertTest = db.prepare(`INSERT OR IGNORE INTO device_test_results (
  device_id, test_type, mode, configuration, packet_size,
  throughput_kpps, throughput_mbps
) VALUES (?, ?, ?, ?, ?, ?, ?)`);

const updateDevice = db.prepare(`UPDATE devices
  SET product_url = ?, block_diagram_url = ?
  WHERE id = ?`);

console.log(`Fetching ${deviceSlugs.length} product pages (concurrency=${CONCURRENCY}, delay=${DELAY_MS}ms)...`);

let totalTests = 0;
let devicesWithTests = 0;
let devicesWithDiagrams = 0;
let fetchErrors = 0;

const insertAll = db.transaction(
  (results: Array<{ deviceId: number; data: ProductPageData | null }>) => {
    for (const { deviceId, data } of results) {
      if (!data) {
        fetchErrors++;
        continue;
      }

      // Update device with URL and block diagram
      updateDevice.run(
        `https://mikrotik.com/product/${data.slug}`,
        data.block_diagram_url,
        deviceId,
      );

      if (data.block_diagram_url) devicesWithDiagrams++;

      // Insert test results
      const allResults = [
        ...data.ethernet_results.map((r) => ({ ...r, test_type: "ethernet" as const })),
        ...data.ipsec_results.map((r) => ({ ...r, test_type: "ipsec" as const })),
      ];

      if (allResults.length > 0) devicesWithTests++;

      for (const r of allResults) {
        insertTest.run(
          deviceId,
          r.test_type,
          r.mode,
          r.configuration,
          r.packet_size,
          r.throughput_kpps,
          r.throughput_mbps,
        );
        totalTests++;
      }
    }
  },
);

// Fetch all products with rate limiting
const allResults: Array<{ deviceId: number; data: ProductPageData | null }> = [];
let processed = 0;

for (let i = 0; i < deviceSlugs.length; i += CONCURRENCY) {
  const batch = deviceSlugs.slice(i, i + CONCURRENCY);
  const batchResults = await Promise.all(
    batch.map(async (dev) => {
      const data = await fetchProductPage(dev.slugs);
      return { deviceId: dev.id, data };
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

// Insert all results in one transaction
insertAll(allResults);

console.log(`Test results: ${totalTests} rows for ${devicesWithTests} devices`);
console.log(`Block diagrams: ${devicesWithDiagrams} devices`);
if (fetchErrors > 0) {
  console.warn(`Fetch errors: ${fetchErrors} products`);
}
