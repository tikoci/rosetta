/**
 * query.ts — Natural-language → FTS5 query planner for RouterOS documentation.
 *
 * NL → FTS5 query planner for docs. SQL-as-RAG pattern:
 * no author/date/engagement signals — just text search with BM25 ranking.
 */

import { db } from "./db.ts";

export type SearchResult = {
  id: number;
  title: string;
  path: string;
  url: string;
  word_count: number;
  code_lines: number;
  excerpt: string;
  best_section?: { heading: string; anchor_id: string; url: string };
};

export type SearchResponse = {
  query: string;
  ftsQuery: string;
  fallbackMode: "or" | null;
  results: SearchResult[];
  total: number;
};

type CsvScalar = string | number | null;

const DEFAULT_LIMIT = 8;
const MAX_TERMS = 8;
const MIN_TERM_LENGTH = 2;

const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "by", "can", "command", "commands",
  "configure", "do", "does", "documentation", "docs", "find", "for", "from",
  "how", "i", "in", "into", "is", "it", "me", "mikrotik", "most", "my",
  "of", "on", "or", "page", "pages", "routeros", "router", "show", "tell",
  "that", "the", "their", "them", "these", "this", "those",
  "what", "when", "where", "which", "why", "with", "without",
]);

const COMPOUND_TERMS: [string, string][] = [
  ["firewall", "filter"],
  ["firewall", "mangle"],
  ["firewall", "nat"],
  ["firewall", "raw"],
  ["ip", "address"],
  ["ip", "route"],
  ["ip", "pool"],
  ["ip", "firewall"],
  ["ip", "dns"],
  ["ip", "dhcp"],
  ["bridge", "port"],
  ["bridge", "vlan"],
  ["bridge", "filter"],
  ["bridge", "host"],
  ["system", "scheduler"],
  ["system", "script"],
  ["system", "package"],
  ["system", "clock"],
  ["system", "identity"],
  ["system", "resource"],
  ["interface", "bridge"],
  ["interface", "vlan"],
  ["interface", "wireless"],
  ["interface", "ethernet"],
  ["interface", "list"],
  ["routing", "filter"],
  ["routing", "table"],
  ["routing", "ospf"],
  ["routing", "bgp"],
  ["container", "envs"],
  ["container", "mounts"],
  ["certificate", "import"],
  ["caps", "man"],
  ["wifi", "channel"],
  ["wifi", "security"],
  ["wifi", "configuration"],
  ["dhcp", "server"],
  ["dhcp", "client"],
  ["dhcp", "relay"],
  ["switch", "chip"],
  ["switch", "rule"],
  ["queue", "simple"],
  ["queue", "tree"],
  ["address", "list"],
];

function escapeCsv(value: CsvScalar): string {
  if (value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function rowsToCsv<T extends Record<string, CsvScalar>>(
  rows: T[],
  columns: Array<keyof T & string>,
): string {
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((column) => escapeCsv(row[column] ?? null)).join(",")).join("\n");
  return body ? `${header}\n${body}\n` : `${header}\n`;
}

export function extractTerms(question: string): string[] {
  return question
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= MIN_TERM_LENGTH && !STOP_WORDS.has(t))
    .slice(0, MAX_TERMS);
}

export function buildFtsQuery(terms: string[], mode: "AND" | "OR"): string {
  if (terms.length === 0) return "";

  // Check for compound terms and convert to NEAR expressions
  const used = new Set<number>();
  const parts: string[] = [];

  for (const [a, b] of COMPOUND_TERMS) {
    const idxA = terms.indexOf(a);
    const idxB = terms.indexOf(b);
    if (idxA >= 0 && idxB >= 0 && !used.has(idxA) && !used.has(idxB)) {
      parts.push(`NEAR("${a}" "${b}", 5)`);
      used.add(idxA);
      used.add(idxB);
    }
  }

  // Add remaining terms
  for (let i = 0; i < terms.length; i++) {
    if (!used.has(i)) {
      parts.push(`"${terms[i]}"`);
    }
  }

  return parts.join(mode === "AND" ? " AND " : " OR ");
}

export function searchPages(question: string, limit = DEFAULT_LIMIT): SearchResponse {
  const terms = extractTerms(question);
  if (terms.length === 0) {
    return { query: question, ftsQuery: "", fallbackMode: null, results: [], total: 0 };
  }

  // Try AND first
  let ftsQuery = buildFtsQuery(terms, "AND");
  let fallbackMode: "or" | null = null;

  let results = runFtsQuery(ftsQuery, limit);

  // Fallback to OR if AND returns nothing and we have multiple terms
  if (results.length === 0 && terms.length > 1) {
    ftsQuery = buildFtsQuery(terms, "OR");
    results = runFtsQuery(ftsQuery, limit);
    fallbackMode = "or";
  }

  attachBestSections(results, terms);

  return { query: question, ftsQuery, fallbackMode, results, total: results.length };
}

function runFtsQuery(ftsQuery: string, limit: number): SearchResult[] {
  if (!ftsQuery) return [];
  try {
    return db
      .prepare(
        `SELECT s.id, s.title, s.path, s.url, s.word_count, s.code_lines,
                snippet(pages_fts, 2, '**', '**', '...', 30) as excerpt
         FROM pages_fts fts
         JOIN pages s ON s.id = fts.rowid
         WHERE pages_fts MATCH ?
         ORDER BY bm25(pages_fts, 3.0, 2.0, 1.0, 0.5)
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as SearchResult[];
  } catch {
    return [];
  }
}

/** For each search result with sections, find the section whose text best matches the search terms. */
function attachBestSections(results: SearchResult[], terms: string[]): void {
  if (results.length === 0 || terms.length === 0) return;

  const stmt = db.prepare(
    `SELECT heading, anchor_id, text FROM sections WHERE page_id = ? ORDER BY sort_order`,
  );

  for (const result of results) {
    const sections = stmt.all(result.id) as Array<{ heading: string; anchor_id: string; text: string }>;
    if (sections.length === 0) continue;

    let bestSection: (typeof sections)[0] | null = null;
    let bestScore = 0;

    for (const sec of sections) {
      const haystack = `${sec.heading} ${sec.text}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (haystack.includes(term)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestSection = sec;
      }
    }

    if (bestSection && bestScore > 0) {
      result.best_section = {
        heading: bestSection.heading,
        anchor_id: bestSection.anchor_id,
        url: `${result.url}#${bestSection.anchor_id}`,
      };
    }
  }
}

/** Section TOC entry returned when a large page would be truncated. */
export type SectionTocEntry = {
  heading: string;
  level: number;
  anchor_id: string;
  char_count: number;
  url: string;
};

/** Get full page content by ID or title. Optional max_length truncates text+code.
 *  If `section` is provided, returns only that section's content.
 *  If content would be truncated and the page has sections, returns a TOC instead. */
