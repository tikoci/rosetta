#!/usr/bin/env bun

/**
 * extract-html.ts — Parse Confluence HTML export into SQLite pages table.
 *
 * Reads all HTML files from the export directory, extracts:
 *   - Page ID and slug from filename
 *   - Title from #title-text (stripped of "RouterOS : " prefix)
 *   - Breadcrumb path from #breadcrumbs
 *   - Parent page ID from last breadcrumb link
 *   - Plain text from #main-content (HTML stripped)
 *   - Code blocks from pre.syntaxhighlighter-pre
 *   - Author and last_updated from .page-metadata
 *
 * Populates: pages, pages_fts, callouts, callouts_fts (via triggers)
 *
 * Usage: bun run src/extract-html.ts [html-dir]
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parseHTML } from "linkedom";
import { db, initDb } from "./db.ts";

const HTML_DIR =
  process.argv[2] || resolve(import.meta.dirname, "../box/documents-export-2026-3-25/ROS");

// Filename pattern: Slug_PageID.html or just PageID.html
const filenameRe = /^(?:(.+?)_)?(\d+)\.html$/;

interface PageRow {
  id: number;
  slug: string;
  title: string;
  path: string;
  depth: number;
  parent_id: number | null;
  url: string;
  text: string;
  code: string;
  code_lang: string | null;
  author: string | null;
  last_updated: string | null;
  word_count: number;
  code_lines: number;
  html_file: string;
}

interface CalloutRow {
  page_id: number;
  type: string;
  content: string;
  sort_order: number;
}

function extractPageId(href: string): number | null {
  const m = basename(href).match(filenameRe);
  return m ? Number(m[2]) : null;
}

function textContent(el: Element | null): string {
  return el?.textContent?.trim() || "";
}

function extractPage(file: string, html: string): (PageRow & { callouts: CalloutRow[] }) | null {
  const { document } = parseHTML(html);

  const match = basename(file).match(filenameRe);
  if (!match) return null;

  const slug = match[1] || String(match[2]);
  const id = Number(match[2]);

  // Title: strip "RouterOS : " prefix
  const title = textContent(document.querySelector("#title-text"))
    .replace(/^\s*RouterOS\s*:\s*/i, "")
    .trim();

  if (!title) return null;

  // Breadcrumbs
  const breadcrumbLinks = document.querySelectorAll("#breadcrumbs li a");
  const breadcrumbs: string[] = [];
  let parentId: number | null = null;
  for (const a of breadcrumbLinks) {
    breadcrumbs.push(textContent(a));
    const href = a.getAttribute("href") || "";
    parentId = extractPageId(href);
  }
  const path = [...breadcrumbs, title].join(" > ");
  const depth = breadcrumbs.length + 1;

  // URL: Confluence pattern
  const urlSlug = encodeURIComponent(title.replace(/ /g, "+"));
  const url = `https://help.mikrotik.com/docs/spaces/ROS/pages/${id}/${urlSlug}`;

  // Main content
  const mainContent = document.querySelector("#main-content");

  // Code blocks — extract before stripping HTML
  const codeEls = mainContent?.querySelectorAll("pre.syntaxhighlighter-pre") || [];
  const codeChunks: string[] = [];
  const codeLangs = new Set<string>();
  for (const el of codeEls) {
    codeChunks.push(el.textContent?.trim() || "");
    const params = el.getAttribute("data-syntaxhighlighter-params") || "";
    const brushMatch = params.match(/brush:\s*(\w+)/);
    if (brushMatch) codeLangs.add(brushMatch[1]);
  }
  const code = codeChunks.join("\n\n");
  const codeLang = codeLangs.size > 0 ? [...codeLangs].join(",") : null;
  const codeLines = code.split("\n").filter((l) => l.trim()).length;

  // Plain text from main content (includes code block text too, which is fine for FTS)
  const text = mainContent?.textContent?.trim() || "";
  const wordCount = text.split(/\s+/).filter(Boolean).length;

  // Callouts: extract note/warning/info blocks
  const calloutEls = mainContent?.querySelectorAll('div[role="region"].confluence-information-macro') || [];
  const callouts: CalloutRow[] = [];
  let calloutOrder = 0;
  for (const el of calloutEls) {
    const label = (el.getAttribute("aria-label") || "").toLowerCase().trim();
    const type = label === "warning" ? "warning" : label === "note" ? "note" : label === "info" ? "info" : label || "note";
    const body = el.querySelector(".confluence-information-macro-body");
    const content = body?.textContent?.trim() || "";
    if (content) {
      callouts.push({ page_id: id, type, content, sort_order: calloutOrder++ });
    }
  }

  // Metadata: author, last_updated
  const metaEl = document.querySelector(".page-metadata");
  const metaText = metaEl?.textContent || "";
  const authorMatch = metaText.match(/Created by\s+(.+?)(?:,|\s*last)/i);
  const author = authorMatch?.[1]?.trim() || null;
  const dateMatch = metaText.match(/on\s+(\w+ \d{1,2}, \d{4})/);
  const lastUpdated = dateMatch?.[1] || null;

  return {
    id,
    slug,
    title,
    path,
    depth,
    parent_id: parentId,
    url,
    text,
    code,
    code_lang: codeLang,
    author,
    last_updated: lastUpdated,
    word_count: wordCount,
    code_lines: codeLines,
    html_file: file,
    callouts,
  };
}

