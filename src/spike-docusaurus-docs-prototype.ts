/**
 * spike-docusaurus-docs-prototype.ts — T-0034 spike, not a production extractor.
 *
 * Fetches a small, hand-picked sample of real /docs pages from manual.mikrotik.com,
 * parses Markdown property tables + admonitions + relative links, and stores results
 * in a throwaway scratch SQLite DB using the H7 Option-2 shape: a `rosetta_id TEXT
 * UNIQUE` column alongside a synthetic integer PK, never touching the production
 * schema (pages, commands, schema_nodes, properties in ros-help.db).
 *
 * See briefings/B-0012-docusaurus-manual-migration.md, "H7 — Identity / rosetta-id
 * design" and H4 "Property-descriptions assessment" for the findings this validates.
 *
 * Usage: bun run src/spike-docusaurus-docs-prototype.ts [urls-file] [scratch-db-path]
 *   urls-file defaults to the curated list below.
 *   scratch-db-path defaults to a temp file under os.tmpdir().
 */

import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveRosettaId } from "./spike-docusaurus-rosetta-id.ts";

const BASE = "https://manual.mikrotik.com";

// Curated to hit: a short simple page, a property-heavy page (dhcp-client), the
// known malformed-emphasis pattern (check-gateway on the same page), a heavily
// admonition-laden page, pages with relative links, and a spread of categories.
// See B-0012 H7/H4 for why these specific pages were picked (2026-07-07 live probe).
const DEFAULT_URLS = [
  "/docs/network-management/dhcp",
  "/docs/firewall-and-quality-of-service/user-guides/bruteforce-prevention",
  "/docs/containers/user-guides/container-homeassistant",
  "/docs/bridging-and-switching/user-guides/spanning-tree-protocol",
  "/docs/getting-started/configuration-management/backup",
  "/docs/getting-started/first-time-configuration",
  "/docs/wireless/abgn/capsman/ap-controller-capsman",
  "/docs/authentication-authorization-accounting/dot1x",
  "/docs/bridging-and-switching/swos/troubleshooting",
  "/docs/containers/user-guides/container-matrix-synapse",
  "/docs/diagnostics-monitoring-and-troubleshooting/ip-scan",
  "/docs/firewall-and-quality-of-service/firewall/address-lists",
  "/docs/firewall-and-quality-of-service/user-guides/building-advanced-firewall",
  "/docs/getting-started/installation-and-upgrade/install/x86-installation",
  "/docs/getting-started/supout-rif",
  "/docs/high-availability-solutions/load-balancing/per-connection-classifier",
  "/docs/internet-of-things/gpio/using-gpio-as-pulse-input-from-meter",
  "/docs/management-tools/flashfig",
  "/docs/mobile-networking/sms",
  "/docs/storage/encrypted-storage",
];

interface ParsedProperty {
  name: string;
  rawType: string | null;
  defaultVal: string | null;
  description: string;
  section: string | null;
  malformedEmphasis: boolean;
}

interface ParsedAdmonition {
  type: string;
  content: string;
  fenceWidth: number;
}

interface ResolvedLink {
  text: string;
  rawTarget: string;
  resolvedUrl: string;
  resolvedRosettaId: string;
}

interface ParsedPage {
  url: string;
  rosettaId: string;
  title: string;
  wordCount: number;
  properties: ParsedProperty[];
  admonitions: ParsedAdmonition[];
  links: ResolvedLink[];
}

/** Split a Markdown table row into cells, respecting `\|` as an escaped literal pipe. */
function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") {
      current += "|";
      i++;
      continue;
    }
    if (line[i] === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += line[i];
  }
  cells.push(current.trim());
  // Markdown tables start/end with a pipe, producing an empty first/last cell.
  if (cells[0] === "") cells.shift();
  if (cells[cells.length - 1] === "") cells.pop();
  return cells;
}

/**
 * Parse a property-cell's raw text into name/type/default.
 * Tolerant of the malformed-bold-emphasis pattern found in dhcp.md's check-gateway
 * row (B-0012 H4): `**check-gateway** *(none \| arp \| bfd \| ping***;** Default: **none)**`
 * — the closing bold delimiter lands in the wrong place. Name and Default extraction
 * are regex-based against the whole cell text (not dependent on well-formed emphasis
 * nesting), matching extract-properties.ts's existing tolerant approach for HTML.
 */
