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
  process.argv[2] || resolve(import.meta.dirname, "../box/latest/ROS");

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

interface SectionRow {
  page_id: number;
  heading: string;
  level: number;
  anchor_id: string;
  text: string;
  code: string;
  word_count: number;
  sort_order: number;
}

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
]);

/**
 * Remove Confluence TOC style leakage that may survive DOM cleanup when HTML is malformed.
 * Keeps cleanup narrow to rbtoc CSS so normal content is not affected.
 */
export function sanitizeExtractedText(input: string): string {
  if (!input) return "";

  return input
    // Full CDATA-wrapped TOC style block.
    .replace(/\/\*<!\[CDATA\[\*\/[\s\S]*?\/\*\]\]>\*\//g, "")
    // Bare TOC CSS lines that can leak without wrappers.
    .replace(/^\s*div\.rbtoc\d+[^\n]*(?:\n\s*div\.rbtoc\d+[^\n]*)*/gm, "")
    // Any orphaned CDATA markers.
    .replace(/\/\*<!\[CDATA\[\*\//g, "")
    .replace(/\/\*\]\]>\*\//g, "")
    // Prevent giant gaps in rendered output.
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Convert a DOM subtree to readable text with lightweight markdown signals.
 * Preserves block boundaries (avoids "OverviewThe" token merge) and emits:
 *   - Heading markers: ## Heading (matching h1–h6 level)
 *   - List markers: - item (ul) or 1. item (ol)
 *   - Emphasis: **bold** for <strong>/<b>, `code` for <code>
 */
export function extractPlainText(root: Element | null): string {
  if (!root) return "";

  let out = "";
  let olCounter = 0;

  const addBreak = () => {
    if (!out) return;
    if (!out.endsWith("\n")) out += "\n";
  };

  const addText = (text: string) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return;
    if (out && !out.endsWith("\n") && !out.endsWith(" ")) out += " ";
    out += normalized;
  };

  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      addText(node.textContent || "");
      return;
    }

    if (node.nodeType !== 1) return;

    const el = node as Element;
    const tag = el.tagName.toLowerCase();

    if (tag === "style" || tag === "script" || tag === "noscript") return;
    if (tag === "br") {
      addBreak();
      return;
    }

    // Heading markers: ## Heading
    const headingMatch = tag.match(/^h([1-6])$/);
    if (headingMatch) {
      addBreak();
      const level = Number.parseInt(headingMatch[1], 10);
      const prefix = "#".repeat(level);
      const headingText = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (headingText) {
        addText(`${prefix} ${headingText}`);
      }
      addBreak();
      return; // don't recurse into heading children — already captured via textContent
    }

    // Ordered list: reset counter
    if (tag === "ol") {
      const savedCounter = olCounter;
      olCounter = 0;
      addBreak();
      for (const child of el.childNodes) {
        walk(child as unknown as Node);
      }
      addBreak();
      olCounter = savedCounter;
      return;
    }

    // Unordered list
    if (tag === "ul") {
      addBreak();
      for (const child of el.childNodes) {
        walk(child as unknown as Node);
      }
      addBreak();
      return;
    }

    // List item: prefix with - or N.
    if (tag === "li") {
      addBreak();
      const parentTag = (el.parentElement?.tagName || "").toLowerCase();
      if (parentTag === "ol") {
        olCounter++;
        addText(`${olCounter}.`);
      } else {
        addText("-");
      }
      for (const child of el.childNodes) {
        walk(child as unknown as Node);
      }
      addBreak();
      return;
    }

    // Inline emphasis: **bold**
    if (tag === "strong" || tag === "b") {
      const inner = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (inner) {
        addText(`**${inner}**`);
      }
      return; // don't recurse — already captured
    }

    // Inline code: `code`
    if (tag === "code") {
      const inner = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (inner) {
        addText(`\`${inner}\``);
      }
      return; // don't recurse — already captured
    }

    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) addBreak();

    for (const child of el.childNodes) {
      walk(child as unknown as Node);
    }

    if (isBlock) addBreak();
  };

  walk(root as unknown as Node);

  return out
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Split main content into sections by h1–h3 headings with id attributes.
 * Uses innerHTML + regex to locate heading boundaries, then parses each
 * section chunk independently for text and code extraction.
 */
function extractSections(mainContent: Element, pageId: number): SectionRow[] {
  const html = mainContent.innerHTML;
  const headingRe = /<h([1-3])\s[^>]*?id="([^"]+)"[^>]*>([\s\S]*?)<\/h\1>/g;

  const headings: Array<{
    level: number;
    anchorId: string;
    heading: string;
    start: number;
    end: number;
  }> = [];

  for (let m = headingRe.exec(html); m !== null; m = headingRe.exec(html)) {
    if (m[2] === "title-heading") continue;
    headings.push({
      level: Number.parseInt(m[1], 10),
      anchorId: m[2],
      heading: parseHTML(`<span>${m[3]}</span>`).document.querySelector("span")?.textContent?.trim() || "",
      start: m.index,
      end: m.index + m[0].length,
    });
  }

  if (headings.length === 0) return [];

  return headings.map((h, i) => {
    const sectionHtml = html.slice(h.end, headings[i + 1]?.start ?? html.length);
    const { document: doc } = parseHTML(`<div>${sectionHtml}</div>`);
    const root = doc.querySelector("div");

    const codeEls = root?.querySelectorAll("pre.syntaxhighlighter-pre") ?? [];
    const codeChunks: string[] = [];
    for (const ce of codeEls) {
      codeChunks.push(ce.textContent?.trim() || "");
    }

    const text = sanitizeExtractedText(extractPlainText(root));
    const code = codeChunks.join("\n\n");

    return {
      page_id: pageId,
      heading: h.heading,
      level: h.level,
      anchor_id: h.anchorId,
      text,
      code,
      word_count: text.split(/\s+/).filter(Boolean).length,
      sort_order: i,
    };
  });
}