// ---- Main ----

console.log("Initializing database...");
initDb();

// Drop existing data for clean re-extraction (respect FK order)
db.run("DELETE FROM callouts;");
db.run("INSERT INTO callouts_fts(callouts_fts) VALUES('rebuild');");
db.run("DELETE FROM properties;");
db.run("INSERT INTO properties_fts(properties_fts) VALUES('rebuild');");
db.run("PRAGMA foreign_keys = OFF;");
db.run("DELETE FROM pages;");
db.run("PRAGMA foreign_keys = ON;");
db.run("INSERT INTO pages_fts(pages_fts) VALUES('rebuild');");

const htmlFiles = readdirSync(HTML_DIR)
  .filter((f) => f.endsWith(".html") && f !== "index.html")
  .sort();

console.log(`Extracting ${htmlFiles.length} HTML files from ${HTML_DIR}`);

// Two-pass insert: first without parent_id (avoids FK ordering issues),
// then update parent relationships.
const insertPage = db.prepare(`
  INSERT OR REPLACE INTO pages
    (id, slug, title, path, depth, parent_id, url, text, code, code_lang,
     author, last_updated, word_count, code_lines, html_file)
  VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const updateParent = db.prepare("UPDATE pages SET parent_id = ? WHERE id = ?");

let extracted = 0;
let skipped = 0;
let totalWords = 0;
let totalCodeLines = 0;
let totalCallouts = 0;

const allPages: (PageRow & { callouts: CalloutRow[] })[] = [];

// Pass 1: extract and insert all pages (parent_id = NULL)
const insertAll = db.transaction(() => {
  for (const file of htmlFiles) {
    const html = readFileSync(resolve(HTML_DIR, file), "utf-8");
    const page = extractPage(file, html);
    if (!page) {
      skipped++;
      console.warn(`  skipped: ${file}`);
      continue;
    }
    insertPage.run(
      page.id,
      page.slug,
      page.title,
      page.path,
      page.depth,
      page.url,
      page.text,
      page.code,
      page.code_lang,
      page.author,
      page.last_updated,
      page.word_count,
      page.code_lines,
      page.html_file,
    );
    allPages.push(page);
    extracted++;
    totalWords += page.word_count;
    totalCodeLines += page.code_lines;
  }
});
insertAll();

// Pass 2: set parent_id where the parent actually exists in the DB
const pageIds = new Set(allPages.map((p) => p.id));
const setParents = db.transaction(() => {
  for (const page of allPages) {
    if (page.parent_id && pageIds.has(page.parent_id)) {
      updateParent.run(page.parent_id, page.id);
    }
  }
});
setParents();

// Pass 3: insert callouts
const insertCallout = db.prepare(`
  INSERT INTO callouts (page_id, type, content, sort_order)
  VALUES (?, ?, ?, ?)
`);
const insertCallouts = db.transaction(() => {
  for (const page of allPages) {
    for (const c of page.callouts) {
      insertCallout.run(c.page_id, c.type, c.content, c.sort_order);
      totalCallouts++;
    }
  }
});
insertCallouts();

const ftsCount = (db.prepare("SELECT COUNT(*) as c FROM pages_fts").get() as { c: number }).c;

console.log(`\nExtraction complete:`);
console.log(`  Pages extracted: ${extracted}`);
console.log(`  Pages skipped:   ${skipped}`);
console.log(`  Total words:     ${totalWords.toLocaleString()}`);
console.log(`  Total code lines: ${totalCodeLines.toLocaleString()}`);
console.log(`  Total callouts:  ${totalCallouts}`);
console.log(`  FTS index rows:  ${ftsCount}`);

// Quick search test
const testResults = db
  .prepare(
    `SELECT s.id, s.title, s.path,
            snippet(pages_fts, 2, '>>>', '<<<', '...', 20) as excerpt
     FROM pages_fts fts
     JOIN pages s ON s.id = fts.rowid
     WHERE pages_fts MATCH 'firewall filter'
     ORDER BY rank LIMIT 5`,
  )
  .all();

console.log(`\nTest search for "firewall filter":`);
for (const r of testResults as Array<{ id: number; title: string; path: string; excerpt: string }>) {
  console.log(`  [${r.id}] ${r.path}`);
  console.log(`    ${r.excerpt}`);
}