function parsePropertyCell(cellText: string): { name: string; rawType: string | null; defaultVal: string | null; malformed: boolean } | null {
  const nameMatch = cellText.match(/\*\*([a-z0-9][a-z0-9-]*)\*\*/i);
  if (!nameMatch) return null;
  const name = nameMatch[1];

  const defaultMatch = cellText.match(/Default:\s*\*{0,2}([^)*]*)\*{0,2}\)?/i);
  const defaultVal = defaultMatch ? defaultMatch[1].trim() || null : null;

  const parenMatch = cellText.match(/\(([^)]*)\)/);
  const rawType = parenMatch ? parenMatch[1].replace(/Default:.*/i, "").replace(/[*;]+$/, "").trim() || null : null;

  // Malformed-emphasis heuristic: an odd number of `**` markers, or `***` runs
  // (three-or-more asterisks in a row), which well-formed bold/italic never produces.
  const boldMarkers = (cellText.match(/\*\*/g) || []).length;
  const malformed = boldMarkers % 2 !== 0 || /\*{3,}/.test(cellText);

  return { name, rawType, defaultVal, malformed };
}

function parseProperties(md: string): ParsedProperty[] {
  const lines = md.split("\n");
  const properties: ParsedProperty[] = [];
  let currentHeading: string | null = null;
  let currentSection: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      currentHeading = headingMatch[1].trim();
      currentSection = currentHeading;
      continue;
    }

    // Table header row containing "Property" (case-insensitive), followed by a
    // separator row (---/:--/--:), then data rows until a non-table line.
    if (/^\|.*\bproperty\b.*\|$/i.test(line) && lines[i + 1] && /^\|[\s:|-]+\|$/.test(lines[i + 1])) {
      i += 2; // skip header + separator
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = splitTableRow(lines[i]);
        if (cells.length >= 2) {
          const parsed = parsePropertyCell(cells[0]);
          if (parsed) {
            properties.push({
              name: parsed.name,
              rawType: parsed.rawType,
              defaultVal: parsed.defaultVal,
              description: cells[1],
              section: currentSection,
              malformedEmphasis: parsed.malformed,
            });
          }
        }
        i++;
      }
      i--; // outer loop will increment
    }
  }

  return properties;
}

/** Parse :::type ... ::: (and ::::-nested) admonition blocks. */
function parseAdmonitions(md: string): ParsedAdmonition[] {
  const lines = md.split("\n");
  const admonitions: ParsedAdmonition[] = [];
  const stack: Array<{ type: string; fenceWidth: number; contentLines: string[] }> = [];

  for (const line of lines) {
    const fenceMatch = line.match(/^(:{3,})(\w+)?\s*$/);
    if (fenceMatch) {
      const fenceWidth = fenceMatch[1].length;
      const type = fenceMatch[2];
      if (type) {
        // Opening fence
        stack.push({ type, fenceWidth, contentLines: [] });
      } else if (stack.length > 0 && stack[stack.length - 1].fenceWidth === fenceWidth) {
        // Closing fence matching the innermost open block of the same width
        const closed = stack.pop();
        if (closed) {
          const content = closed.contentLines.join("\n").trim();
          admonitions.push({ type: closed.type, content, fenceWidth: closed.fenceWidth });
        }
      } else if (stack.length > 0) {
        // Fence width didn't match top-of-stack — treat as content of the
        // current innermost block rather than dropping the line.
        stack[stack.length - 1].contentLines.push(line);
      }
      continue;
    }
    if (stack.length > 0) stack[stack.length - 1].contentLines.push(line);
  }

  return admonitions;
}

