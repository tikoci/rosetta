#!/usr/bin/env bun

/**
 * assess-html.ts — Evaluate the Confluence HTML export for parseability.
 *
 * Analyzes all HTML files in the export directory and outputs:
 * - Page count, text volume, code blocks, table counts
 * - Property table detection (confluenceTable with Property|Description headers)
 * - Breadcrumb depth distribution
 * - Menu paths found in code blocks and body text
 * - Edge cases and anomalies
 *
 * Usage: bun run src/assess-html.ts [html-dir]
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseHTML } from "linkedom";

const HTML_DIR = process.argv[2] || resolve(import.meta.dirname, "../box/documents-export-2026-3-25/ROS");

const htmlFiles = readdirSync(HTML_DIR)
  .filter((f) => f.endsWith(".html") && f !== "index.html")
  .sort();

console.log(`Scanning ${htmlFiles.length} HTML files in ${HTML_DIR}\n`);

// Filename pattern: Slug_PageID.html or just PageID.html
const filenameRe = /^(?:(.+?)_)?(\d+)\.html$/;
// RouterOS menu path pattern
const menuPathRe = /\/[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)*/g;

interface PageInfo {
  file: string;
  pageId: number;
  slug: string;
  title: string;
  breadcrumbs: string[];
  depth: number;
  wordCount: number;
  codeBlocks: number;
  codeLines: number;
  codeLangs: string[];
  tables: number;
  propertyTables: number;
  propertyCount: number;
  menuPaths: string[];
  listProperties: number;
}

const pages: PageInfo[] = [];
const depthDist: Record<number, number> = {};
const allMenuPaths = new Set<string>();
const tablHeaderPatterns: Record<string, number> = {};
const codeLangDist: Record<string, number> = {};
const anomalies: string[] = [];

for (const file of htmlFiles) {
  const html = readFileSync(resolve(HTML_DIR, file), "utf-8");
  const { document } = parseHTML(html);

  // Parse filename
  const match = basename(file).match(filenameRe);
  const pageId = match ? Number(match[2]) : 0;
  const slug = match?.[1] || "";

  if (!pageId) {
    anomalies.push(`No page ID in filename: ${file}`);
  }

  // Title
  const titleEl = document.querySelector("#title-text");
  const title = titleEl?.textContent?.replace(/^\s*RouterOS\s*:\s*/i, "").trim() || "";

  // Breadcrumbs
  const breadcrumbs: string[] = [];
  for (const li of document.querySelectorAll("#breadcrumbs li")) {
    const a = li.querySelector("a");
    if (a) breadcrumbs.push(a.textContent?.trim() || "");
  }
  const depth = breadcrumbs.length;
  depthDist[depth] = (depthDist[depth] || 0) + 1;

  // Text content
  const mainContent = document.querySelector("#main-content");
  const text = mainContent?.textContent || "";
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // Code blocks
  const codeEls = document.querySelectorAll("pre.syntaxhighlighter-pre");
  const codeLangs: string[] = [];
  let codeLines = 0;
  for (const el of codeEls) {
    const params = el.getAttribute("data-syntaxhighlighter-params") || "";
    const brushMatch = params.match(/brush:\s*(\w+)/);
    if (brushMatch) {
      const lang = brushMatch[1];
      codeLangs.push(lang);
      codeLangDist[lang] = (codeLangDist[lang] || 0) + 1;
    }
    codeLines += (el.textContent || "").split("\n").filter((l) => l.trim()).length;
  }

  // Tables — classify headers
  const tables = document.querySelectorAll("table.confluenceTable");
  let propertyTables = 0;
  let propertyCount = 0;
  for (const table of tables) {
    const headerCells = Array.from(table.querySelectorAll("th.confluenceTh, thead th"));
    const headerText = headerCells.map((th) => th.textContent?.trim() || "").join(" | ");
    if (headerText) {
      tablHeaderPatterns[headerText] = (tablHeaderPatterns[headerText] || 0) + 1;
    }

    // Detect property tables: first header is "Property" (case-insensitive)
    const isPropertyTable = headerCells.some(
      (th) => th.textContent?.trim().toLowerCase() === "property"
    );
    if (isPropertyTable) {
      propertyTables++;
      // Count data rows (skip header)
      const rows = table.querySelectorAll("tbody tr");
      // First row might be header in tbody (no thead)
      const firstRowIsHeader = headerCells.length > 0;
      propertyCount += Math.max(0, rows.length - (firstRowIsHeader ? 1 : 0));
    }
  }

  // List-based properties: <ul>/<li> with <strong> followed by parenthetical type
  let listProperties = 0;
  if (mainContent) {
    for (const li of mainContent.querySelectorAll("ul > li")) {
      const strong = li.querySelector("strong");
      if (strong && li.textContent?.includes("(")) {
        listProperties++;
      }
    }
  }

  // Menu paths from code blocks and body
  const menuPaths: string[] = [];
  const bodyText = mainContent?.textContent || "";
  for (const m of bodyText.matchAll(menuPathRe)) {
    const p = m[0];
    // Filter noise: must be at least 2 segments and look like a RouterOS path
    if (p.split("/").length >= 3 && !p.includes("http") && !p.includes("www")) {
      menuPaths.push(p);
      allMenuPaths.add(p);
    }
  }

  pages.push({
    file,
    pageId,
    slug,
    title,
    breadcrumbs,
    depth,
    wordCount,
    codeBlocks: codeEls.length,
    codeLines,
    codeLangs: [...new Set(codeLangs)],
    tables: tables.length,
    propertyTables,
    propertyCount,
    menuPaths: [...new Set(menuPaths)],
    listProperties,
  });
}

