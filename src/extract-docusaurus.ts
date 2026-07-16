#!/usr/bin/env bun

/**
 * extract-docusaurus.ts — Parse manual.mikrotik.com /docs prose into SQLite.
 *
 * Replaces extract-html.ts's role for fresh prose extraction (extract-html.ts stays
 * for rebuilding historical Confluence-era release DBs only — see MANUAL.md and
 * DESIGN.md). Scope: /docs/** prose only — CLI Reference (/docs/cli-reference/*) and
 * /docs/tags/* are excluded (separate, not-yet-built tasks per B-0012's "Proposed
 * migration task files" #2/#3), and the standalone /hardware section is a different
 * URL prefix entirely, out of scope here.
 *
 * Discovers pages via sitemap.xml, fetches each page's raw Markdown (`{url}.md`),
 * and populates pages/sections/properties/callouts using the rosetta-id scheme
 * validated by T-0034 (see src/rosetta-id.ts, briefings/B-0012-docusaurus-manual-migration.md
 * "H7 — Identity / rosetta-id design").
 *
 * Usage:
 *   bun run src/extract-docusaurus.ts                  # live fetch, caches .md to CACHE_DIR
 *   bun run src/extract-docusaurus.ts --from-cache      # re-extract from CACHE_DIR, no network
 *   bun run src/extract-docusaurus.ts --limit=25        # cap page count (smoke-testing)
 *   bun run src/extract-docusaurus.ts --check-counts    # compare extracted count vs llms.txt (non-blocking)
 *   bun run src/extract-docusaurus.ts --check-counts --strict  # same, but exit 1 on mismatch
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { db, initDb } from "./db.ts";
import { deriveRosettaId, loadSitemapUrls, rosettaIdToUrl } from "./rosetta-id.ts";

const BASE = "https://manual.mikrotik.com";
const SITEMAP_URL = `${BASE}/sitemap.xml`;
const LLMS_TXT_URL = `${BASE}/llms.txt`;
const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_CACHE_DIR = join(PROJECT_ROOT, "manual", "pages");
const FETCH_DELAY_MS = 100;

// ── CLI flags ──

const argv = process.argv.slice(2);
const FROM_CACHE = argv.includes("--from-cache");
const CHECK_COUNTS = argv.includes("--check-counts");
const STRICT = argv.includes("--strict");
const limitArg = argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
const cacheDirArg = argv.find((a) => a.startsWith("--cache-dir="));
const CACHE_DIR = cacheDirArg ? cacheDirArg.slice("--cache-dir=".length) : DEFAULT_CACHE_DIR;

// ── Scope filter ──

/**
 * In scope: /docs/** prose only, excluding CLI Reference and the tag-index pages.
 * The standalone /hardware/* section uses a different URL prefix and is already
 * excluded by the leading "/docs/" check.
 */