/** Find [text](target) links and resolve relative ones against the page's own URL. */
function parseAndResolveLinks(md: string, pageUrl: string): ResolvedLink[] {
  const links: ResolvedLink[] = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec-loop idiom
  while ((m = re.exec(md))) {
    const [, text, target] = m;
    if (/^https?:\/\//.test(target)) continue; // absolute links — nothing to resolve
    if (target.startsWith("#")) continue; // same-page anchor — no cross-page resolution needed
    const resolvedUrl = new URL(target, pageUrl).toString();
    links.push({
      text,
      rawTarget: target,
      resolvedUrl,
      resolvedRosettaId: deriveRosettaId(resolvedUrl),
    });
  }
  return links;
}

async function fetchPage(urlPath: string): Promise<ParsedPage | null> {
  const pageUrl = `${BASE}${urlPath}`;
  const res = await fetch(`${pageUrl}.md`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    console.log(`  SKIP ${urlPath} (HTTP ${res.status})`);
    return null;
  }
  const md = await res.text();
  const titleMatch = md.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : urlPath;

  return {
    url: pageUrl,
    rosettaId: deriveRosettaId(pageUrl),
    title,
    wordCount: md.split(/\s+/).filter(Boolean).length,
    properties: parseProperties(md),
    admonitions: parseAdmonitions(md),
    links: parseAndResolveLinks(md, pageUrl),
  };
}

function openScratchDb(dbPath: string): Database {
  const db = new Database(dbPath);
  db.run(`CREATE TABLE IF NOT EXISTS spike_pages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rosetta_id  TEXT NOT NULL UNIQUE,
    url         TEXT NOT NULL,
    title       TEXT NOT NULL,
    word_count  INTEGER NOT NULL
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS spike_properties (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    page_rosetta_id TEXT NOT NULL REFERENCES spike_pages(rosetta_id),
    name        TEXT NOT NULL,
    raw_type    TEXT,
    default_val TEXT,
    description TEXT NOT NULL,
    section     TEXT,
    malformed_emphasis INTEGER NOT NULL DEFAULT 0
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS spike_admonitions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    page_rosetta_id TEXT NOT NULL REFERENCES spike_pages(rosetta_id),
    type        TEXT NOT NULL,
    content     TEXT NOT NULL,
    fence_width INTEGER NOT NULL
  );`);
  db.run(`CREATE TABLE IF NOT EXISTS spike_links (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    page_rosetta_id TEXT NOT NULL REFERENCES spike_pages(rosetta_id),
    link_text   TEXT NOT NULL,
    raw_target  TEXT NOT NULL,
    resolved_url TEXT NOT NULL,
    resolved_rosetta_id TEXT NOT NULL
  );`);
  return db;
}

function storePage(db: Database, page: ParsedPage) {
  db.run(`INSERT OR REPLACE INTO spike_pages (rosetta_id, url, title, word_count) VALUES (?, ?, ?, ?)`, [
    page.rosettaId,
    page.url,
    page.title,
    page.wordCount,
  ]);
  db.run(`DELETE FROM spike_properties WHERE page_rosetta_id = ?`, [page.rosettaId]);
  db.run(`DELETE FROM spike_admonitions WHERE page_rosetta_id = ?`, [page.rosettaId]);
  db.run(`DELETE FROM spike_links WHERE page_rosetta_id = ?`, [page.rosettaId]);
  for (const p of page.properties) {
    db.run(
      `INSERT INTO spike_properties (page_rosetta_id, name, raw_type, default_val, description, section, malformed_emphasis) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [page.rosettaId, p.name, p.rawType, p.defaultVal, p.description, p.section, p.malformedEmphasis ? 1 : 0],
    );
  }
  for (const a of page.admonitions) {
    db.run(`INSERT INTO spike_admonitions (page_rosetta_id, type, content, fence_width) VALUES (?, ?, ?, ?)`, [
      page.rosettaId,
      a.type,
      a.content,
      a.fenceWidth,
    ]);
  }
  for (const l of page.links) {
    db.run(
      `INSERT INTO spike_links (page_rosetta_id, link_text, raw_target, resolved_url, resolved_rosetta_id) VALUES (?, ?, ?, ?, ?)`,
      [page.rosettaId, l.text, l.rawTarget, l.resolvedUrl, l.resolvedRosettaId],
    );
  }
}

async function main() {
  const urlsFile = process.argv[2];
  const dbPath = process.argv[3] || join(tmpdir(), `rosetta-spike-${Date.now()}.db`);
  const urls = urlsFile ? (await Bun.file(urlsFile).text()).split("\n").map((l) => l.trim()).filter(Boolean) : DEFAULT_URLS;

  console.log(`Scratch DB: ${dbPath}`);
  const db = openScratchDb(dbPath);

  let pagesOk = 0;
  let totalProperties = 0;
  let totalAdmonitions = 0;
  let totalLinks = 0;
  let malformedCount = 0;

  for (const urlPath of urls) {
    const page = await fetchPage(urlPath);
    if (!page) continue;
    storePage(db, page);
    pagesOk++;
    totalProperties += page.properties.length;
    totalAdmonitions += page.admonitions.length;
    totalLinks += page.links.length;
    malformedCount += page.properties.filter((p) => p.malformedEmphasis).length;
    console.log(
      `  OK ${urlPath} -> ${page.rosettaId} (${page.properties.length} props, ${page.admonitions.length} admonitions, ${page.links.length} links)`,
    );
  }

  console.log(`\nPages fetched: ${pagesOk}/${urls.length}`);
  console.log(`Total properties: ${totalProperties} (${malformedCount} with malformed emphasis)`);
  console.log(`Total admonitions: ${totalAdmonitions}`);
  console.log(`Total relative links resolved: ${totalLinks}`);

  // Cross-check: do resolved link targets correspond to a rosetta_id we (or a
  // future full crawl) would actually mint? We only fetched a sample, so most
  // resolved targets won't be in spike_pages — that's expected. What matters is
  // that resolution itself (URL-join + strip) produces a well-formed rosetta_id.
  const badLinks = db
    .query(`SELECT resolved_rosetta_id FROM spike_links WHERE resolved_rosetta_id = '' OR resolved_rosetta_id LIKE '%..%'`)
    .all() as Array<{ resolved_rosetta_id: string }>;
  console.log(`Malformed resolved rosetta-ids (empty or unresolved '..'): ${badLinks.length}`);
  if (badLinks.length > 0) {
    for (const b of badLinks.slice(0, 10)) console.log(`  BAD: ${b.resolved_rosetta_id}`);
  }

  db.close();
}

if (import.meta.main) {
  main();
}