export function getPage(idOrTitle: string | number, maxLength?: number, section?: string): {
  id: number;
  title: string;
  path: string;
  url: string;
  text: string;
  code: string;
  word_count: number;
  code_lines: number;
  callouts: Array<{ type: string; content: string }>;
  callout_summary?: { count: number; types: Record<string, number> };
  truncated?: { text_total: number; code_total: number };
  sections?: SectionTocEntry[];
  section?: { heading: string; level: number; anchor_id: string };
  note?: string;
} | null {
  const row =
    typeof idOrTitle === "number" || /^\d+$/.test(String(idOrTitle))
      ? db.prepare("SELECT id, title, path, url, text, code, word_count, code_lines FROM pages WHERE id = ?").get(Number(idOrTitle))
      : db.prepare("SELECT id, title, path, url, text, code, word_count, code_lines FROM pages WHERE title = ? COLLATE NOCASE").get(idOrTitle);
  if (!row) return null;
  const page = row as { id: number; title: string; path: string; url: string; text: string; code: string; word_count: number; code_lines: number };
  const callouts = db
    .prepare("SELECT type, content FROM callouts WHERE page_id = ? ORDER BY sort_order")
    .all(page.id) as Array<{ type: string; content: string }>;

  // Section-specific retrieval: return section content including descendants
  if (section) {
    const sec = db
      .prepare(
        `SELECT heading, level, anchor_id, text, code, word_count, sort_order
         FROM sections WHERE page_id = ? AND (anchor_id = ? OR heading = ? COLLATE NOCASE)
         ORDER BY sort_order LIMIT 1`,
      )
      .get(page.id, section, section) as { heading: string; level: number; anchor_id: string; text: string; code: string; word_count: number; sort_order: number } | null;

    if (sec) {
      // Include descendant sections (children under this heading)
      const nextSibling = db
        .prepare(
          `SELECT min(sort_order) as next_order FROM sections
           WHERE page_id = ? AND sort_order > ? AND level <= ?`,
        )
        .get(page.id, sec.sort_order, sec.level) as { next_order: number | null };
      const upperBound = nextSibling?.next_order ?? 999999;

      const descendants = db
        .prepare(
          `SELECT heading, level, anchor_id, text, code, word_count
           FROM sections WHERE page_id = ? AND sort_order > ? AND level > ? AND sort_order < ?
           ORDER BY sort_order`,
        )
        .all(page.id, sec.sort_order, sec.level, upperBound) as Array<{ heading: string; level: number; anchor_id: string; text: string; code: string; word_count: number }>;

      let fullText = sec.text;
      let fullCode = sec.code;
      let totalWords = sec.word_count;
      for (const child of descendants) {
        const prefix = "#".repeat(Math.min(child.level + 1, 4));
        fullText += `\n\n${prefix} ${child.heading}\n${child.text}`;
        if (child.code) fullCode += `\n${child.code}`;
        totalWords += child.word_count;
      }

      // If section+descendants exceed maxLength and there are subsections, return sub-TOC
      if (maxLength && (fullText.length + fullCode.length) > maxLength && descendants.length > 0) {
        const subToc: SectionTocEntry[] = [
          { heading: sec.heading, level: sec.level, anchor_id: sec.anchor_id, char_count: sec.text.length + sec.code.length, url: `${page.url}#${sec.anchor_id}` },
          ...descendants.map((d) => ({ heading: d.heading, level: d.level, anchor_id: d.anchor_id, char_count: d.text.length + d.code.length, url: `${page.url}#${d.anchor_id}` })),
        ];
        const totalChars = fullText.length + fullCode.length;
        return {
          id: page.id, title: page.title, path: page.path, url: `${page.url}#${sec.anchor_id}`,
          text: "", code: "",
          word_count: totalWords, code_lines: 0,
          callouts: [], callout_summary: calloutSummary(callouts),
          sections: subToc,
          section: { heading: sec.heading, level: sec.level, anchor_id: sec.anchor_id },
          note: `Section "${sec.heading}" content (${totalChars} chars) exceeds max_length (${maxLength}). Showing ${subToc.length} sub-sections. Re-call with a more specific section heading or anchor_id.`,
        };
      }

      // If section exceeds maxLength but has no sub-sections, truncate
      if (maxLength && (fullText.length + fullCode.length) > maxLength) {
        const textTotal = fullText.length;
        const codeTotal = fullCode.length;
        const codeBudget = Math.min(codeTotal, Math.floor(maxLength * 0.2));
        const textBudget = maxLength - codeBudget;
        fullText = `${fullText.slice(0, textBudget)}\n\n[... truncated — ${textTotal} chars total, showing first ${textBudget}]`;
        fullCode = codeTotal > codeBudget ? `${fullCode.slice(0, codeBudget)}\n# [... truncated — ${codeTotal} chars total]` : fullCode;
      }

      return {
        id: page.id,
        title: page.title,
        path: page.path,
        url: `${page.url}#${sec.anchor_id}`,
        text: fullText,
        code: fullCode,
        word_count: totalWords,
        code_lines: fullCode.split("\n").filter((l) => l.trim()).length,
        callouts,
        section: { heading: sec.heading, level: sec.level, anchor_id: sec.anchor_id },
      };
    }

    // Section not found — return TOC if sections exist
    const toc = getPageToc(page.id, page.url);
    if (toc.length > 0) {
      return {
        id: page.id, title: page.title, path: page.path, url: page.url,
        text: "", code: "",
        word_count: page.word_count, code_lines: page.code_lines,
        callouts: [], callout_summary: calloutSummary(callouts),
        sections: toc,
        note: `Section "${section}" not found. ${toc.length} sections available — use a heading or anchor_id from the list.`,
      };
    }
    // No sections — return full page with note
    return {
      id: page.id, title: page.title, path: page.path, url: page.url,
      text: page.text, code: page.code,
      word_count: page.word_count, code_lines: page.code_lines,
      callouts,
      note: `Section "${section}" not found (this page has no sections). Returning full page.`,
    };
  }

  // Truncation with TOC fallback: if page would be truncated and has sections,
  // return a table of contents instead of a truncated blob
  let truncated: { text_total: number; code_total: number } | undefined;
  let { text, code } = page;
  if (maxLength && (text.length + code.length) > maxLength) {
    const toc = getPageToc(page.id, page.url);
    if (toc.length > 0) {
      const totalChars = text.length + code.length;
      return {
        id: page.id, title: page.title, path: page.path, url: page.url,
        text: "", code: "",
        word_count: page.word_count, code_lines: page.code_lines,
        callouts: [], callout_summary: calloutSummary(callouts),
        sections: toc,
        truncated: { text_total: text.length, code_total: code.length },
        note: `Page content (${totalChars} chars) exceeds max_length (${maxLength}). Showing table of contents with ${toc.length} sections. Re-call with section parameter to retrieve specific sections.`,
      };
    }

    // No sections — fall back to truncation
    const textTotal = text.length;
    const codeTotal = code.length;
    const codeBudget = Math.min(code.length, Math.floor(maxLength * 0.2));
    const textBudget = maxLength - codeBudget;
    text = `${text.slice(0, textBudget)}\n\n[... truncated — ${textTotal} chars total, showing first ${textBudget}]`;
    code = codeTotal > codeBudget ? `${code.slice(0, codeBudget)}\n# [... truncated — ${codeTotal} chars total]` : code;
    truncated = { text_total: textTotal, code_total: codeTotal };
  }

  return { id: page.id, title: page.title, path: page.path, url: page.url, text, code, word_count: page.word_count, code_lines: page.code_lines, callouts, ...(truncated ? { truncated } : {}) };
}

/** Build compact callout summary (count + type breakdown) for TOC-mode responses. */
function calloutSummary(callouts: Array<{ type: string; content: string }>): { count: number; types: Record<string, number> } {
  const types: Record<string, number> = {};
  for (const c of callouts) types[c.type] = (types[c.type] || 0) + 1;
  return { count: callouts.length, types };
}

