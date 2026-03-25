#!/usr/bin/env bun

/**
 * extract-properties.ts — Parse confluenceTable property tables from HTML.
 *
 * For each page in the DB, re-reads the HTML file and extracts property tables:
 *   - Tables with "Property" in the first header cell
 *   - Each row: name (from <strong>), type (from <em>), default, description
 *   - Section heading: nearest h1/h2/h3 above the table
 *
 * Usage: bun run src/extract-properties.ts [html-dir]
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseHTML } from "linkedom";
import { db, initDb } from "./db.ts";

const HTML_DIR =
  process.argv[2] || resolve(import.meta.dirname, "../box/documents-export-2026-3-25/ROS");

/**
 * Parse the first cell of a property row to extract name, type, and default value.
 *
 * Patterns observed:
 *   <strong>name</strong> (<em>type</em>; Default: <strong>value</strong>)
 *   <strong>name</strong> (<em>type</em>; Default: value)
 *   <strong>name</strong> (<em>type</em>)
 *   <strong>name</strong>
 */
function parsePropertyCell(td: Element): { name: string; type: string | null; defaultVal: string | null } | null {
  // Get the property name from the first <strong> element
  const strongEl = td.querySelector("strong");
  if (!strongEl) return null;

  const name = strongEl.textContent?.trim() || "";
  if (!name || name.length > 80) return null;

  // Get the full cell text for type and default parsing
  const cellText = td.textContent?.trim() || "";

  // Extract type from <em> tag
  let type: string | null = null;
  const emEl = td.querySelector("em");
  if (emEl) {
    type = emEl.textContent?.trim() || null;
    // Clean up trailing punctuation
    if (type) type = type.replace(/[);,\s]+$/, "").trim();
  }

  // Extract default value — look for "Default:" pattern in cell text
  let defaultVal: string | null = null;
  const defaultMatch = cellText.match(/Default:\s*(.+?)(?:\)|$)/i);
  if (defaultMatch) {
    defaultVal = defaultMatch[1].trim();
    // Remove trailing parenthesis or semicolons
    defaultVal = defaultVal.replace(/[)\s]+$/, "").trim() || null;
  }

  return { name, type, defaultVal };
}

/** Get plain text from an element, stripping HTML. */
function plainText(el: Element): string {
  return (el.textContent || "").trim().replace(/\s+/g, " ");
}

interface PropertyRow {
  pageId: number;
  name: string;
  type: string | null;
  defaultVal: string | null;
  description: string;
  section: string | null;
  sortOrder: number;
}

function extractProperties(pageId: number, htmlFile: string): PropertyRow[] {
  const html = readFileSync(resolve(HTML_DIR, htmlFile), "utf-8");
  const { document } = parseHTML(html);
  const mainContent = document.querySelector("#main-content");
  if (!mainContent) return [];

  const properties: PropertyRow[] = [];
  let sortOrder = 0;

  // Build a map of element → nearest preceding heading for section context.
  // Walk all children of main-content and track the current heading.
  let currentHeading: string | null = null;
  const headingMap = new Map<Element, string | null>();

  // We need to find tables and their preceding headings.
  // Walk through all elements in document order.
  const allElements = mainContent.querySelectorAll("*");
  for (const el of allElements) {
    const tag = el.tagName?.toLowerCase();
    if (tag === "h1" || tag === "h2" || tag === "h3") {
      currentHeading = el.textContent?.trim() || null;
    }
    if (tag === "table") {
      headingMap.set(el, currentHeading);
    }
  }

  // Process each confluenceTable
  const tables = mainContent.querySelectorAll("table.confluenceTable, table.wrapped");
  for (const table of tables) {
    // Check if this is a property table by looking at header cells
    const headerCells = table.querySelectorAll("th.confluenceTh, thead th");
    const hasPropertyHeader = Array.from(headerCells).some((th) => {
      const text = th.textContent?.trim().toLowerCase() || "";
      return text === "property" || text === "read-only property";
    });
    if (!hasPropertyHeader) continue;

    const section = headingMap.get(table) || null;

    // Process data rows (all <tr> in <tbody>, skip header row)
    const rows = table.querySelectorAll("tbody tr");
    let isFirstRow = true;
    for (const row of rows) {
      const cells = row.querySelectorAll("td.confluenceTd, td");
      // Skip header rows (th cells, not td)
      const thCells = row.querySelectorAll("th.confluenceTh, th");
      if (thCells.length > 0 && cells.length === 0) {
        isFirstRow = false;
        continue;
      }
      // Also skip if first row has header-like content
      if (isFirstRow && thCells.length > 0) {
        isFirstRow = false;
        continue;
      }
      isFirstRow = false;

      if (cells.length < 2) continue;

      const parsed = parsePropertyCell(cells[0]);
      if (!parsed) continue;

      const description = plainText(cells[1]);
      if (!description && !parsed.type) continue;

      properties.push({
        pageId,
        name: parsed.name,
        type: parsed.type,
        defaultVal: parsed.defaultVal,
        description: description || "",
        section,
        sortOrder: sortOrder++,
      });
    }
  }

  return properties;
}

