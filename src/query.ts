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
};

export type SearchResponse = {
  query: string;
  ftsQuery: string;
  fallbackMode: "or" | null;
  results: SearchResult[];
  total: number;
};

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

/** Get full page content by ID or title. */
export function getPage(idOrTitle: string | number): {
  id: number;
  title: string;
  path: string;
  url: string;
  text: string;
  code: string;
  word_count: number;
  callouts: Array<{ type: string; content: string }>;
} | null {
  const row =
    typeof idOrTitle === "number" || /^\d+$/.test(String(idOrTitle))
      ? db.prepare("SELECT id, title, path, url, text, code, word_count FROM pages WHERE id = ?").get(Number(idOrTitle))
      : db.prepare("SELECT id, title, path, url, text, code, word_count FROM pages WHERE title = ? COLLATE NOCASE").get(idOrTitle);
  if (!row) return null;
  const page = row as { id: number; title: string; path: string; url: string; text: string; code: string; word_count: number };
  const callouts = db
    .prepare("SELECT type, content FROM callouts WHERE page_id = ? ORDER BY sort_order")
    .all(page.id) as Array<{ type: string; content: string }>;
  return { ...page, callouts };
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
  page_title: string;
  page_url: string;
  excerpt: string;
}> {
  const terms = extractTerms(query);
  if (terms.length === 0) return [];
  const ftsQuery = buildFtsQuery(terms, "AND");
  if (!ftsQuery) return [];
  try {
    return db
      .prepare(
        `SELECT p.name, p.type, p.default_val, p.description, p.section,
                pg.title as page_title, pg.url as page_url,
                snippet(properties_fts, 1, '**', '**', '...', 20) as excerpt
         FROM properties_fts fts
         JOIN properties p ON p.id = fts.rowid
         JOIN pages pg ON pg.id = p.page_id
         WHERE properties_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, limit) as typeof searchProperties extends (...a: unknown[]) => infer R ? R : never;
  } catch {
    return [];
  }
}

/** Search callout content via FTS, optionally filtered by type. */
export function searchCallouts(
  query: string,
  type?: string,
  limit = 10,
): Array<{
  type: string;
  content: string;
  page_title: string;
  page_url: string;
  page_id: number;
  excerpt: string;
}> {
  const terms = extractTerms(query);
  if (terms.length === 0) return [];
  const ftsQuery = buildFtsQuery(terms, "AND");
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
      ? (db.prepare(sql).all(ftsQuery, type, limit) as Array<{ type: string; content: string; page_title: string; page_url: string; page_id: number; excerpt: string }>)
      : (db.prepare(sql).all(ftsQuery, limit) as Array<{ type: string; content: string; page_title: string; page_url: string; page_id: number; excerpt: string }>);
  } catch {
    return [];
  }
}

/** Check which RouterOS versions include a given command path. */
export function checkCommandVersions(
  commandPath: string,
): {
  command_path: string;
  versions: string[];
  first_seen: string | null;
  last_seen: string | null;
} {
  const rows = db
    .prepare(
      `SELECT ros_version FROM command_versions
       WHERE command_path = ?
       ORDER BY ros_version`,
    )
    .all(commandPath) as Array<{ ros_version: string }>;
  const versions = rows.map((r) => r.ros_version);
  return {
    command_path: commandPath,
    versions,
    first_seen: versions[0] ?? null,
    last_seen: versions[versions.length - 1] ?? null,
  };
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

const VERSION_CHANNELS = ["stable", "long-term", "testing", "development"] as const;
const VERSION_BASE_URL = "https://upgrade.mikrotik.com/routeros/NEWESTa7";

/** Fetch current RouterOS versions from MikroTik's upgrade server. */
export async function fetchCurrentVersions(): Promise<{
  channels: Record<string, string | null>;
  fetched_at: string;
}> {
  const channels: Record<string, string | null> = {};
  await Promise.all(
    VERSION_CHANNELS.map(async (channel) => {
      try {
        const resp = await fetch(`${VERSION_BASE_URL}.${channel}`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) {
          const text = await resp.text();
          channels[channel] = text.trim().split(/\s+/)[0] || null;
        } else {
          channels[channel] = null;
        }
      } catch {
        channels[channel] = null;
      }
    }),
  );
  return { channels, fetched_at: new Date().toISOString() };
}