function extractPageId(href: string): number | null {
  const m = basename(href).match(filenameRe);
  return m ? Number(m[2]) : null;
}

function textContent(el: Element | null): string {
  return el?.textContent?.trim() || "";
}

function extractPage(file: string, html: string): (PageRow & { callouts: CalloutRow[]; sections: SectionRow[] }) | null {
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

  // Remove <style> elements before extracting text — they contain Confluence
  // table-of-contents CSS (CDATA blocks like div.rbtoc... {padding:0}) that
  // otherwise pollute the plain-text index and appear in page views.
  for (const styleEl of mainContent?.querySelectorAll("style") ?? []) {
    styleEl.remove();
  }

  // Plain text from main content (includes code block text too, which is fine for FTS)
  const text = sanitizeExtractedText(extractPlainText(mainContent));
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

  // Sections: split content by h1–h3 headings
  const sections = mainContent ? extractSections(mainContent, id) : [];

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
    sections,
  };
}

// ---- Main ----

function main() {
  console.log("Initializing database...");
  initDb();

// Drop existing data for clean re-extraction (respect FK order)
  db.run("DELETE FROM sections;");
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

  const allPages: (PageRow & { callouts: CalloutRow[]; sections: SectionRow[] })[] = [];

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

// Pass 4: insert sections
  let totalSections = 0;
  let pagesWithSections = 0;
  const insertSection = db.prepare(`
  INSERT INTO sections (page_id, heading, level, anchor_id, text, code, word_count, sort_order)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
  const insertSections = db.transaction(() => {
    for (const page of allPages) {
      if (page.sections.length > 0) {
        pagesWithSections++;
        for (const s of page.sections) {
          insertSection.run(s.page_id, s.heading, s.level, s.anchor_id, s.text, s.code, s.word_count, s.sort_order);
          totalSections++;
        }
      }
    }
  });
  insertSections();

  const ftsCount = (db.prepare("SELECT COUNT(*) as c FROM pages_fts").get() as { c: number }).c;

  console.log(`\nExtraction complete:`);
  console.log(`  Pages extracted: ${extracted}`);
  console.log(`  Pages skipped:   ${skipped}`);
  console.log(`  Total words:     ${totalWords.toLocaleString()}`);
  console.log(`  Total code lines: ${totalCodeLines.toLocaleString()}`);
  console.log(`  Total callouts:  ${totalCallouts}`);
  console.log(`  Total sections:  ${totalSections} (across ${pagesWithSections} pages)`);
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
}

if (import.meta.main) {
  main();
}