export function isInScopeDocsUrl(urlOrPath: string): boolean {
  let path: string;
  try {
    path = new URL(urlOrPath).pathname;
  } catch {
    path = urlOrPath;
  }
  if (!path.startsWith("/docs/")) return false;
  // Strip an optional Docusaurus version prefix (/docs/next/… or /docs/<semver>/…)
  // before the exclusion checks so versioned CLI-reference/tag pages are excluded the
  // same as unversioned ones — mirrors deriveRosettaId()'s version handling.
  // manual.mikrotik.com is unversioned today, but B-0012 H7 treats this as cheap now.
  path = path.replace(/^\/docs\/(?:next|v?\d+(?:\.\d+)*(?:-[a-z0-9.]+)?)\//, "/docs/");
  if (path.startsWith("/docs/cli-reference/")) return false;
  // The tag-index root ("/docs/tags", no trailing slash, no real .md content —
  // confirmed live 2026-07-07: 404s) and individual tag pages both excluded.
  if (path === "/docs/tags" || path.startsWith("/docs/tags/")) return false;
  return true;
}

// ── Markdown parsing ──

export interface ParsedProperty {
  name: string;
  rawType: string | null;
  defaultVal: string | null;
  description: string;
  /** Raw text of the nearest preceding heading of ANY level (h1–h6). Retained as-is for
   * compatibility; `sectionAnchor` is the resolvable identity. See attributeSection(). */
  section: string | null;
  /** anchor_id of the enclosing h1–h3 section, or null if the page has no heading context yet. */
  sectionAnchor: string | null;
  /** 0-based index of the source line this property was parsed from. */
  line: number;
  /** Source line of the generic table row that produced this property, or null for bullets. */
  sourceTableRowLine: number | null;
  malformedEmphasis: boolean;
}

export interface ParsedTableRow {
  cells: string[];
  /** 0-based source line of this row. */
  line: number;
}

export interface ParsedTable {
  header: ParsedTableRow;
  rows: ParsedTableRow[];
  /** Exact source Markdown for the header, delimiter, and data rows. */
  rawMarkdown: string;
  columnCount: number;
  dataRowCount: number;
  isRagged: boolean;
  sortOrder: number;
  /** Raw nearest h1-h6 heading text, distinct from the enclosing retrieval section. */
  sourceHeading: string | null;
  /** anchor_id of the enclosing h1-h3 section, resolved by parsePage(). */
  sectionAnchor: string | null;
  /** 0-based source line of the header row. */
  line: number;
}

export interface ParsedCallout {
  type: string;
  content: string;
  sortOrder: number;
  /** anchor_id of the enclosing h1–h3 section, or null if the page has no heading context yet. */
  sectionAnchor: string | null;
  /** 0-based index of the source line the callout's opening fence sits on. */
  line: number;
}

export interface ParsedSection {
  heading: string;
  level: number;
  anchorId: string;
  text: string;
  code: string;
  wordCount: number;
  sortOrder: number;
  /** 0-based index of this section's own heading line — the anchor for line-range attribution. */
  headingLine: number;
}

export interface ParsedPage {
  rosettaId: string;
  url: string;
  slug: string;
  title: string;
  path: string;
  depth: number;
  text: string;
  code: string;
  codeLang: string | null;
  wordCount: number;
  codeLines: number;
  sections: ParsedSection[];
  tables: ParsedTable[];
  properties: ParsedProperty[];
  callouts: ParsedCallout[];
}

/** GitHub-slugger-style approximation of Docusaurus's auto-generated heading anchors. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Tracks whether the current line is inside a fenced code block (``` ... ```).
 * RouterOS example scripts use `#` for comments (e.g. `# Drop ARP frames...`), which
 * looks exactly like a Markdown heading to a naive line-by-line regex — without this,
 * heading/section-context detection misfires inside code fences (found via dot1x.md's
 * `RouterOS Authenticator configuration` example, which contains several `# ...` comment
 * lines that were wrongly detected as new top-level page sections).
 */
function makeFenceTracker() {
  let fence: { char: "`" | "~"; width: number } | null = null;
  return (line: string): boolean => {
    // Fences may be indented up to three spaces or begin on an ordered/unordered list item
    // (`9. ```ros` in zerotier.md). Recognizing the list opener keeps its indented closing
    // fence from looking like a new, unterminated block that hides the rest of the page.
    const match = line.match(/^(?:\s{0,3}|\s*(?:[-+*]|\d+\.)\s+)(`{3,}|~{3,})(.*)$/);
    if (match) {
      const char = match[1][0] as "`" | "~";
      if (fence === null) {
        fence = { char, width: match[1].length };
      } else if (char === fence.char && match[1].length >= fence.width && match[2].trim() === "") {
        fence = null;
      }
      return true;
    }
    return fence !== null;
  };
}

/** Split a Markdown table row into cells, respecting `\|` as an escaped literal pipe. */
export function splitTableRow(line: string): string[] {
  const trimmed = line.trim();
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
  // Strip only the synthetic cells created by outer delimiter pipes. Empty real cells
  // immediately inside those delimiters must survive (`| | value | |` -> ["", "value", ""]).
  if (trimmed.startsWith("|")) cells.shift();
  if (trimmed.endsWith("|")) cells.pop();
  return cells;
}

/**
 * Parse every pipe table in source order, retaining raw Markdown and actual row widths.
 *
 * The shape deliberately matches the Docusaurus corpus characterized by B-0022: outer-pipe
 * header rows followed by an alignment delimiter. Data rows stay ragged when the source is
 * ragged; they are never padded, truncated, or rejected. Table-looking text in backtick or
 * tilde fenced code is excluded.
 */
export function parseTables(md: string): ParsedTable[] {
  const lines = md.split("\n");
  const tables: ParsedTable[] = [];
  const isFenced = makeFenceTracker();
  let sourceHeading: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFenced(line)) continue;

    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      sourceHeading = heading[1].trim();
      continue;
    }

    if (!/^\s*\|.*\|\s*$/.test(line) || !lines[i + 1] || !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      continue;
    }

    const header = { cells: splitTableRow(line), line: i };
    const rows: ParsedTableRow[] = [];
    let end = i + 2;
    while (end < lines.length && /^\s*\|/.test(lines[end])) {
      rows.push({ cells: splitTableRow(lines[end]), line: end });
      end++;
    }

    tables.push({
      header,
      rows,
      rawMarkdown: lines.slice(i, end).join("\n"),
      columnCount: header.cells.length,
      dataRowCount: rows.length,
      isRagged: rows.some((row) => row.cells.length !== header.cells.length),
      sortOrder: tables.length,
      sourceHeading,
      sectionAnchor: null,
      line: i,
    });
    i = end - 1;
  }

  return tables;
}

/**
 * Parse a property-cell's raw text into name/type/default.
 * Tolerant of the malformed-bold-emphasis pattern found in dhcp.md's check-gateway
 * row (B-0012 H4): `**check-gateway** *(none \| arp \| bfd \| ping***;** Default: **none)**`
 * — the closing bold delimiter lands in the wrong place.
 */