/** Build section TOC for a page. */
function getPageToc(pageId: number, pageUrl: string): SectionTocEntry[] {
  const rows = db
    .prepare(
      `SELECT heading, level, anchor_id, length(text) + length(code) as char_count
       FROM sections WHERE page_id = ? ORDER BY sort_order`,
    )
    .all(pageId) as Array<{ heading: string; level: number; anchor_id: string; char_count: number }>;
  return rows.map((r) => ({
    heading: r.heading,
    level: r.level,
    anchor_id: r.anchor_id,
    char_count: r.char_count,
    url: `${pageUrl}#${r.anchor_id}`,
  }));
}

/** Lookup property by name, optionally filtered by command path. */
export function lookupProperty(
  name: string,
  commandPath?: string,
): Array<{
  name: string;
  type: string | null;
  default_val: string | null;
  description: string;
  section: string | null;
  page_title: string;
  page_url: string;
  page_id: number;
}> {
  if (commandPath) {
    // Find the page linked to this command path, then search properties there
    const linked = db
      .prepare(
        `SELECT DISTINCT c.page_id FROM commands c
         WHERE c.path = ? AND c.page_id IS NOT NULL`,
      )
      .get(commandPath) as { page_id: number } | null;

    if (linked) {
      return db
        .prepare(
          `SELECT p.name, p.type, p.default_val, p.description, p.section,
                  pg.title as page_title, pg.url as page_url, pg.id as page_id
           FROM properties p
           JOIN pages pg ON pg.id = p.page_id
           WHERE p.page_id = ? AND p.name = ? COLLATE NOCASE
           ORDER BY p.sort_order`,
        )
        .all(linked.page_id, name) as typeof lookupProperty extends (...a: unknown[]) => infer R ? R : never;
    }
  }

  // Fallback: search by property name across all pages
  return db
    .prepare(
      `SELECT p.name, p.type, p.default_val, p.description, p.section,
              pg.title as page_title, pg.url as page_url, pg.id as page_id
       FROM properties p
       JOIN pages pg ON pg.id = p.page_id
       WHERE p.name = ? COLLATE NOCASE
       ORDER BY pg.title, p.sort_order`,
    )
    .all(name) as typeof lookupProperty extends (...a: unknown[]) => infer R ? R : never;
}

/** Browse the command tree at a given path. */
export function browseCommands(
  cmdPath: string,
): Array<{
  path: string;
  name: string;
  type: string;
  description: string | null;
  page_title: string | null;
  page_url: string | null;
}> {
  return db
    .prepare(
      `SELECT c.path, c.name, c.type, c.description,
              p.title as page_title, p.url as page_url
       FROM commands c
       LEFT JOIN pages p ON c.page_id = p.id
       WHERE c.parent_path = ?
       ORDER BY c.type DESC, c.name`,
    )
    .all(cmdPath) as typeof browseCommands extends (...a: unknown[]) => infer R ? R : never;
}

/** Search properties by FTS query. */
export function searchProperties(
  query: string,
  limit = 10,
): Array<{
  name: string;
  type: string | null;
  default_val: string | null;
  description: string;
  section: string | null;
  page_id: number;
  page_title: string;
  page_url: string;
  excerpt: string;
}> {
  const terms = extractTerms(query);
  if (terms.length === 0) return [];

  let ftsQuery = buildFtsQuery(terms, "AND");
  if (!ftsQuery) return [];
  let results = runPropertiesFtsQuery(ftsQuery, limit);

  // Fallback to OR if AND returns nothing and we have multiple terms
  if (results.length === 0 && terms.length > 1) {
    ftsQuery = buildFtsQuery(terms, "OR");
    results = runPropertiesFtsQuery(ftsQuery, limit);
  }
  return results;
}