// ---- Main ----

console.log("Initializing database...");
initDb();

// Clear existing properties for clean re-extraction
db.run("DELETE FROM properties;");
db.run("INSERT INTO properties_fts(properties_fts) VALUES('rebuild');");

// Get all pages that have HTML files
type PageRef = { id: number; html_file: string; title: string };
const pages = db.prepare("SELECT id, html_file, title FROM pages").all() as PageRef[];

const insert = db.prepare(`
  INSERT OR IGNORE INTO properties
    (page_id, name, type, default_val, description, section, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

let totalProperties = 0;
let pagesWithProps = 0;

const insertAll = db.transaction(() => {
  for (const page of pages) {
    const props = extractProperties(page.id, page.html_file);
    if (props.length > 0) {
      pagesWithProps++;
      for (const p of props) {
        insert.run(p.pageId, p.name, p.type, p.defaultVal, p.description, p.section, p.sortOrder);
        totalProperties++;
      }
    }
  }
});
insertAll();

const ftsCount = (db.prepare("SELECT COUNT(*) as c FROM properties_fts").get() as { c: number }).c;

console.log(`\nProperty extraction complete:`);
console.log(`  Properties extracted: ${totalProperties}`);
console.log(`  Pages with properties: ${pagesWithProps}`);
console.log(`  FTS index rows: ${ftsCount}`);

// Sample output
console.log(`\nSample properties from DHCP page:`);
const dhcpProps = db
  .prepare(
    `SELECT name, type, default_val, section
     FROM properties
     WHERE page_id = (SELECT id FROM pages WHERE title = 'DHCP')
     ORDER BY sort_order LIMIT 10`,
  )
  .all() as Array<{ name: string; type: string; default_val: string; section: string }>;

for (const p of dhcpProps) {
  console.log(`  ${p.name} (${p.type || "?"}) [default: ${p.default_val || "none"}] — ${p.section}`);
}

// Test FTS search
console.log(`\nSearch for "gateway":`);
const results = db
  .prepare(
    `SELECT p.name, p.type, p.default_val, pg.title as page_title, p.section,
            snippet(properties_fts, 1, '>>>', '<<<', '...', 20) as excerpt
     FROM properties_fts fts
     JOIN properties p ON p.id = fts.rowid
     JOIN pages pg ON pg.id = p.page_id
     WHERE properties_fts MATCH 'gateway'
     ORDER BY rank LIMIT 5`,
  )
  .all() as Array<{ name: string; type: string; default_val: string; page_title: string; section: string; excerpt: string }>;

for (const r of results) {
  console.log(`  ${r.name} [${r.page_title} / ${r.section}]`);
  console.log(`    ${r.excerpt}`);
}