function parsePropertyCell(
  cellText: string,
): { name: string; rawType: string | null; defaultVal: string | null; malformed: boolean } | null {
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

/**
 * Parse a bullet-list property definition: `- **name** (type[; default: x]) : description`
 * (bare parens, e.g. queues.md) or `- **name** *(type[; default: x])* - description`
 * (italicized parens, e.g. scheduler.md).
 *
 * Gated on a lowercase kebab-case name immediately followed by a parenthetical annotation —
 * this is the discriminator that separates real RouterOS property bullets from the far more
 * common non-property bold-bulleted prose found across the corpus (command menus in console.md,
 * chain/enum-value lists in filter.md/nat.md, JSON API fields in hotspot-captive-portal.md,
 * naming-convention lists in product-naming.md). Those all lack a parenthetical right after the
 * bold term, so they correctly fall through as non-matches (issue #20's false-positive guard).
 * Requiring lowercase specifically (unlike parsePropertyCell's case-insensitive table-cell
 * match) also excludes prose bullets that bold an uppercase acronym rather than an actual
 * property name, e.g. queues.md's "**CIR** (Committed Information Rate) – (**limit-at** in
 * RouterOS) ...", which explains a concept rather than defining a property named "CIR".
 */
function parseBulletProperty(
  line: string,
): { name: string; rawType: string | null; defaultVal: string | null; description: string; malformed: boolean } | null {
  const m = line.match(/^[-*]\s+\*\*([a-z0-9][a-z0-9-]*)\*\*(.*)$/);
  if (!m) return null;
  const [, name, rest] = m;

  const wellFormed = rest.match(/^\s*\*?\(([^)]*)\)\*?\s*[:\-–—]\s*(.+)$/);
  if (wellFormed) {
    const [, annotation, description] = wellFormed;
    const defaultMatch = annotation.match(/;?\s*default:\s*(.*)$/i);
    const rawType =
      (defaultMatch ? annotation.slice(0, defaultMatch.index) : annotation).replace(/;$/, "").trim() || null;
    const defaultVal = defaultMatch ? defaultMatch[1].trim() || null : null;
    return { name, rawType, defaultVal, description: description.trim(), malformed: false };
  }

  // Malformed fallback: an italicized annotation missing its opening paren, e.g.
  // scheduler.md's real upstream typo "**name** *name)*" (should have been "*(name)*") —
  // same B-0012 H4 malformed-emphasis territory as parsePropertyCell's check-gateway case.
  // Recover the description, flag it, and don't trust the garbled type text.
  const malformed = rest.match(/^\s*\*[^*()]*\)\*\s*[:\-–—]\s*(.+)$/);
  if (malformed) {
    return { name, rawType: null, defaultVal: null, description: malformed[1].trim(), malformed: true };
  }

  return null;
}

/**
 * Parse Markdown property tables: `| Property | Description |` or `| Parameter | Description |`
 * (both header spellings observed live — sms.md uses "Parameter", dhcp.md uses "Property"),
 * plus bullet-list property definitions (issue #20 — 32 pages use bullets instead of tables,
 * though characterizing them showed most of those pages are non-property prose; see
 * parseBulletProperty's doc comment for the false-positive guard that follows from that).
 * Section attribution is the nearest preceding heading of any level, matching extract-html.ts's
 * "nearest preceding heading" behavior for the Confluence corpus.
 */
export function parseProperties(md: string, tables = parseTables(md)): ParsedProperty[] {
  const lines = md.split("\n");
  const properties: ParsedProperty[] = [];
  let currentSection: string | null = null;
  const isFenced = makeFenceTracker();

  // Preserve the production parser's existing gate exactly while deriving accepted rows from
  // the shared generic-table objects. Broadening what qualifies as a property table is later
  // corpus-classification work, not an incidental change in #92.
  for (const table of tables) {
    const [headerLine, separatorLine] = table.rawMarkdown.split("\n", 2);
    if (!/^\|.*\b(property|parameter)\b.*\|$/i.test(headerLine) || !/^\|[\s:|-]+\|$/.test(separatorLine)) {
      continue;
    }
    for (const row of table.rows) {
      if (row.cells.length < 2) continue;
      const parsed = parsePropertyCell(row.cells[0]);
      if (!parsed) continue;
      properties.push({
        name: parsed.name,
        rawType: parsed.rawType,
        defaultVal: parsed.defaultVal,
        description: row.cells[1],
        section: table.sourceHeading,
        sectionAnchor: null,
        line: row.line,
        sourceTableRowLine: row.line,
        malformedEmphasis: parsed.malformed,
      });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isFenced(line)) continue;

    const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      currentSection = headingMatch[1].trim();
      continue;
    }

    const bulletProperty = parseBulletProperty(line);
    if (bulletProperty) {
      properties.push({
        name: bulletProperty.name,
        rawType: bulletProperty.rawType,
        defaultVal: bulletProperty.defaultVal,
        description: bulletProperty.description,
        section: currentSection,
        sectionAnchor: null, // resolved by parsePage(), which has the section line ranges
        line: i,
        sourceTableRowLine: null,
        malformedEmphasis: bulletProperty.malformed,
      });
    }
  }

  return properties.sort((a, b) => a.line - b.line);
}

/** Parse :::type ... ::: (and ::::-nested) admonition blocks into callouts. */
export function parseCallouts(md: string): ParsedCallout[] {
  const lines = md.split("\n");
  const callouts: ParsedCallout[] = [];
  const stack: Array<{ type: string; fenceWidth: number; contentLines: string[]; line: number }> = [];
  let sortOrder = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^(:{3,})(\w+)?\s*$/);
    if (fenceMatch) {
      const fenceWidth = fenceMatch[1].length;
      const type = fenceMatch[2];
      if (type) {
        stack.push({ type, fenceWidth, contentLines: [], line: i });
      } else if (stack.length > 0 && stack[stack.length - 1].fenceWidth === fenceWidth) {
        const closed = stack.pop();
        if (closed) {
          callouts.push({
            type: closed.type,
            content: closed.contentLines.join("\n").trim(),
            sortOrder: sortOrder++,
            sectionAnchor: null, // resolved by parsePage(), which has the section line ranges
            // The OPENING fence, so a callout attributes to the section it starts in even
            // if its body runs past the next heading.
            line: closed.line,
          });
        }
      } else if (stack.length > 0) {
        stack[stack.length - 1].contentLines.push(line);
      }
      continue;
    }
    if (stack.length > 0) stack[stack.length - 1].contentLines.push(line);
  }

  return callouts;
}