function runPropertiesFtsQuery(
  ftsQuery: string,
  limit: number,
): Array<{
  name: string;
  type: string | null;
  default_val: string | null;
  description: string;
  section: string | null;
  page_id: number;
  page_title: string;
  page_url: string;
  excerpt: string;
}> {
  if (!ftsQuery) return [];
  try {
    return db
      .prepare(
        `SELECT p.name, p.type, p.default_val, p.description, p.section,
                pg.id as page_id, pg.title as page_title, pg.url as page_url,
                snippet(properties_fts, 1, '**', '**', '...', 20) as excerpt
         FROM properties_fts fts
         JOIN properties p ON p.id = fts.rowid
         JOIN pages pg ON pg.id = p.page_id
         WHERE properties_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, limit) as Array<{
        name: string;
        type: string | null;
        default_val: string | null;
        description: string;
        section: string | null;
        page_id: number;
        page_title: string;
        page_url: string;
        excerpt: string;
      }>;
  } catch {
    return [];
  }
}

export type CalloutResult = {
  type: string;
  content: string;
  page_title: string;
  page_url: string;
  page_id: number;
  excerpt: string;
};

/** Search callout content via FTS, optionally filtered by type. */
export function searchCallouts(
  query: string,
  type?: string,
  limit = 10,
): CalloutResult[] {
  const terms = extractTerms(query);

  // Type-only browse: no search terms but type filter provided
  if (terms.length === 0 && type) {
    return db
      .prepare(
        `SELECT c.type, c.content, pg.title as page_title, pg.url as page_url,
                pg.id as page_id, substr(c.content, 1, 200) as excerpt
         FROM callouts c
         JOIN pages pg ON pg.id = c.page_id
         WHERE c.type = ?
         ORDER BY c.page_id, c.sort_order LIMIT ?`,
      )
      .all(type, limit) as CalloutResult[];
  }

  if (terms.length === 0) return [];

  let ftsQuery = buildFtsQuery(terms, "AND");
  if (!ftsQuery) return [];
  let results = runCalloutsFtsQuery(ftsQuery, type, limit);

  // Fallback to OR if AND returns nothing and we have multiple terms
  if (results.length === 0 && terms.length > 1) {
    ftsQuery = buildFtsQuery(terms, "OR");
    results = runCalloutsFtsQuery(ftsQuery, type, limit);
  }

  return results;
}

function runCalloutsFtsQuery(
  ftsQuery: string,
  type: string | undefined,
  limit: number,
): CalloutResult[] {
  if (!ftsQuery) return [];
  try {
    const sql = type
      ? `SELECT c.type, c.content, pg.title as page_title, pg.url as page_url, pg.id as page_id,
                snippet(callouts_fts, 0, '**', '**', '...', 25) as excerpt
         FROM callouts_fts fts
         JOIN callouts c ON c.id = fts.rowid
         JOIN pages pg ON pg.id = c.page_id
         WHERE callouts_fts MATCH ? AND c.type = ?
         ORDER BY rank LIMIT ?`
      : `SELECT c.type, c.content, pg.title as page_title, pg.url as page_url, pg.id as page_id,
                snippet(callouts_fts, 0, '**', '**', '...', 25) as excerpt
         FROM callouts_fts fts
         JOIN callouts c ON c.id = fts.rowid
         JOIN pages pg ON pg.id = c.page_id
         WHERE callouts_fts MATCH ?
         ORDER BY rank LIMIT ?`;
    return type
      ? (db.prepare(sql).all(ftsQuery, type, limit) as CalloutResult[])
      : (db.prepare(sql).all(ftsQuery, limit) as CalloutResult[]);
  } catch {
    return [];
  }
}

/** Diff two RouterOS versions — which command paths were added/removed between them. */
export type CommandDiffResult = {
  from_version: string;
  to_version: string;
  path_prefix: string | null;
  added: string[];
  removed: string[];
  added_count: number;
  removed_count: number;
  note: string | null;
};

export function diffCommandVersions(
  fromVersion: string,
  toVersion: string,
  pathPrefix?: string,
): CommandDiffResult {
  const allVersionRows = db
    .prepare("SELECT DISTINCT version FROM ros_versions")
    .all() as Array<{ version: string }>;
  const knownVersions = allVersionRows.map((r) => r.version).sort(compareVersions);

  const notes: string[] = [];
  if (knownVersions.length > 0 && !knownVersions.includes(fromVersion)) {
    notes.push(`Version ${fromVersion} is not in the tracked range (${knownVersions[0]}–${knownVersions[knownVersions.length - 1]}). Results may be incomplete.`);
  }
  if (knownVersions.length > 0 && !knownVersions.includes(toVersion)) {
    notes.push(`Version ${toVersion} is not in the tracked range (${knownVersions[0]}–${knownVersions[knownVersions.length - 1]}). Results may be incomplete.`);
  }

  const prefix = pathPrefix || null;  // treat empty string same as undefined
  // Match the prefix itself OR any sub-path under it
  const prefixFilter = prefix ? " AND (command_path = ? OR command_path LIKE ? || '/%')" : "";
  const prefixParams = (v: string) => prefix ? [v, prefix, prefix] : [v];

  type Row = { command_path: string };

  const addedRows = db
    .prepare(
      `SELECT DISTINCT cv_to.command_path
       FROM command_versions cv_to
       WHERE cv_to.ros_version = ?${prefixFilter}
         AND cv_to.command_path NOT IN (
           SELECT command_path FROM command_versions WHERE ros_version = ?${prefixFilter}
         )
       ORDER BY cv_to.command_path`,
    )
    .all(...prefixParams(toVersion), ...prefixParams(fromVersion)) as Row[];

  const removedRows = db
    .prepare(
      `SELECT DISTINCT cv_from.command_path
       FROM command_versions cv_from
       WHERE cv_from.ros_version = ?${prefixFilter}
         AND cv_from.command_path NOT IN (
           SELECT command_path FROM command_versions WHERE ros_version = ?${prefixFilter}
         )
       ORDER BY cv_from.command_path`,
    )
    .all(...prefixParams(fromVersion), ...prefixParams(toVersion)) as Row[];

  return {
    from_version: fromVersion,
    to_version: toVersion,
    path_prefix: prefix,
    added: addedRows.map((r) => r.command_path),
    removed: removedRows.map((r) => r.command_path),
    added_count: addedRows.length,
    removed_count: removedRows.length,
    note: notes.length > 0 ? notes.join(" ") : null,
  };
}

/** Check which RouterOS versions include a given command path. */
export function checkCommandVersions(
  commandPath: string,
): {
  command_path: string;
  versions: string[];
  first_seen: string | null;
  last_seen: string | null;
  note: string | null;
} {
  const rows = db
    .prepare(
      `SELECT ros_version FROM command_versions
       WHERE command_path = ?`,
    )
    .all(commandPath) as Array<{ ros_version: string }>;
  const versions = rows.map((r) => r.ros_version).sort(compareVersions);

  const allVersionRows = db
    .prepare("SELECT DISTINCT version FROM ros_versions")
    .all() as Array<{ version: string }>;
  const allVersions = allVersionRows.map((r) => r.version).sort(compareVersions);
  const minTracked = allVersions[0] ?? null;

  const firstSeen = versions[0] ?? null;
  const lastSeen = versions[versions.length - 1] ?? null;

  // If first_seen equals our earliest tracked version, the command may predate our data
  let note: string | null = null;
  if (firstSeen && minTracked && firstSeen === minTracked) {
    note = `Command exists in our earliest tracked version (${minTracked}). It likely existed in earlier versions too, but we have no data before ${minTracked}.`;
  } else if (versions.length === 0) {
    note = `No version data found. Our command tree covers ${minTracked ?? "7.9"}–7.23beta2. The command may exist outside this range, or the path may be wrong.`;
  }

  return {
    command_path: commandPath,
    versions,
    first_seen: firstSeen,
    last_seen: lastSeen,
    note,
  };
}

/** Compare RouterOS version strings numerically (e.g., "7.9" < "7.10.2" < "7.22"). */
export function compareVersions(a: string, b: string): number {
  const normalize = (v: string) => {
    const beta = v.includes("beta");
    const rc = v.includes("rc");
    const clean = v.replace(/beta\d*/, "").replace(/rc\d*/, "");
    const parts = clean.split(".").map(Number);
    // beta < rc < release for the same numeric version
    const suffix = beta ? 0 : rc ? 1 : 2;
    return { parts, suffix };
  };
  const na = normalize(a);
  const nb = normalize(b);
  for (let i = 0; i < Math.max(na.parts.length, nb.parts.length); i++) {
    const pa = na.parts[i] ?? 0;
    const pb = nb.parts[i] ?? 0;
    if (pa !== pb) return pa - pb;
  }
  return na.suffix - nb.suffix;
}

/** Browse commands filtered by version (uses command_versions table). */
export function browseCommandsAtVersion(
  cmdPath: string,
  version: string,
): Array<{
  path: string;
  name: string;
  type: string;
  description: string | null;
  page_title: string | null;
  page_url: string | null;
}> {
  return db
    .prepare(
      `SELECT c.path, c.name, c.type, c.description,
              p.title as page_title, p.url as page_url
       FROM commands c
       LEFT JOIN pages p ON c.page_id = p.id
       JOIN command_versions cv ON cv.command_path = c.path
       WHERE c.parent_path = ? AND cv.ros_version = ?
       ORDER BY c.type DESC, c.name`,
    )
    .all(cmdPath, version) as Array<{ path: string; name: string; type: string; description: string | null; page_title: string | null; page_url: string | null }>;
}

// ── Device lookup and search ──

export type DeviceTestResult = {
  test_type: string;
  mode: string;
  configuration: string;
  packet_size: number;
  throughput_kpps: number | null;
  throughput_mbps: number | null;
};

/** Map Unicode superscript digits to ASCII equivalents for product name matching.
 *  MikroTik uses ² and ³ in product names (hAP ax³, hAP ac²), but users type ASCII. */
const SUPERSCRIPT_TO_ASCII: [string, string][] = [
  ['\u00B9', '1'], // ¹
  ['\u00B2', '2'], // ²
  ['\u00B3', '3'], // ³
];

/** SQL expression to normalize Unicode superscript digits in a column to ASCII.
 *  Wraps the column in nested REPLACE calls. */
const NORMALIZE_PRODUCT_NAME = (col: string) =>
  SUPERSCRIPT_TO_ASCII.reduce(
    (expr, [sup, ascii]) => `REPLACE(${expr}, '${sup}', '${ascii}')`,
    col,
  );

/** Normalize a device query: replace Unicode superscript digits with ASCII. */
export function normalizeDeviceQuery(query: string): string {
  let result = query;
  for (const [sup, ascii] of SUPERSCRIPT_TO_ASCII) {
    result = result.replaceAll(sup, ascii);
  }
  return result;
}

export type DeviceResult = {
  id: number;
  product_name: string;
  product_code: string | null;
  architecture: string | null;
  cpu: string | null;
  cpu_cores: number | null;
  cpu_frequency: string | null;
  license_level: number | null;
  operating_system: string | null;
  ram: string | null;
  ram_mb: number | null;
  storage: string | null;
  storage_mb: number | null;
  dimensions: string | null;
  poe_in: string | null;
  poe_out: string | null;
  max_power_w: number | null;
  wireless_24_chains: number | null;
  wireless_5_chains: number | null;
  eth_fast: number | null;
  eth_gigabit: number | null;
  eth_2500: number | null;
  sfp_ports: number | null;
  sfp_plus_ports: number | null;
  eth_multigig: number | null;
  usb_ports: number | null;
  sim_slots: number | null;
  msrp_usd: number | null;
  product_url: string | null;
  block_diagram_url: string | null;
  test_results?: DeviceTestResult[];
};

export type DeviceFilters = {
  architecture?: string;
  min_ram_mb?: number;
  min_storage_mb?: number;
  license_level?: number;
  has_poe?: boolean;
  has_wireless?: boolean;
  has_lte?: boolean;
};

const DEVICE_SELECT = `SELECT id, product_name, product_code, architecture, cpu,
    cpu_cores, cpu_frequency, license_level, operating_system,
    ram, ram_mb, storage, storage_mb, dimensions, poe_in, poe_out,
    max_power_w, wireless_24_chains, wireless_5_chains,
    eth_fast, eth_gigabit, eth_2500, sfp_ports, sfp_plus_ports,
    eth_multigig, usb_ports, sim_slots, msrp_usd,
    product_url, block_diagram_url
  FROM devices`;

/** Get test results for a device by ID. */
function getDeviceTestResults(deviceId: number): DeviceTestResult[] {
  return db.prepare(
    `SELECT test_type, mode, configuration, packet_size,
            throughput_kpps, throughput_mbps
     FROM device_test_results
     WHERE device_id = ?
     ORDER BY test_type, mode, configuration, packet_size DESC`
  ).all(deviceId) as DeviceTestResult[];
}

/** Attach test results to device results (for single/exact lookups). */
function attachTestResults(devices: DeviceResult[]): DeviceResult[] {
  for (const dev of devices) {
    dev.test_results = getDeviceTestResults(dev.id);
  }
  return devices;
}

/** Build FTS5 query for devices — appends prefix '*' to every term.
 *  Model numbers like "RB1100" need prefix matching to find "RB1100AHx4".
 *  No compound term handling (not relevant for device names). */
function buildDeviceFtsQuery(terms: string[], mode: "AND" | "OR"): string {
  if (terms.length === 0) return "";
  const parts = terms.map((t) => `"${t}"*`);
  return parts.join(mode === "AND" ? " AND " : " OR ");
}

/** Generate a disambiguation note when multiple devices matched a partial query.
 *  Helps the MCP client present meaningful choices to the user. */
function disambiguationNote(query: string, results: DeviceResult[]): string {
  const names = results.map((r) => r.product_name);
  // Find common prefix
  const shortest = names.reduce((a, b) => (a.length < b.length ? a : b));
  let prefix = "";
  for (let i = 0; i < shortest.length; i++) {
    if (names.every((n) => n[i]?.toLowerCase() === shortest[i]?.toLowerCase())) {
      prefix += shortest[i];
    } else break;
  }
  prefix = prefix.trim();
  // Summarize key differences
  const diffs: string[] = [];
  const enclosures = new Set(names.map((n) => {
    if (/\bOUT\b/i.test(n)) return "outdoor";
    if (/\bIN\b/i.test(n)) return "indoor";
    return null;
  }).filter(Boolean));
  if (enclosures.size > 1) diffs.push("enclosure (indoor/outdoor)");
  const hasPoe = results.map((r) => !!(r.poe_in || r.poe_out));
  if (hasPoe.includes(true) && hasPoe.includes(false)) diffs.push("PoE support");
  const hasPoeOut = results.map((r) => !!r.poe_out);
  if (!diffs.includes("PoE support") && hasPoeOut.includes(true) && hasPoeOut.includes(false)) diffs.push("PoE output");
  const hasWireless = results.map((r) => !!(r.wireless_24_chains || r.wireless_5_chains));
  if (hasWireless.includes(true) && hasWireless.includes(false)) diffs.push("wireless");
  const lteCapable = results.map((r) => (r.sim_slots ?? 0) > 0);
  if (lteCapable.includes(true) && lteCapable.includes(false)) diffs.push("LTE/cellular");
  const family = prefix || query;
  const diffStr = diffs.length > 0 ? ` Key differences: ${diffs.join(", ")}.` : "";
  return `${results.length} devices match "${family}".${diffStr} Use the full product name for a specific device.`;
}

/** Look up a device by exact name or product code, then fall back to LIKE/FTS + filters. */
export function searchDevices(
  query: string,
  filters: DeviceFilters = {},
  limit = 10,
): { results: DeviceResult[]; mode: "exact" | "fts" | "like" | "filter" | "fts+or"; total: number; has_more: boolean; note?: string } {
  // Normalize Unicode superscripts → ASCII digits for all matching stages.
  // Users type "ax3" for "ax³", "ac2" for "ac²" — normalize once, use everywhere.
  const q = normalizeDeviceQuery(query);
  const normalizedName = NORMALIZE_PRODUCT_NAME('product_name');

  // 1. Try exact match on product_name or product_code.
  //    Compares normalized query against both raw and superscript-normalized product_name.
  if (q) {
    const exact = db
      .prepare(`${DEVICE_SELECT} WHERE product_name = ? COLLATE NOCASE OR product_code = ? COLLATE NOCASE OR ${normalizedName} = ? COLLATE NOCASE`)
      .all(q, q, q) as DeviceResult[];
    if (exact.length > 0) {
      return { results: attachTestResults(exact), mode: "exact", total: exact.length, has_more: false };
    }
  }

  // 2. LIKE-based prefix/substring match on product_name and product_code.
  //    Splits on whitespace, dashes, and underscores so that dash-separated
  //    queries like "rb5009-out" still find "RB5009UPr+S+OUT".
  //    For 144 rows this is instant and catches model number substrings
  //    that FTS5 token matching misses (e.g. "RB1100" → "RB1100AHx4").
  //    Also normalizes product_name in SQL so "ax3" matches "ax³".
  if (q) {
    const rawTerms = q.trim().split(/[\s\-_]+/);
    const longTerms = rawTerms.filter((t) => t.length >= 2);
    // Preserve single-digit terms (version numbers like "3" in "hap ax 3")
    // but only when accompanied by longer terms to avoid overly broad matches.
    const digitTerms = rawTerms.filter((t) => t.length === 1 && /^\d$/.test(t));
    const likeTerms = (longTerms.length > 0 ? [...longTerms, ...digitTerms] : longTerms)
      .map((t) => `%${t}%`);
    if (likeTerms.length > 0) {
      const likeConditions = likeTerms.map(
        () => `(${normalizedName} LIKE ? COLLATE NOCASE OR d.product_code LIKE ? COLLATE NOCASE)`,
      );
      const likeParams = likeTerms.flatMap((t) => [t, t]);
      // Fetch limit+1 to detect truncation
      const likeSql = `${DEVICE_SELECT} d WHERE ${likeConditions.join(" AND ")} ORDER BY d.product_name LIMIT ?`;
      const likeResults = db.prepare(likeSql).all(...likeParams, limit + 1) as DeviceResult[];
      if (likeResults.length > 0) {
        const hasMore = likeResults.length > limit;
        const trimmed = hasMore ? likeResults.slice(0, limit) : likeResults;
        // Attach test results for small result sets (likely specific device lookups)
        if (trimmed.length <= 5) attachTestResults(trimmed);
        // Single match in any mode gets test results
        else if (trimmed.length === 1) attachTestResults(trimmed);
        const note = trimmed.length > 1 ? disambiguationNote(q, trimmed) : undefined;
        return { results: trimmed, mode: "like", total: trimmed.length, has_more: hasMore, note };
      }
    }
  }

  // 2b. Slug-normalized LIKE: strip all separators from both query and product_url slug.
  //     Handles concatenated AKAs ("hapax3", "fiberboxplus", "wapaxlte7") and superscript
  //     queries ("hap ax3" → slug hap_ax3 → stripped hapax3). Anchors to /product/ prefix
  //     to avoid matching domain or path components.
  if (q) {
    const slugQuery = q.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (slugQuery.length >= 5) {
      const slugPattern = `%/product/%${slugQuery}%`;
      const slugSql = `${DEVICE_SELECT} d WHERE d.product_url IS NOT NULL AND REPLACE(LOWER(d.product_url), '_', '') LIKE ? ORDER BY d.product_name LIMIT ?`;
      const slugResults = db.prepare(slugSql).all(slugPattern, limit + 1) as DeviceResult[];
      if (slugResults.length > 0) {
        const hasMore = slugResults.length > limit;
        const trimmed = hasMore ? slugResults.slice(0, limit) : slugResults;
        if (trimmed.length <= 5) attachTestResults(trimmed);
        else if (trimmed.length === 1) attachTestResults(trimmed);
        const note = trimmed.length > 1 ? disambiguationNote(q, trimmed) : undefined;
        return { results: trimmed, mode: "like", total: trimmed.length, has_more: hasMore, note };
      }
    }
  }

  // 3. FTS + structured filters
  const whereClauses: string[] = [];
  const params: (string | number)[] = [];

  if (filters.architecture) {
    whereClauses.push("d.architecture = ?");
    params.push(filters.architecture);
  }
  if (filters.min_ram_mb) {
    whereClauses.push("d.ram_mb >= ?");
    params.push(filters.min_ram_mb);
  }
  if (filters.min_storage_mb) {
    whereClauses.push("d.storage_mb >= ?");
    params.push(filters.min_storage_mb);
  }
  if (filters.license_level) {
    whereClauses.push("d.license_level = ?");
    params.push(filters.license_level);
  }
  if (filters.has_poe) {
    whereClauses.push("(d.poe_in IS NOT NULL OR d.poe_out IS NOT NULL)");
  }
  if (filters.has_wireless) {
    whereClauses.push("(d.wireless_24_chains IS NOT NULL OR d.wireless_5_chains IS NOT NULL)");
  }
  if (filters.has_lte) {
    whereClauses.push("d.sim_slots > 0");
  }

  const terms = q ? extractTerms(q) : [];

  if (terms.length > 0) {
    // FTS with filters — use prefix matching for device model numbers
    const ftsQuery = buildDeviceFtsQuery(terms, "AND");
    if (ftsQuery) {
      const filterWhere = whereClauses.length > 0 ? ` AND ${whereClauses.join(" AND ")}` : "";
      const sql = `SELECT d.id, d.product_name, d.product_code, d.architecture, d.cpu,
          d.cpu_cores, d.cpu_frequency, d.license_level, d.operating_system,
          d.ram, d.ram_mb, d.storage, d.storage_mb, d.dimensions, d.poe_in, d.poe_out,
          d.max_power_w, d.wireless_24_chains, d.wireless_5_chains,
          d.eth_fast, d.eth_gigabit, d.eth_2500, d.sfp_ports, d.sfp_plus_ports,
          d.eth_multigig, d.usb_ports, d.sim_slots, d.msrp_usd,
          d.product_url, d.block_diagram_url
        FROM devices_fts fts
        JOIN devices d ON d.id = fts.rowid
        WHERE devices_fts MATCH ?${filterWhere}
        ORDER BY rank LIMIT ?`;
      try {
        const results = db.prepare(sql).all(ftsQuery, ...params, limit + 1) as DeviceResult[];
        if (results.length > 0) {
          const hasMore = results.length > limit;
          const trimmed = hasMore ? results.slice(0, limit) : results;
          // Single FTS match gets test results (same behavior as exact)
          if (trimmed.length === 1) attachTestResults(trimmed);
          return { results: trimmed, mode: "fts", total: trimmed.length, has_more: hasMore };
        }
      } catch { /* fall through to OR */ }

      // Fallback to OR
      if (terms.length > 1) {
        const orQuery = buildDeviceFtsQuery(terms, "OR");
        try {
          const results = db.prepare(sql).all(orQuery, ...params, limit + 1) as DeviceResult[];
          if (results.length > 0) {
            const hasMore = results.length > limit;
            const trimmed = hasMore ? results.slice(0, limit) : results;
            if (trimmed.length === 1) attachTestResults(trimmed);
            return { results: trimmed, mode: "fts+or", total: trimmed.length, has_more: hasMore };
          }
        } catch { /* fall through */ }
      }
    }
  }

  // 4. Filter-only (no FTS query)
  if (whereClauses.length > 0) {
    const sql = `${DEVICE_SELECT} d WHERE ${whereClauses.join(" AND ")} ORDER BY d.product_name LIMIT ?`;
    const results = db.prepare(sql).all(...params, limit + 1) as DeviceResult[];
    const hasMore = results.length > limit;
    const trimmed = hasMore ? results.slice(0, limit) : results;
    return { results: trimmed, mode: "filter", total: trimmed.length, has_more: hasMore };
  }

  return { results: [], mode: "fts", total: 0, has_more: false };
}

// ── Cross-device test result queries ──

export type DeviceTestRow = {
  product_name: string;
  product_code: string | null;
  architecture: string;
  test_type: string;
  mode: string;
  configuration: string;
  packet_size: number;
  throughput_kpps: number | null;
  throughput_mbps: number | null;
};

type DeviceTestFilters = {
  device?: string;
  test_type?: string;
  mode?: string;
  configuration?: string;
  packet_size?: number;
  sort_by?: "mbps" | "kpps";
};

function buildTestWhereClause(filters: DeviceTestFilters): { whereClause: string; params: (string | number)[] } {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filters.device) {
    where.push("d.product_name LIKE ?");
    params.push(`%${filters.device}%`);
  }
  if (filters.test_type) {
    where.push("t.test_type = ?");
    params.push(filters.test_type);
  }
  if (filters.mode) {
    where.push("t.mode = ?");
    params.push(filters.mode);
  }
  if (filters.configuration) {
    where.push("t.configuration LIKE ?");
    params.push(`%${filters.configuration}%`);
  }
  if (filters.packet_size) {
    where.push("t.packet_size = ?");
    params.push(filters.packet_size);
  }

  return {
    whereClause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    params,
  };
}

export function searchDeviceTests(
  filters: DeviceTestFilters,
  limit = 50,
): { results: DeviceTestRow[]; total: number } {
  const { whereClause, params } = buildTestWhereClause(filters);
  const orderCol = filters.sort_by === "kpps" ? "t.throughput_kpps" : "t.throughput_mbps";

  // Total count (before limit)
  const totalSql = `SELECT COUNT(*) AS c FROM device_test_results t
    JOIN devices d ON d.id = t.device_id ${whereClause}`;
  const total = Number((db.prepare(totalSql).get(...params) as { c: number }).c);

  const sql = `SELECT d.product_name, d.product_code, d.architecture,
      t.test_type, t.mode, t.configuration, t.packet_size,
      t.throughput_kpps, t.throughput_mbps
    FROM device_test_results t
    JOIN devices d ON d.id = t.device_id
    ${whereClause}
    ORDER BY ${orderCol} DESC NULLS LAST
    LIMIT ?`;

  const results = db.prepare(sql).all(...params, limit) as DeviceTestRow[];
  return { results, total };
}

type DeviceTestCsvRow = {
  product_name: string;
  product_code: string | null;
  architecture: string | null;
  cpu: string | null;
  cpu_cores: number | null;
  cpu_frequency: string | null;
  test_type: string;
  mode: string;
  configuration: string;
  packet_size: number;
  throughput_kpps: number | null;
  throughput_mbps: number | null;
  product_url: string | null;
};

export function exportDeviceTestsCsv(): string {
  const rows = db.prepare(`SELECT d.product_name, d.product_code, d.architecture,
      d.cpu, d.cpu_cores, d.cpu_frequency,
      t.test_type, t.mode, t.configuration, t.packet_size,
      t.throughput_kpps, t.throughput_mbps,
      d.product_url
    FROM device_test_results t
    JOIN devices d ON d.id = t.device_id
    ORDER BY d.product_name, t.test_type, t.mode, t.configuration, t.packet_size DESC`).all() as DeviceTestCsvRow[];

  return rowsToCsv(rows, [
    "product_name",
    "product_code",
    "architecture",
    "cpu",
    "cpu_cores",
    "cpu_frequency",
    "test_type",
    "mode",
    "configuration",
    "packet_size",
    "throughput_kpps",
    "throughput_mbps",
    "product_url",
  ]);
}

type DeviceCsvRow = {
  product_name: string;
  product_code: string | null;
  architecture: string | null;
  cpu: string | null;
  cpu_cores: number | null;
  cpu_frequency: string | null;
  license_level: number | null;
  operating_system: string | null;
  ram: string | null;
  ram_mb: number | null;
  storage: string | null;
  storage_mb: number | null;
  dimensions: string | null;
  poe_in: string | null;
  poe_out: string | null;
  max_power_w: number | null;
  wireless_24_chains: number | null;
  wireless_5_chains: number | null;
  eth_fast: number | null;
  eth_gigabit: number | null;
  eth_2500: number | null;
  sfp_ports: number | null;
  sfp_plus_ports: number | null;
  eth_multigig: number | null;
  usb_ports: number | null;
  sim_slots: number | null;
  msrp_usd: number | null;
  product_url: string | null;
  block_diagram_url: string | null;
};

export function exportDevicesCsv(): string {
  const rows = db.prepare(`${DEVICE_SELECT} ORDER BY product_name`).all() as DeviceCsvRow[];

  return rowsToCsv(rows, [
    "product_name",
    "product_code",
    "architecture",
    "cpu",
    "cpu_cores",
    "cpu_frequency",
    "license_level",
    "operating_system",
    "ram",
    "ram_mb",
    "storage",
    "storage_mb",
    "dimensions",
    "poe_in",
    "poe_out",
    "max_power_w",
    "wireless_24_chains",
    "wireless_5_chains",
    "eth_fast",
    "eth_gigabit",
    "eth_2500",
    "sfp_ports",
    "sfp_plus_ports",
    "eth_multigig",
    "usb_ports",
    "sim_slots",
    "msrp_usd",
    "product_url",
    "block_diagram_url",
  ]);
}

/** Get distinct values for test result fields (for discovery). */
export function getTestResultMeta(): {
  test_types: string[];
  modes: string[];
  configurations: string[];
  packet_sizes: number[];
} {
  const col = (sql: string) => (db.prepare(sql).all() as Array<{ v: string }>).map((r) => r.v);
  return {
    test_types: col("SELECT DISTINCT test_type AS v FROM device_test_results ORDER BY v"),
    modes: col("SELECT DISTINCT mode AS v FROM device_test_results ORDER BY v"),
    configurations: col("SELECT DISTINCT configuration AS v FROM device_test_results ORDER BY v"),
    packet_sizes: (db.prepare("SELECT DISTINCT packet_size AS v FROM device_test_results ORDER BY v DESC").all() as Array<{ v: number }>).map((r) => r.v),
  };
}

const VERSION_CHANNELS = ["stable", "long-term", "testing", "development"] as const;

// ── Changelog search ──

export type ChangelogResult = {
  version: string;
  released: string | null;
  category: string;
  is_breaking: number;
  description: string;
  excerpt: string;
};

/** Get all versions that have changelog data, sorted numerically. */
function getChangelogVersions(): string[] {
  const rows = db
    .prepare("SELECT DISTINCT version FROM changelogs")
    .all() as Array<{ version: string }>;
  return rows.map((r) => r.version).sort(compareVersions);
}

/** Filter versions to those within (fromVersion, toVersion] range (fromVersion exclusive, toVersion inclusive). */
function filterVersionRange(
  versions: string[],
  fromVersion?: string,
  toVersion?: string,
): string[] {
  return versions.filter((v) => {
    if (fromVersion && compareVersions(v, fromVersion) <= 0) return false;
    if (toVersion && compareVersions(v, toVersion) > 0) return false;
    return true;
  });
}

/** Search changelogs with FTS, version range, category, and breaking-only filters. */
export function searchChangelogs(
  query: string,
  options: {
    version?: string;
    fromVersion?: string;
    toVersion?: string;
    category?: string;
    breakingOnly?: boolean;
    limit?: number;
  } = {},
): ChangelogResult[] {
  const limit = options.limit ?? 20;
  const terms = extractTerms(query);

  // Build version filter
  let versionList: string[] | null = null;
  if (options.version) {
    versionList = [options.version];
  } else if (options.fromVersion || options.toVersion) {
    const all = getChangelogVersions();
    versionList = filterVersionRange(all, options.fromVersion, options.toVersion);
    if (versionList.length === 0) return [];
  }

  // No FTS query — browse by filters only
  if (terms.length === 0) {
    return browseChangelogs(versionList, options.category, options.breakingOnly, limit);
  }

  // FTS search with AND, then fallback to OR
  let ftsQuery = buildFtsQuery(terms, "AND");
  if (!ftsQuery) return [];
  let results = runChangelogFtsQuery(ftsQuery, versionList, options.category, options.breakingOnly, limit);

  if (results.length === 0 && terms.length > 1) {
    ftsQuery = buildFtsQuery(terms, "OR");
    results = runChangelogFtsQuery(ftsQuery, versionList, options.category, options.breakingOnly, limit);
  }

  return results;
}

/** Browse changelogs without FTS — just filters. */
function browseChangelogs(
  versionList: string[] | null,
  category: string | undefined,
  breakingOnly: boolean | undefined,
  limit: number,
): ChangelogResult[] {
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (versionList) {
    where.push(`c.version IN (${versionList.map(() => "?").join(",")})`);
    params.push(...versionList);
  }
  if (category) {
    where.push("c.category = ?");
    params.push(category);
  }
  if (breakingOnly) {
    where.push("c.is_breaking = 1");
  }

  if (where.length === 0) {
    // No filters at all — return recent entries
    where.push("1=1");
  }

  const sql = `SELECT c.version, c.released, c.category, c.is_breaking,
      c.description, substr(c.description, 1, 200) as excerpt
    FROM changelogs c
    WHERE ${where.join(" AND ")}
    ORDER BY c.sort_order
    LIMIT ?`;

  const rows = db.prepare(sql).all(...params, limit) as ChangelogResult[];
  // Sort by version numerically (SQL sorts lexicographically: 7.9 > 7.22)
  return rows.sort((a, b) => compareVersions(b.version, a.version) || a.description.localeCompare(b.description));
}

function runChangelogFtsQuery(
  ftsQuery: string,
  versionList: string[] | null,
  category: string | undefined,
  breakingOnly: boolean | undefined,
  limit: number,
): ChangelogResult[] {
  if (!ftsQuery) return [];
  try {
    const where: string[] = ["changelogs_fts MATCH ?"];
    const params: (string | number)[] = [ftsQuery];

    if (versionList) {
      where.push(`c.version IN (${versionList.map(() => "?").join(",")})`);
      params.push(...versionList);
    }
    if (category) {
      where.push("c.category = ?");
      params.push(category);
    }
    if (breakingOnly) {
      where.push("c.is_breaking = 1");
    }

    const sql = `SELECT c.version, c.released, c.category, c.is_breaking,
        c.description,
        snippet(changelogs_fts, 1, '**', '**', '...', 25) as excerpt
      FROM changelogs_fts fts
      JOIN changelogs c ON c.id = fts.rowid
      WHERE ${where.join(" AND ")}
      ORDER BY rank
      LIMIT ?`;

    return db.prepare(sql).all(...params, limit) as ChangelogResult[];
  } catch {
    return [];
  }
}

// ── Video/transcript search ──

export type VideoSearchResult = {
  video_id: string;
  title: string;
  url: string;
  upload_date: string | null;
  chapter_title: string | null;
  start_s: number;
  excerpt: string;
};

/** Search YouTube video transcripts via FTS, joining segment → video metadata. */
export function searchVideos(query: string, limit = 5): VideoSearchResult[] {
  const terms = extractTerms(query);
  if (terms.length === 0) return [];

  let ftsQuery = buildFtsQuery(terms, "AND");
  if (!ftsQuery) return [];
  let results = runVideosFtsQuery(ftsQuery, limit);

  // Fallback to OR if AND returns nothing and we have multiple terms
  if (results.length === 0 && terms.length > 1) {
    ftsQuery = buildFtsQuery(terms, "OR");
    results = runVideosFtsQuery(ftsQuery, limit);
  }

  return results;
}

function runVideosFtsQuery(ftsQuery: string, limit: number): VideoSearchResult[] {
  if (!ftsQuery) return [];
  try {
    return db
      .prepare(
        `SELECT v.video_id, v.title, v.url, v.upload_date,
                vs.chapter_title, vs.start_s,
                snippet(video_segments_fts, 1, '**', '**', '...', 25) as excerpt
         FROM video_segments_fts fts
         JOIN video_segments vs ON vs.id = fts.rowid
         JOIN videos v ON v.id = vs.video_id
         WHERE video_segments_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as VideoSearchResult[];
  } catch {
    return [];
  }
}

// ── Current versions ──

// ── Dude wiki search ──

export type DudeSearchResult = {
  id: number;
  title: string;
  path: string;
  version: string;
  url: string;
  word_count: number | null;
  image_count: number;
  excerpt: string;
};

export type DudeImageResult = {
  id: number;
  filename: string;
  alt_text: string | null;
  caption: string | null;
  local_path: string;
  original_url: string | null;
  wayback_url: string | null;
};

export type DudePageResult = {
  id: number;
  slug: string;
  title: string;
  path: string;
  version: string;
  url: string;
  wayback_url: string;
  text: string;
  code: string | null;
  last_edited: string | null;
  word_count: number | null;
  images: DudeImageResult[];
};

/** Search archived Dude wiki pages via FTS, with AND→OR fallback. */
export function searchDude(query: string, limit = 8): DudeSearchResult[] {
  const terms = extractTerms(query);
  if (terms.length === 0) return [];

  let ftsQuery = buildFtsQuery(terms, "AND");
  if (!ftsQuery) return [];
  let results = runDudeFtsQuery(ftsQuery, limit);

  if (results.length === 0 && terms.length > 1) {
    ftsQuery = buildFtsQuery(terms, "OR");
    results = runDudeFtsQuery(ftsQuery, limit);
  }

  return results;
}

function runDudeFtsQuery(ftsQuery: string, limit: number): DudeSearchResult[] {
  if (!ftsQuery) return [];
  try {
    return db
      .prepare(
        `SELECT dp.id, dp.title, dp.path, dp.version, dp.url, dp.word_count,
                (SELECT COUNT(*) FROM dude_images di WHERE di.page_id = dp.id) as image_count,
                snippet(dude_pages_fts, 2, '**', '**', '...', 25) as excerpt
         FROM dude_pages_fts fts
         JOIN dude_pages dp ON dp.id = fts.rowid
         WHERE dude_pages_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(ftsQuery, limit) as DudeSearchResult[];
  } catch {
    return [];
  }
}

/** Get a Dude wiki page by ID or title, with associated images. */
export function getDudePage(idOrTitle: number | string): DudePageResult | null {
  const row =
    typeof idOrTitle === "number"
      ? db.prepare("SELECT * FROM dude_pages WHERE id = ?").get(idOrTitle)
      : db.prepare("SELECT * FROM dude_pages WHERE title = ? COLLATE NOCASE OR slug = ? COLLATE NOCASE").get(idOrTitle, idOrTitle);
  if (!row) return null;
  const page = row as DudePageResult;
  page.images = db
    .prepare("SELECT id, filename, alt_text, caption, local_path, original_url, wayback_url FROM dude_images WHERE page_id = ? ORDER BY sort_order")
    .all(page.id) as DudeImageResult[];
  return page;
}

// ── Current versions (live fetch) ──

const VERSION_BASE_URL = "https://upgrade.mikrotik.com/routeros/NEWESTa7";

/** Fetch current RouterOS versions from MikroTik's upgrade server. */
const WINBOX_URL = "https://upgrade.mikrotik.com/routeros/winbox/LATEST.4";

export async function fetchCurrentVersions(): Promise<{
  channels: Record<string, string | null>;
  winbox: string | null;
  fetched_at: string;
}> {
  const channels: Record<string, string | null> = {};
  const fetchOne = async (url: string): Promise<string | null> => {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!resp.ok) return null;
      const text = await resp.text();
      return text.trim().split(/\s+/)[0] || null;
    } catch {
      return null;
    }
  };
  const [, winbox] = await Promise.all([
    Promise.all(
      VERSION_CHANNELS.map(async (channel) => {
        channels[channel] = await fetchOne(`${VERSION_BASE_URL}.${channel}`);
      }),
    ),
    fetchOne(WINBOX_URL),
  ]);
  return { channels, winbox, fetched_at: new Date().toISOString() };
}
