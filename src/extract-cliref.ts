#!/usr/bin/env bun

/**
 * extract-cliref.ts — Parse manual.mikrotik.com /docs/cli-reference/* into the
 * source-faithful CLI-Reference overlay (cliref_* tables). Issue #124; design in
 * briefings/B-0016-cli-reference-overlay-design.md.
 *
 * Identity model (see #124 "Model correction: entries have paths; fields do not"):
 *   - An *entry* is a heading path of one kind: Directory / Settings Directory / Command.
 *   - Its *fields* are named Argument / Read-only Argument rows; a field has NO path,
 *     it maps to zero-to-many inspect coordinates (resolved elsewhere, via a view).
 *   - Its *flags* are print-output markers (`X` = disabled), never arguments.
 *
 * This extractor only populates the source tables + raw Markdown. The inspect
 * crosswalk (cliref_entry_schema_links) is a separate pass (link-cliref.ts), and
 * field links are a computed view — never stored here.
 *
 * Lossless-by-construction: each page's exact fetched Markdown + SHA-256 is retained
 * in cliref_pages, so a future parser improvement re-reads source without a re-fetch.
 *
 * Usage:
 *   bun run src/extract-cliref.ts                 # live fetch, caches .md to CACHE_DIR
 *   bun run src/extract-cliref.ts --from-cache    # re-extract from CACHE_DIR, no network
 *   bun run src/extract-cliref.ts --limit=25       # cap page count (smoke-testing)
 *   bun run src/extract-cliref.ts --check-counts   # assert parsed == source markers
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { db, initDb } from "./db.ts";
import { loadSitemapUrls } from "./rosetta-id.ts";

const BASE = "https://manual.mikrotik.com";
const LLMS_TXT_URL = `${BASE}/llms.txt`;
const CLI_PREFIX = "/docs/cli-reference/";
const PROJECT_ROOT = join(import.meta.dirname, "..");
const DEFAULT_CACHE_DIR = join(PROJECT_ROOT, "manual", "cli-reference");
const FETCH_DELAY_MS = 100;

// ── CLI flags ──

const argv = process.argv.slice(2);
const FROM_CACHE = argv.includes("--from-cache");
const CHECK_COUNTS = argv.includes("--check-counts");
const limitArg = argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.slice("--limit=".length)) : undefined;
const cacheDirArg = argv.find((a) => a.startsWith("--cache-dir="));
const CACHE_DIR = cacheDirArg ? cacheDirArg.slice("--cache-dir=".length) : DEFAULT_CACHE_DIR;

// ── Discovery ──

/** CLI-Reference slug for a URL, or null when the URL is out of scope / a category stub. */
export function cliRefSlug(urlOrPath: string): string | null {
  let path: string;
  try {
    path = new URL(urlOrPath).pathname;
  } catch {
    path = urlOrPath;
  }
  if (!path.startsWith(CLI_PREFIX)) return null;
  const slug = path.slice(CLI_PREFIX.length).replace(/\/$/, "");
  // The section root ("") and trailing-slash URLs are Docusaurus generated category
  // pages — navigation only, no .md source (every variant 404s, verified 2026-07-20).
  if (slug === "" || path.endsWith("/")) return null;
  return slug;
}

/** Cache filename for a slug: "interface/bridge" -> "interface__bridge.md". */
function cacheName(slug: string): string {
  return `${slug.replace(/\//g, "__")}.md`;
}

/**
 * Absolute cache path for a name, guaranteed to stay inside CACHE_DIR. cacheName()
 * already neutralizes "/" (→ "__"), but names derive from the network sitemap, so this
 * is an explicit containment backstop — a write can never escape the cache dir even from
 * a hostile slug (mirrors extract-docusaurus.ts's cache guard; satisfies CodeQL's
 * network-data-to-file / traversal check).
 */
function safeCachePath(name: string): string {
  const target = resolve(CACHE_DIR, name);
  const root = resolve(CACHE_DIR);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`cache name ${JSON.stringify(name)} resolves outside ${CACHE_DIR}`);
  }
  return target;
}