/**
 * Resolve a single relative Markdown link target against the page's own URL.
 * Preserves a `#anchor` fragment (e.g. `./dhcp.md#dhcp-server`) — deriveRosettaId
 * intentionally drops the fragment for identity purposes (H7), but a link rewritten
 * for human/agent navigation should still land on the right section, not just the page.
 */
function resolveLinkTarget(target: string, pageUrl: string): string {
  if (/^https?:\/\//.test(target)) return target;
  if (target.startsWith("#")) return target;
  const resolved = new URL(target, pageUrl);
  const base = rosettaIdToUrl(deriveRosettaId(resolved.toString()));
  return resolved.hash ? `${base}${resolved.hash}` : base;
}

/**
 * Rewrite relative Markdown links `[text](target)` inside a description to live
 * manual.mikrotik.com URLs so descriptions never carry a broken relative path once
 * stored outside their original page context (B-0012 H4/H7).
 */
export function resolveDescriptionLinks(description: string, pageUrl: string): string {
  return description.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_whole, text, target) => {
    const resolved = resolveLinkTarget(target, pageUrl);
    return `[${text}](${resolved})`;
  });
}

/** Extract fenced code blocks (```lang ... ```), returning joined content and observed languages. */
export function extractCodeBlocks(md: string): { code: string; codeLang: string | null } {
  const blocks: string[] = [];
  const langs = new Set<string>();
  const re = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex-exec-loop idiom
  while ((m = re.exec(md))) {
    const [, lang, body] = m;
    if (lang) langs.add(lang);
    const trimmed = body.trim();
    if (trimmed) blocks.push(trimmed);
  }
  return { code: blocks.join("\n\n"), codeLang: langs.size > 0 ? [...langs].join(",") : null };
}

/**
 * Split page body into sections by h1–h3 headings, mirroring extract-html.ts's
 * extractSections (which also only splits on h1–h3, folding deeper headings into
 * the enclosing section's text). Skips a leading duplicate of the page title — the
 * raw .md source repeats the H1 immediately after the AI-summary blockquote (observed
 * live on dhcp.md, dot1x.md, address-lists.md), which would otherwise mint a spurious
 * empty section.
 */