// Summary stats
const totalWords = pages.reduce((s, p) => s + p.wordCount, 0);
const totalCodeLines = pages.reduce((s, p) => s + p.codeLines, 0);
const totalCodeBlocks = pages.reduce((s, p) => s + p.codeBlocks, 0);
const totalTables = pages.reduce((s, p) => s + p.tables, 0);
const totalPropertyTables = pages.reduce((s, p) => s + p.propertyTables, 0);
const totalProperties = pages.reduce((s, p) => s + p.propertyCount, 0);
const totalListProps = pages.reduce((s, p) => s + p.listProperties, 0);
const pagesWithPropertyTables = pages.filter((p) => p.propertyTables > 0).length;
const pagesWithMenuPaths = pages.filter((p) => p.menuPaths.length > 0).length;
const pagesWithCode = pages.filter((p) => p.codeBlocks > 0).length;

console.log("=== HTML Archive Assessment ===\n");
console.log(`Pages:              ${pages.length}`);
console.log(`Total words:        ${totalWords.toLocaleString()}`);
console.log(`Total code blocks:  ${totalCodeBlocks}`);
console.log(`Total code lines:   ${totalCodeLines.toLocaleString()}`);
console.log(`Pages with code:    ${pagesWithCode}`);
console.log(`Total tables:       ${totalTables}`);
console.log(`Property tables:    ${totalPropertyTables} (in ${pagesWithPropertyTables} pages)`);
console.log(`Properties (table): ${totalProperties}`);
console.log(`Properties (list):  ${totalListProps}`);
console.log(`Unique menu paths:  ${allMenuPaths.size}`);
console.log(`Pages w/ menu path: ${pagesWithMenuPaths}`);

console.log("\n--- Breadcrumb Depth Distribution ---");
for (const [depth, count] of Object.entries(depthDist).sort(([a], [b]) => +a - +b)) {
  console.log(`  depth ${depth}: ${count} pages`);
}

console.log("\n--- Code Language Distribution ---");
for (const [lang, count] of Object.entries(codeLangDist).sort(([, a], [, b]) => b - a)) {
  console.log(`  ${lang}: ${count} blocks`);
}

console.log("\n--- Table Header Patterns (top 20) ---");
const sortedHeaders = Object.entries(tablHeaderPatterns).sort(([, a], [, b]) => b - a);
for (const [header, count] of sortedHeaders.slice(0, 20)) {
  console.log(`  [${count}x] ${header}`);
}

console.log("\n--- Largest Pages (by word count) ---");
const byWords = [...pages].sort((a, b) => b.wordCount - a.wordCount);
for (const p of byWords.slice(0, 15)) {
  console.log(`  ${p.wordCount.toLocaleString()} words — ${p.title || p.file} (${p.propertyTables} prop tables, ${p.codeBlocks} code blocks)`);
}

console.log("\n--- Pages Without Property Tables (sample) ---");
const noProps = pages.filter((p) => p.propertyTables === 0 && p.wordCount > 100);
for (const p of noProps.slice(0, 10)) {
  console.log(`  ${p.title || p.file} — ${p.wordCount} words, ${p.tables} tables, ${p.listProperties} list props`);
}

if (anomalies.length > 0) {
  console.log("\n--- Anomalies ---");
  for (const a of anomalies) console.log(`  ${a}`);
}

// Top menu paths
console.log("\n--- Unique Menu Paths (sample, top 30) ---");
const sortedPaths = [...allMenuPaths].sort();
for (const p of sortedPaths.slice(0, 30)) {
  console.log(`  ${p}`);
}

// Write summary JSON
const summary = {
  pageCount: pages.length,
  totalWords,
  totalCodeBlocks,
  totalCodeLines,
  totalTables,
  totalPropertyTables,
  totalProperties,
  totalListProps,
  uniqueMenuPaths: allMenuPaths.size,
  depthDistribution: depthDist,
  codeLangDistribution: codeLangDist,
  tableHeaderPatterns: Object.fromEntries(sortedHeaders),
  pages: pages.map((p) => ({
    file: p.file,
    pageId: p.pageId,
    title: p.title,
    depth: p.depth,
    wordCount: p.wordCount,
    codeBlocks: p.codeBlocks,
    tables: p.tables,
    propertyTables: p.propertyTables,
    propertyCount: p.propertyCount,
    listProperties: p.listProperties,
    menuPaths: p.menuPaths,
  })),
};

const outPath = resolve(import.meta.dirname, "../ros-html-assessment.json");
await Bun.write(outPath, JSON.stringify(summary, null, 2));
console.log(`\nFull assessment written to ${outPath}`);