/** Slugs from cached filenames (offline discovery for --from-cache). Underscores in a
 * real segment never occur in CLI-Reference slugs, so "__" unambiguously marks a "/".
 * Excludes the section-landing `index.md` (`/docs/cli-reference/`): it is a prose
 * argument-type glossary, not command entries — sitemap discovery excludes it too (its
 * URL carries a trailing slash), and it has no `**Type:**` markers. Capturing that
 * glossary is a separate future task (relevant to the deferred raw_type parsing). */
function cachedSlugs(): string[] {
  if (!existsSync(CACHE_DIR)) return [];
  return readdirSync(CACHE_DIR)
    .filter((f) => f.endsWith(".md") && !f.startsWith("_") && f !== "index.md")
    .map((f) => f.slice(0, -3).replace(/__/g, "/"));
}

/** URL-parent slug segment used as the sidebar group ("interface/wifi" -> "interface"). */
function tocGroup(slug: string): string {
  return slug.includes("/") ? slug.slice(0, slug.lastIndexOf("/")) : "";
}

/** Sidebar labels from llms.txt link text — not derivable from the slug ("caps-man" -> "Caps Man"). */
async function loadTocNames(): Promise<Map<string, string>> {
  const cached = safeCachePath("_llms.txt");
  let txt: string;
  if (FROM_CACHE) {
    // --from-cache is an offline contract: never fall through to a live fetch.
    try {
      txt = readFileSync(cached, "utf8");
    } catch {
      throw new Error(`--from-cache set but no cached llms.txt at ${cached}`);
    }
  } else {
    const res = await fetch(LLMS_TXT_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Failed to fetch ${LLMS_TXT_URL}: HTTP ${res.status}`);
    txt = await res.text();
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(cached, txt);
  }
  const names = new Map<string, string>();
  for (const m of txt.matchAll(/^- \[([^\]]*)\]\((https:\/\/[^)]*)\)/gm)) {
    const slug = cliRefSlug(m[2].replace(/\.md$/, ""));
    if (slug !== null) names.set(slug, m[1]);
  }
  return names;
}

async function fetchPage(slug: string): Promise<string | null> {
  const file = safeCachePath(cacheName(slug));
  // Read directly (try/catch) rather than existsSync-then-read, closing the check-then-use
  // race CodeQL flags and keeping cache-hit the fast path.
  try {
    return readFileSync(file, "utf8");
  } catch {
    // not cached — fall through
  }
  if (FROM_CACHE) return null;
  const res = await fetch(`${BASE}${CLI_PREFIX}${slug}.md`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const body = await res.text();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(file, body);
  await Bun.sleep(FETCH_DELAY_MS);
  return body;
}

// ── Parsing ──

export interface CliRefField {
  fieldKind: "Argument" | "Read-only Argument";
  name: string;
  rawType: string;
  mandatory: boolean;
  unsettable: boolean;
  syscap: string | null;
  descriptionMarkdown: string;
  sourceOrder: number;
  sourceLine: number;
}

export interface CliRefFlag {
  flag: string;
  name: string;
  descriptionMarkdown: string;
  sourceOrder: number;
  sourceLine: number;
}

export interface CliRefEntry {
  localId: number;
  parentLocalId: number | null;
  sourceHeading: string;
  sourcePath: string;
  sourceType: "Directory" | "Settings Directory" | "Command";
  headingLevel: number;
  package: string | null;
  conditions: string | null;
  syscap: string | null;
  descriptionMarkdown: string;
  sourceOrder: number;
  sourceLine: number;
  sourceEndLine: number;
  fields: CliRefField[];
  flags: CliRefFlag[];
}

export interface CliRefPage {
  slug: string;
  url: string;
  tocName: string;
  tocGroup: string;
  sourceTitle: string | null;
  sourceMarkdown: string;
  sourceSha256: string;
  entries: CliRefEntry[];
}

const KNOWN_ENTRY_TYPES = new Set(["Directory", "Settings Directory", "Command"]);

/** Decode the XML entities that appear in ArgTable attribute/body text. */
function decode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Strip leading/trailing blank lines without touching internal whitespace. */
function trimBlankLines(s: string): string {
  return s.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
}

/**
 * Split off the MDX preamble (title / blurb / import lines / `---` rule). The body's
 * own headings are command paths, so the page-title h1 must not be walked as one —
 * top-level commands like `# app` also sit at h1. Returns the body plus the 1-based
 * source line the body starts on (for absolute line attribution).
 */
function splitPreamble(md: string): { title: string | null; body: string; bodyStartLine: number } {
  const lines = md.split("\n");
  const titleLine = lines.find((l) => l.startsWith("# "));
  const title = titleLine ? titleLine.slice(2).trim() : null;

  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\s*\{/.test(lines[i])) lastImport = i;
  }
  let start = lastImport + 1;
  while (start < lines.length && (lines[start].trim() === "" || /^-{3,}$/.test(lines[start].trim()))) {
    start++;
  }
  return { title, body: lines.slice(start).join("\n"), bodyStartLine: start + 1 };
}

/** Parse one <ArgTable>…</ArgTable> block into fields or flags depending on its c1 header. */
function parseArgTable(
  block: string,
  blockStartLine: number,
  entry: CliRefEntry,
  slug: string,
): void {
  const kind = block.match(/<ArgTable\b[^>]*\bc1="([^"]*)"/)?.[1] ?? "";
  for (const m of block.matchAll(/<ArgTableRow\b([\s\S]*?)>([\s\S]*?)<\/ArgTableRow>/g)) {
    const attrs = m[1];
    const attr = (n: string) => attrs.match(new RegExp(`\\b${n}="([\\s\\S]*?)"`))?.[1] ?? null;
    // 1-based source line of this row = block start + newlines before the match.
    const rowLine = blockStartLine + block.slice(0, m.index).split("\n").length - 1;
    const body = trimBlankLines(decode(m[2]));

    if (kind === "Flag") {
      entry.flags.push({
        flag: decode(attr("arg") ?? ""),
        name: decode(attr("typ") ?? ""),
        descriptionMarkdown: body,
        sourceOrder: entry.flags.length,
        sourceLine: rowLine,
      });
    } else if (kind === "Argument" || kind === "Read-only Argument") {
      entry.fields.push({
        fieldKind: kind,
        name: decode(attr("arg") ?? ""),
        rawType: decode(attr("typ") ?? ""),
        mandatory: attr("mandatory") === "1",
        unsettable: attr("unset") === "1",
        syscap: attr("syscap"),
        descriptionMarkdown: body,
        sourceOrder: entry.fields.length,
        sourceLine: rowLine,
      });
    } else {
      // Fail loud on an unrecognized ArgTable header rather than silently dropping rows.
      throw new Error(`${slug}: unknown ArgTable c1 header ${JSON.stringify(kind)} at line ${rowLine}`);
    }
  }
}

export function parsePage(slug: string, md: string, tocName: string): CliRefPage {
  const { title, body, bodyStartLine } = splitPreamble(md);
  const lines = body.split("\n");
  const entries: CliRefEntry[] = [];
  const parentStack: Array<{ level: number; localId: number }> = [];
  let current: CliRefEntry | null = null;
  const descLines: string[] = [];
  let inFence = false;

  const flushDesc = () => {
    if (current) current.descriptionMarkdown = trimBlankLines(descLines.join("\n"));
    descLines.length = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sourceLine = bodyStartLine + i; // 1-based line in the full file

    // Fenced code blocks hold CLI transcripts / example markdown. Nothing inside a fence
    // is structural: a "#"-prefixed row-number header (routing/id) must not parse as a
    // heading, and an example `**Type:**` line or `<ArgTable>` must not parse as a gate
    // marker or table. Toggle on the fence, keep every fenced line verbatim in the
    // description, and skip all structural detection until the fence closes.
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (current) descLines.push(line);
      continue;
    }
    if (inFence) {
      if (current) descLines.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      if (current) {
        current.sourceEndLine = sourceLine - 1;
        flushDesc();
      }
      const level = heading[1].length;
      while (parentStack.length > 0 && parentStack[parentStack.length - 1].level >= level) {
        parentStack.pop();
      }
      const localId = entries.length;
      current = {
        localId,
        parentLocalId: parentStack.length > 0 ? parentStack[parentStack.length - 1].localId : null,
        sourceHeading: heading[2].trim(),
        sourcePath: heading[2].trim(),
        sourceType: "Directory", // overwritten by the **Type:** marker; asserted below
        headingLevel: level,
        package: null,
        conditions: null,
        syscap: null,
        descriptionMarkdown: "",
        sourceOrder: localId,
        sourceLine,
        sourceEndLine: sourceLine,
        fields: [],
        flags: [],
      };
      entries.push(current);
      parentStack.push({ level, localId });
      continue;
    }

    if (!current) continue; // stray content before the first heading (only preamble remnants)

    const field = line.match(/^\*\*(Type|Package|Conditions|Syscap):\*\*\s*(.*)$/);
    if (field) {
      const value = field[2].trim() || null;
      if (field[1] === "Type") {
        if (value === null || !KNOWN_ENTRY_TYPES.has(value)) {
          throw new Error(`${slug}: unknown entry Type ${JSON.stringify(value)} at line ${sourceLine}`);
        }
        current.sourceType = value as CliRefEntry["sourceType"];
      } else if (field[1] === "Package") current.package = value;
      else if (field[1] === "Conditions") current.conditions = value;
      else current.syscap = value;
      continue; // gate markers are structured out of the prose description
    }

    if (line.startsWith("<ArgTable ")) {
      const end = lines.indexOf("</ArgTable>", i);
      if (end === -1) throw new Error(`${slug}: unterminated <ArgTable> at line ${sourceLine}`);
      parseArgTable(lines.slice(i, end + 1).join("\n"), sourceLine, current, slug);
      i = end;
      continue;
    }

    descLines.push(line);
  }
  if (current) {
    current.sourceEndLine = bodyStartLine + lines.length - 1;
    flushDesc();
  }

  return {
    slug,
    url: `${BASE}${CLI_PREFIX}${slug}`,
    tocName,
    tocGroup: tocGroup(slug),
    sourceTitle: title,
    sourceMarkdown: md,
    sourceSha256: new Bun.CryptoHasher("sha256").update(md).digest("hex"),
    entries,
  };
}