export function parseSections(md: string, title: string): ParsedSection[] {
  const lines = md.split("\n");
  const headings: Array<{ level: number; heading: string; lineIndex: number }> = [];
  const isFenced = makeFenceTracker();

  for (let i = 0; i < lines.length; i++) {
    if (isFenced(lines[i])) continue;
    const m = lines[i].match(/^(#{1,3})\s+(.+)$/);
    if (m) headings.push({ level: m[1].length, heading: m[2].trim(), lineIndex: i });
  }

  // Drop leading duplicate(s) of the page title (see doc comment above) — the live
  // source has repeated it exactly once so far, but loop rather than a single `if`
  // in case a future page repeats it more than once.
  while (headings.length > 0 && headings[0].heading === title) headings.shift();

  const usedAnchors = new Map<string, number>();
  const anchorFor = (heading: string): string => {
    const base = slugify(heading);
    const count = usedAnchors.get(base) ?? 0;
    usedAnchors.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };

  return headings.map((h, i) => {
    const startLine = h.lineIndex + 1;
    const endLine = headings[i + 1]?.lineIndex ?? lines.length;
    const sectionMd = lines.slice(startLine, endLine).join("\n").trim();
    const { code } = extractCodeBlocks(sectionMd);
    const text = sectionMd;
    return {
      heading: h.heading,
      level: h.level,
      anchorId: anchorFor(h.heading),
      text,
      code,
      wordCount: text.split(/\s+/).filter(Boolean).length,
      sortOrder: i,
      headingLine: h.lineIndex,
    };
  });
}

/**
 * Resolve a source line to the anchor_id of the h1–h3 section containing it — i.e. the last
 * section whose heading precedes the line (issue #90).
 *
 * This is the deliberate answer to #90's h4–h6 question: attribution folds a deep heading to
 * its nearest h1–h3 ancestor rather than minting section rows deeper than h3. `sections` stays
 * the retrieval unit (parseSections' h1–h3 split is unchanged) while attribution becomes total.
 * The consequence is stated rather than hidden: for a property under an h4–h6, `section` (the
 * raw nearest-heading text, kept for compatibility) and `sectionAnchor` deliberately disagree —
 * `section` names the h4, `sectionAnchor` names the enclosing h1–h3.
 *
 * Using the section's own anchor_id rather than its heading text is what makes this resolvable:
 * parseSections already disambiguates repeated headings into `foo`, `foo-1`, `foo-2`, and the
 * raw text throws that away.
 *
 * Returns null for content before the first section (e.g. a page's lead paragraph), which is
 * genuine absence of heading context, not a failure to resolve.
 */
export function attributeSection(line: number, sections: ParsedSection[]): string | null {
  let anchor: string | null = null;
  for (const s of sections) {
    if (s.headingLine >= line) break;
    anchor = s.anchorId;
  }
  return anchor;
}

/** Parse one page's raw Markdown body into the full structured shape stored in the DB. */
export function parsePage(md: string, pageUrl: string): ParsedPage {
  const rosettaId = deriveRosettaId(pageUrl);
  const titleMatch = md.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : rosettaId;

  const segments = rosettaId.split("/");
  const slug = segments[segments.length - 1];
  const path = segments.join(" > ");
  const depth = segments.length;

  const { code, codeLang } = extractCodeBlocks(md);
  const text = md.trim();
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const codeLines = code.split("\n").filter((l) => l.trim()).length;

  // Sections and tables first: properties consume the shared table parse, then every structure
  // is attributed by the same source-line coordinate (issues #90 and #92).
  const sections = parseSections(md, title);
  const tables = parseTables(md).map((table) => ({
    ...table,
    sectionAnchor: attributeSection(table.line, sections),
  }));
  const properties = parseProperties(md, tables).map((p) => ({
    ...p,
    description: resolveDescriptionLinks(p.description, pageUrl),
    sectionAnchor: attributeSection(p.line, sections),
  }));
  const callouts = parseCallouts(md).map((c) => ({
    ...c,
    sectionAnchor: attributeSection(c.line, sections),
  }));

  return {
    rosettaId,
    url: pageUrl,
    slug,
    title,
    path,
    depth,
    text,
    code,
    codeLang,
    wordCount,
    codeLines,
    sections,
    tables,
    properties,
    callouts,
  };
}

// ── DocCardList expansion (issue #65) ──
//
// manual.mikrotik.com's Docusaurus `.md` (llms.txt) output leaks `<DocCardList />`
// unrendered: the `@theme/DocCardList` category-index component emits nothing, so index
// pages (e.g. bgp.md) arrive with their entire child-page navigation missing — the single
// MDX leak that is real data loss rather than cosmetic scaffolding. We reconstruct the
// child list from the rosetta-id path tree the extractor already has in hand, upstream of
// parsePage, so the links flow into page text/sections exactly like ordinary prose.

export interface DocCard {
  title: string;
  url: string;
  summary?: string;
}

const DOCCARDLIST_TAG = /<DocCardList\b[^>]*\/>|<DocCardList\b[^>]*>[\s\S]*?<\/DocCardList>/g;
const DOCCARDLIST_IMPORT = /^[ \t]*import\s+DocCardList\s+from\s+['"]@theme\/DocCardList['"];?[ \t]*\r?\n?/gm;

/**
 * Replace every `<DocCardList />` with a Markdown bullet list of `children`, and drop the
 * now-orphaned `import DocCardList …` line.
 *
 * Honest fallback: if `children` is empty we return `md` untouched rather than silently
 * erasing a DocCardList we could not expand — the visible leak is better than fabricated
 * emptiness (grounding: don't mask a signal we can't explain).
 */
export function expandDocCardLists(md: string, children: DocCard[]): string {
  if (!md.includes("<DocCardList")) return md;
  if (children.length === 0) return md;

  const list = children
    .map((c) => `- [${c.title}](${c.url})${c.summary ? ` — ${c.summary}` : ""}`)
    .join("\n");

  return md.replace(DOCCARDLIST_IMPORT, "").replace(DOCCARDLIST_TAG, list);
}

/** Title (page H1) + summary (the AI-summary blockquote) used to label a DocCard entry. */
export function cardMetaFor(md: string, fallbackTitle: string): { title: string; summary?: string } {
  const h1 = md.match(/^#\s+(.+)$/m);
  const title = h1 ? h1[1].trim() : fallbackTitle;
  const bq = md.match(/^>\s?(.+?)\s*$/m);
  return { title, summary: bq ? bq[1].trim() : undefined };
}

/**
 * Direct children of `parentId` in the rosetta-id path tree: ids exactly one segment
 * deeper whose prefix is `${parentId}/`. Operates purely on id strings, so it is correct
 * for both leaf-named parents (`…/bgp` ← `…/bgp/faq`) and index parents (`…/unicast` ←
 * `…/unicast/bgp`). The .md stream carries no sidebar position, so callers sort by title.
 */
export function directChildIds(parentId: string, allIds: Iterable<string>): string[] {
  const prefix = `${parentId}/`;
  const childDepth = parentId.split("/").length + 1;
  const out: string[] = [];
  for (const id of allIds) {
    if (id.startsWith(prefix) && id.split("/").length === childDepth) out.push(id);
  }
  return out;
}

// ── Fetching / caching ──

function cachePathFor(rosettaId: string): string {
  const target = join(CACHE_DIR, `${rosettaId}.md`);
  // Defense-in-depth: rosettaId derives from network-fetched sitemap <loc> URLs, so a
  // malformed/hostile path must never let a cache write escape CACHE_DIR (CodeQL:
  // "Network data written to file"). URL normalization already collapses `..`, but
  // validate the resolved target stays contained rather than trusting that.
  const root = resolve(CACHE_DIR);
  const full = resolve(target);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`rosetta-id ${JSON.stringify(rosettaId)} resolves outside cache dir ${CACHE_DIR}`);
  }
  return target;
}

/**
 * Category/index pages (a directory's landing page, e.g.
 * .../authentication-authorization-accounting/) are listed in sitemap.xml with a
 * trailing slash and serve their Markdown at `index.md`, not `<slug>.md` — confirmed
 * live (2026-07-07): `.../accounting.md` 404s, `.../accounting/index.md` is 200.
 */
export function markdownUrlFor(url: string): string {
  return url.endsWith("/") ? `${url}index.md` : `${url}.md`;
}

async function fetchMarkdown(url: string): Promise<string> {
  const mdUrl = markdownUrlFor(url);
  const res = await fetch(mdUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${mdUrl}`);
  return res.text();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Recursively list every cached .md file under CACHE_DIR, returning rosetta-ids. */
function listCachedRosettaIds(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const ids: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      ids.push(...listCachedRosettaIds(join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".md")) {
      ids.push(rel.slice(0, -".md".length));
    }
  }
  return ids;
}

// ── Count cross-check (B-0012 H8, V-docusaurus-docs-count) ──

/** Parse llms.txt link entries, scoped to the same /docs prose rule as isInScopeDocsUrl. */
export function parseLlmsTxtInScopeCount(llmsTxt: string): number {
  const links = [...llmsTxt.matchAll(/\[[^\]]+\]\((https?:\/\/[^)]+\.mdx?)\)/g)].map((m) => m[1]);
  return links.filter((u) => isInScopeDocsUrl(u)).length;
}

async function checkCounts(extractedCount: number): Promise<boolean> {
  try {
    const res = await fetch(LLMS_TXT_URL, { signal: AbortSignal.timeout(10_000) });
    // Don't parse an error page as if it were llms.txt — a non-2xx here would yield a
    // bogus expected count (misleading mismatch, or a false match). Route it into the
    // catch below so the cross-check is reported as skipped rather than wrong.
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${LLMS_TXT_URL}`);
    const llmsTxt = await res.text();
    const expected = parseLlmsTxtInScopeCount(llmsTxt);
    const ok = expected === extractedCount;
    console.log(`\nCount cross-check (V-docusaurus-docs-count${STRICT ? "" : ", non-blocking"}): llms.txt in-scope=${expected}, extracted=${extractedCount} — ${ok ? "MATCH" : "MISMATCH"}`);
    return ok;
  } catch (e) {
    console.log(`\nCount cross-check skipped (fetch failed): ${e}`);
    // Plain --check-counts (local/manual) stays soft: a network blip shouldn't fail
    // a dev run. But --strict is release.yml's blocking use (V-docusaurus-docs-count) —
    // there, a skipped cross-check must not silently read as a pass.
    return !STRICT;
  }
}

// ── Main ──

async function main() {
  console.log("Initializing database...");
  initDb();

  console.log(FROM_CACHE ? `Discovering pages from cache: ${CACHE_DIR}` : `Discovering pages from sitemap: ${SITEMAP_URL}`);

  let rosettaIds: string[];
  let urlByRosettaId: Map<string, string>;

  if (FROM_CACHE) {
    rosettaIds = listCachedRosettaIds(CACHE_DIR);
    urlByRosettaId = new Map(rosettaIds.map((id) => [id, rosettaIdToUrl(id)]));
  } else {
    const sitemapUrls = (await loadSitemapUrls()).filter(isInScopeDocsUrl);
    urlByRosettaId = new Map(sitemapUrls.map((u) => [deriveRosettaId(u), u]));
    rosettaIds = [...urlByRosettaId.keys()];
  }

  rosettaIds.sort();
  if (LIMIT) rosettaIds = rosettaIds.slice(0, LIMIT);

  console.log(`Pages in scope: ${rosettaIds.length}`);

  const rawPages: Array<{ rosettaId: string; url: string; md: string }> = [];
  let fetchErrors = 0;

  for (const rosettaId of rosettaIds) {
    const url = urlByRosettaId.get(rosettaId) ?? rosettaIdToUrl(rosettaId);
    const cacheFile = cachePathFor(rosettaId);
    let md: string;

    if (FROM_CACHE) {
      md = readFileSync(cacheFile, "utf-8");
    } else {
      try {
        md = await fetchMarkdown(url);
        mkdirSync(dirname(cacheFile), { recursive: true });
        writeFileSync(cacheFile, md);
        await delay(FETCH_DELAY_MS);
      } catch (e) {
        console.log(`  ERROR: ${url}: ${e}`);
        fetchErrors++;
        continue;
      }
    }

    rawPages.push({ rosettaId, url, md });
  }

  // Expand leaked `<DocCardList />` into real child-link lists (issue #65). Built from the
  // full page set BEFORE parsing so the reconstructed links land in page text/sections.
  const allIds = rawPages.map((p) => p.rosettaId);
  const metaById = new Map(rawPages.map((p) => [p.rosettaId, cardMetaFor(p.md, p.rosettaId.split("/").at(-1) ?? p.rosettaId)]));
  let docCardListExpansions = 0;

  const parsedPages: ParsedPage[] = [];
  for (const { rosettaId, url, md } of rawPages) {
    let effectiveMd = md;
    if (md.includes("<DocCardList")) {
      const children = directChildIds(rosettaId, allIds)
        .map((cid) => {
          const meta = metaById.get(cid) ?? { title: cid, summary: undefined };
          return { title: meta.title, url: urlByRosettaId.get(cid) ?? rosettaIdToUrl(cid), summary: meta.summary };
        })
        .sort((a, b) => a.title.localeCompare(b.title));
      effectiveMd = expandDocCardLists(md, children);
      if (effectiveMd !== md) docCardListExpansions++;
    }
    parsedPages.push(parsePage(effectiveMd, url));
  }

  console.log(`Fetched/read: ${parsedPages.length}, errors: ${fetchErrors}, DocCardList expanded: ${docCardListExpansions}`);

  // Guard BEFORE the destructive rebuild below: if every fetch failed (network/sitemap
  // outage) or the cache was empty, bail without wiping an existing, good DB. Deleting
  // first and then discovering there's nothing to insert leaves downstream consumers an
  // empty DB (Copilot/CodeRabbit review, PR #13).
  if (parsedPages.length === 0) {
    console.error(`\n::error::extract-docusaurus: 0 pages extracted. Check sitemap/network/cache-dir.`);
    process.exit(1);
  }

  // Idempotent rebuild — this extractor owns pages/sections/properties/callouts
  // for the Docusaurus era the same way extract-html.ts owned them for Confluence;
  // the two are not meant to populate the same DB together (MANUAL.md).
  //
  // Unlike extract-html.ts (which preserves stable explicit page ids via INSERT OR
  // REPLACE), this extractor re-mints pages.id as fresh rowids each run, so any existing
  // commands.page_id / schema_nodes.page_id would dangle or point at unrelated new rows
  // after the wipe. NULL those links first so a STANDALONE run stays internally
  // consistent; the pipeline's `link` step (link-commands.ts) and extract-schema
  // re-establish them afterward. Both columns are nullable, so this is safe with FKs on.
  db.run("UPDATE commands SET page_id = NULL;");
  db.run("UPDATE schema_nodes SET page_id = NULL;");
  // Delete order matters: properties references both sections and table rows; table cells/rows
  // reference tables; tables and callouts reference sections (issues #90 and #92).
  db.run("DELETE FROM callouts;");
  db.run("INSERT INTO callouts_fts(callouts_fts) VALUES('rebuild');");
  db.run("DELETE FROM properties;");
  db.run("INSERT INTO properties_fts(properties_fts) VALUES('rebuild');");
  db.run("DELETE FROM page_table_cells;");
  db.run("DELETE FROM page_table_rows;");
  db.run("DELETE FROM page_tables;");
  db.run("DELETE FROM sections;");
  db.run("PRAGMA foreign_keys = OFF;");
  db.run("DELETE FROM pages;");
  db.run("PRAGMA foreign_keys = ON;");
  db.run("INSERT INTO pages_fts(pages_fts) VALUES('rebuild');");

  const insertPage = db.prepare(`
    INSERT INTO pages
      (rosetta_id, slug, title, path, depth, parent_id, url, text, code, code_lang,
       author, last_updated, word_count, code_lines, html_file)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
  `);
  const insertSection = db.prepare(`
    INSERT INTO sections (page_id, heading, level, anchor_id, text, code, word_count, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTable = db.prepare(`
    INSERT INTO page_tables
      (page_id, section_id, source_heading, raw_markdown, column_count, data_row_count, is_ragged, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertTableRow = db.prepare(`
    INSERT INTO page_table_rows (table_id, row_order) VALUES (?, ?)
  `);
  const insertTableCell = db.prepare(`
    INSERT INTO page_table_cells (row_id, column_order, value) VALUES (?, ?, ?)
  `);
  // Plain INSERT, not INSERT OR IGNORE: the old UNIQUE(page_id, name, section) silently
  // destroyed 141 distinct properties (issue #90). Every parsed row is now stored, and the
  // parsed == stored assert below makes any future loss loud instead of invisible.
  const insertProperty = db.prepare(`
    INSERT INTO properties
      (page_id, name, type, default_val, description, section, section_id, source_table_row_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertCallout = db.prepare(`
    INSERT INTO callouts (page_id, type, content, section_id, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);

  let totalSections = 0;
  let totalTables = 0;
  let totalTableDataRows = 0;
  let totalTableRows = 0;
  let totalTableCells = 0;
  let tablesWithoutSection = 0;
  let totalProperties = 0;
  let tableDerivedProperties = 0;
  let malformedProperties = 0;
  let totalCallouts = 0;
  let propertiesWithoutSection = 0;
  let calloutsWithoutSection = 0;

  const insertAll = db.transaction(() => {
    for (const page of parsedPages) {
      const cacheRelPath = cachePathFor(page.rosettaId).slice(PROJECT_ROOT.length + 1);
      const result = insertPage.run(
        page.rosettaId,
        page.slug,
        page.title,
        page.path,
        page.depth,
        page.url,
        page.text,
        page.code,
        page.codeLang,
        page.wordCount,
        page.codeLines,
        cacheRelPath,
      );
      const pageId = Number(result.lastInsertRowid);

      // Sections first, keeping anchor_id -> fresh rowid so properties/callouts can carry a
      // real section_id. anchor_id is unique within a page (parseSections disambiguates
      // repeated headings into foo, foo-1, foo-2), which is exactly what makes it a usable key.
      const sectionIdByAnchor = new Map<string, number>();
      for (const s of page.sections) {
        const res = insertSection.run(pageId, s.heading, s.level, s.anchorId, s.text, s.code, s.wordCount, s.sortOrder);
        sectionIdByAnchor.set(s.anchorId, Number(res.lastInsertRowid));
        totalSections++;
      }

      // Generic tables are stored before properties so a table-derived property can point at
      // its exact source row. Source lines are unique row coordinates within a page.
      const tableRowIdByLine = new Map<number, number>();
      for (const table of page.tables) {
        const sectionId = table.sectionAnchor === null ? null : (sectionIdByAnchor.get(table.sectionAnchor) ?? null);
        const tableResult = insertTable.run(
          pageId,
          sectionId,
          table.sourceHeading,
          table.rawMarkdown,
          table.columnCount,
          table.dataRowCount,
          table.isRagged ? 1 : 0,
          table.sortOrder,
        );
        const tableId = Number(tableResult.lastInsertRowid);
        const rows = [table.header, ...table.rows];
        for (let rowOrder = 0; rowOrder < rows.length; rowOrder++) {
          const row = rows[rowOrder];
          const rowResult = insertTableRow.run(tableId, rowOrder);
          const rowId = Number(rowResult.lastInsertRowid);
          if (rowOrder > 0) tableRowIdByLine.set(row.line, rowId);
          for (let columnOrder = 0; columnOrder < row.cells.length; columnOrder++) {
            insertTableCell.run(rowId, columnOrder, row.cells[columnOrder]);
            totalTableCells++;
          }
          totalTableRows++;
        }
        totalTables++;
        totalTableDataRows += table.rows.length;
        if (sectionId === null) tablesWithoutSection++;
      }

      let propOrder = 0;
      for (const p of page.properties) {
        const sectionId = p.sectionAnchor === null ? null : (sectionIdByAnchor.get(p.sectionAnchor) ?? null);
        const sourceTableRowId =
          p.sourceTableRowLine === null ? null : tableRowIdByLine.get(p.sourceTableRowLine);
        if (p.sourceTableRowLine !== null && sourceTableRowId === undefined) {
          throw new Error(`Property ${page.rosettaId}:${p.line} has no stored source table row`);
        }
        insertProperty.run(
          pageId,
          p.name,
          p.rawType,
          p.defaultVal,
          p.description,
          p.section,
          sectionId,
          sourceTableRowId ?? null,
          propOrder++,
        );
        totalProperties++;
        if (sourceTableRowId !== undefined && sourceTableRowId !== null) tableDerivedProperties++;
        if (p.malformedEmphasis) malformedProperties++;
        if (sectionId === null) propertiesWithoutSection++;
      }
      for (const c of page.callouts) {
        const sectionId = c.sectionAnchor === null ? null : (sectionIdByAnchor.get(c.sectionAnchor) ?? null);
        insertCallout.run(pageId, c.type, c.content, sectionId, c.sortOrder);
        totalCallouts++;
        if (sectionId === null) calloutsWithoutSection++;
      }
    }
  });
  insertAll();

  // Parsed vs stored (issue #90, V-extractor-no-silent-drops). The old UNIQUE + INSERT OR
  // IGNORE made these diverge by 165 rows and nothing said so — totalProperties counted
  // ATTEMPTED inserts, so even this log was reporting a number the DB did not hold. Read the
  // counts back from the DB rather than trusting the loop.
  const storedProperties = (db.query("SELECT count(*) AS n FROM properties").get() as { n: number }).n;
  const storedCallouts = (db.query("SELECT count(*) AS n FROM callouts").get() as { n: number }).n;
  const storedSections = (db.query("SELECT count(*) AS n FROM sections").get() as { n: number }).n;
  const storedTables = (db.query("SELECT count(*) AS n FROM page_tables").get() as { n: number }).n;
  const storedTableDataRows = (db.query("SELECT coalesce(sum(data_row_count), 0) AS n FROM page_tables").get() as { n: number }).n;
  const storedTableRows = (db.query("SELECT count(*) AS n FROM page_table_rows").get() as { n: number }).n;
  const storedTableCells = (db.query("SELECT count(*) AS n FROM page_table_cells").get() as { n: number }).n;
  const storedTablePropertyLinks = (
    db.query("SELECT count(*) AS n FROM properties WHERE source_table_row_id IS NOT NULL").get() as { n: number }
  ).n;

  console.log(`\nExtraction complete:`);
  console.log(`  Pages:      ${parsedPages.length}`);
  console.log(`  Sections:   ${storedSections}`);
  console.log(`  Tables:     ${storedTables} (${storedTableDataRows} data rows, ${storedTableCells} cells, ${tablesWithoutSection} with no section context)`);
  console.log(`  Properties: ${storedProperties} (${malformedProperties} malformed-emphasis, ${propertiesWithoutSection} with no section context)`);
  console.log(`  Callouts:   ${storedCallouts} (${calloutsWithoutSection} with no section context)`);

  const drops = [
    ["properties", totalProperties, storedProperties],
    ["tables", totalTables, storedTables],
    ["table data rows", totalTableDataRows, storedTableDataRows],
    ["table rows including headers", totalTableRows, storedTableRows],
    ["table cells", totalTableCells, storedTableCells],
    ["table-derived property links", tableDerivedProperties, storedTablePropertyLinks],
    ["callouts", totalCallouts, storedCallouts],
    ["sections", totalSections, storedSections],
  ].filter(([, parsed, stored]) => parsed !== stored);

  if (drops.length > 0) {
    for (const [table, parsed, stored] of drops) {
      console.error(`::error::extract-docusaurus: ${table}: parsed ${parsed}, stored ${stored} — ${Number(parsed) - Number(stored)} row(s) lost on insert.`);
    }
    console.error("A constraint is silently discarding rows. Do not 'fix' this by lowering the parsed count (issue #90).");
    process.exit(1);
  }

  if (CHECK_COUNTS) {
    const ok = await checkCounts(parsedPages.length);
    if (!ok && STRICT) process.exit(1);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}