// ── Storage ──

function store(pages: CliRefPage[]): void {
  const insPage = db.prepare(
    `INSERT INTO cliref_pages (slug, url, toc_name, toc_group, source_title, source_markdown, source_sha256, source_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  const insEntry = db.prepare(
    `INSERT INTO cliref_entries
       (page_id, source_parent_id, source_heading, source_path, source_type, heading_level,
        package, conditions, syscap, description_markdown, source_order, source_line, source_end_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  const insField = db.prepare(
    `INSERT INTO cliref_fields
       (entry_id, field_kind, name, raw_type, mandatory, unsettable, syscap, description_markdown, source_order, source_line)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insFlag = db.prepare(
    `INSERT INTO cliref_flags (entry_id, flag, name, description_markdown, source_order, source_line)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    let pageOrder = 0;
    for (const page of pages) {
      const { id: pageId } = insPage.get(
        page.slug,
        page.url,
        page.tocName,
        page.tocGroup,
        page.sourceTitle,
        page.sourceMarkdown,
        page.sourceSha256,
        pageOrder++,
      ) as { id: number };

      const localToDb = new Map<number, number>();
      for (const e of page.entries) {
        const parentId = e.parentLocalId === null ? null : (localToDb.get(e.parentLocalId) ?? null);
        const { id: entryId } = insEntry.get(
          pageId,
          parentId,
          e.sourceHeading,
          e.sourcePath,
          e.sourceType,
          e.headingLevel,
          e.package,
          e.conditions,
          e.syscap,
          e.descriptionMarkdown,
          e.sourceOrder,
          e.sourceLine,
          e.sourceEndLine,
        ) as { id: number };
        localToDb.set(e.localId, entryId);

        for (const f of e.fields) {
          insField.run(
            entryId,
            f.fieldKind,
            f.name,
            f.rawType,
            f.mandatory ? 1 : 0,
            f.unsettable ? 1 : 0,
            f.syscap,
            f.descriptionMarkdown,
            f.sourceOrder,
            f.sourceLine,
          );
        }
        for (const fl of e.flags) {
          insFlag.run(entryId, fl.flag, fl.name, fl.descriptionMarkdown, fl.sourceOrder, fl.sourceLine);
        }
      }
    }
  })();
}

// ── Main ──

async function main(): Promise<void> {
  let slugs: string[];
  if (FROM_CACHE) {
    slugs = cachedSlugs().sort();
    console.log(`Discovering pages from cache: ${CACHE_DIR}`);
  } else {
    slugs = (await loadSitemapUrls())
      .map(cliRefSlug)
      .filter((s): s is string => s !== null)
      .sort();
  }
  if (LIMIT !== undefined) slugs = slugs.slice(0, LIMIT);

  const tocNames = await loadTocNames();
  console.log(`Discovered ${slugs.length} CLI-Reference pages (excluding generated category stubs)`);

  const pages: CliRefPage[] = [];
  const missing: string[] = [];
  for (const slug of slugs) {
    const md = await fetchPage(slug);
    if (md === null) {
      missing.push(slug);
      continue;
    }
    const tocName = tocNames.get(slug);
    if (tocName === undefined) throw new Error(`No llms.txt toc_name for slug ${JSON.stringify(slug)}`);
    pages.push(parsePage(slug, md, tocName));
  }

  const entries = pages.flatMap((p) => p.entries);
  const fields = entries.flatMap((e) => e.fields);
  const flags = entries.flatMap((e) => e.flags);
  console.log(
    `Parsed ${pages.length} pages -> ${entries.length} entries, ${fields.length} fields, ${flags.length} flags`,
  );
  if (missing.length > 0) {
    // In a full live run, a missing .md is a fetch failure that would silently ship a
    // partial overlay (the count asserts below only see fetched pages). Fail hard.
    // --from-cache and --limit are intentionally partial, so only warn there.
    const msg = `Missing (no .md): ${missing.join(", ")}`;
    if (!FROM_CACHE && LIMIT === undefined) {
      throw new Error(`${msg}\nRefusing to store a partial overlay from a full live run.`);
    }
    console.log(msg);
  }

  // Crash-early: parsed structure must reconcile with the raw source markers.
  const rawTypeMarkers = pages
    .map((p) => p.sourceMarkdown.match(/^\*\*Type:\*\*/gm)?.length ?? 0)
    .reduce((a, b) => a + b, 0);
  const rawRows = pages
    .map((p) => p.sourceMarkdown.match(/<ArgTableRow\b/g)?.length ?? 0)
    .reduce((a, b) => a + b, 0);
  if (rawTypeMarkers !== entries.length) {
    throw new Error(`entry drift: ${rawTypeMarkers} **Type:** markers, ${entries.length} entries parsed`);
  }
  if (rawRows !== fields.length + flags.length) {
    throw new Error(
      `row drift: ${rawRows} <ArgTableRow> in source, ${fields.length + flags.length} fields+flags parsed`,
    );
  }
  if (CHECK_COUNTS) console.log(`Count check OK: ${rawTypeMarkers} entries, ${rawRows} field+flag rows`);

  initDb();
  db.run("DELETE FROM cliref_entry_schema_links;");
  db.run("DELETE FROM cliref_flags;");
  db.run("DELETE FROM cliref_fields;");
  db.run("DELETE FROM cliref_entries;");
  db.run("DELETE FROM cliref_pages;");
  store(pages);
  console.log(`Stored into ${process.env.DB_PATH ?? "ros-help.db"}`);
}

if (import.meta.main) {
  await main();
}
