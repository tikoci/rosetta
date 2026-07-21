/**
 * export.ts — `rosetta export <dir>`: a deterministic dataset directory built
 * from the runtime SQLite database ALONE (B-0022 / issue #101, the "E1 spine").
 *
 * This is the spine of the export track: the command, the TSV serialization
 * contract, and `manifest.toml`, proven by exactly two datasets — `changelog.tsv`
 * (trivially direct) and `callouts.tsv` (the only multiline scalar in the whole
 * export set, so it exercises the hardest part of the serializer). E2–E4 add more
 * datasets on top of the contract settled here.
 *
 * Hard boundary (B-0022 "the shipped DB is the source"): this module reads ONLY
 * the database handle passed to `runExport`. It must not read `matrix/**`,
 * `transcripts/**`, `manual/pages/**`, `inspect.json`/`deep-inspect.json`, the git
 * checkout, or any network source, and must not re-run an extractor or parse
 * Markdown. An unavailable column is omitted and disclosed in the manifest, never
 * recovered from a cache — recovering it would defeat the audit that justifies the
 * whole surface.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { compareVersions } from "./version-compare.ts";

// ── TSV serialization contract ────────────────────────────────────────────────
//
// Postgres COPY / MySQL text convention. No scalar column in the corpus contains
// a tab today (re-verified on rc.99 across the candidate columns), so plain
// tab-delimited output is lossless — but that is a MEASURED property, not an
// invariant. So rather than adopt quote-aware TSV (which would cost every simple
// consumer the one-line-equals-one-record property), we backstop every value with
// a documented, reversible in-place escape that fires on tab, LF, CR, and the
// escape character itself. SQL NULL is a distinct fact from the empty string, so
// it gets its own whole-field token that a real value can never collide with
// (a literal "\N" value encodes to "\\N" because backslash is escaped first).

/** Whole-field token for SQL NULL. A genuine value can never produce it. */
export const TSV_NULL = "\\N";

const TSV_ESCAPE = "Backslash-escaped, Postgres COPY text convention: \\\\=backslash, \\t=tab, \\n=LF, \\r=CR. A field exactly equal to \\N is SQL NULL; an empty field is the empty string. Applied as a general backstop to every value, not only known-multiline columns.";

/** Word-count rule shared across the whole export (matches the extractor). */
export const WORD_COUNT_RULE = "Whitespace-delimited token count: text.split(/\\s+/).filter(Boolean).length";

export type TsvScalar = string | number | null;

/**
 * Encode one field. NULL becomes the whole-field token; every other value is
 * stringified and has its backslash, tab, LF, and CR made reversible. Backslash
 * is escaped first so no other escape can be forged and so a literal "\N" cannot
 * masquerade as NULL.
 */
export function encodeTsvField(value: TsvScalar): string {
  if (value === null) return TSV_NULL;
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/** Inverse of {@link encodeTsvField}. Returns null for the NULL token. */
export function decodeTsvField(field: string): string | null {
  if (field === TSV_NULL) return null;
  let out = "";
  for (let i = 0; i < field.length; i++) {
    const ch = field[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = field[++i];
    if (next === "\\") out += "\\";
    else if (next === "t") out += "\t";
    else if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    // A backslash before anything else cannot occur in output this module
    // produced; crash-early rather than silently corrupt on malformed input.
    else throw new Error(`decodeTsvField: invalid escape \\${next ?? "<eof>"}`);
  }
  return out;
}

/** Serialize a table to TSV: header row, then one line per row, LF-terminated. */
export function toTsv(columns: string[], rows: TsvScalar[][]): string {
  const lines = [columns.map(encodeTsvField).join("\t")];
  for (const row of rows) lines.push(row.map(encodeTsvField).join("\t"));
  return `${lines.join("\n")}\n`;
}

/** Parse a TSV string this module produced back into decoded fields. */
export function parseTsv(content: string): { columns: string[]; rows: (string | null)[][] } {
  const lines = content.replace(/\n$/, "").split("\n");
  const [header, ...body] = lines;
  return {
    columns: (header ?? "").split("\t").map((f) => decodeTsvField(f) as string),
    rows: body.map((line) => line.split("\t").map(decodeTsvField)),
  };
}

/** Words per the single shared rule. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** UTF-8 byte length — the shared size rule for the byte-count columns. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Filesystem-safe, deterministic, reversible encoding of a raw slug/title for use
 * as a file or directory name. Settled here (E1) so E4's per-fragment files inherit
 * it; the raw value always stays in a column and the encoded name is emitted as its
 * own column so the row↔file match is definitive rather than reconstructed.
 * Percent-encodes any byte outside the portable set [A-Za-z0-9._-]. The `u` flag
 * makes the regex iterate whole code points, so distinct astral characters (emoji)
 * cannot collapse to the same surrogate-replacement bytes. The reserved directory
 * names "." and ".." are escaped whole so an encoded name can never be either.
 */
export function encodeFsName(raw: string): string {
  if (raw === "." || raw === "..") return raw.replace(/\./g, "%2E");
  const encoder = new TextEncoder();
  return raw.replace(/[^A-Za-z0-9._-]/gu, (ch) =>
    [...encoder.encode(ch)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join(""),
  );
}

// ── manifest.toml ─────────────────────────────────────────────────────────────

function tomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  return `"${escaped}"`;
}

function tomlValue(value: string | number | boolean | string[]): string {
  if (Array.isArray(value)) return `[${value.map(tomlString).join(", ")}]`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return tomlString(value);
}

type TomlTable = Record<string, string | number | boolean | string[]>;

/** Deterministic TOML emitter for the fixed manifest shape (no wall-clock value). */
function emitToml(sections: {
  header: string[];
  root: TomlTable;
  provenance: TomlTable;
  contract: TomlTable;
  files: TomlTable[];
  disclosures: TomlTable[];
}): string {
  const out: string[] = [...sections.header.map((l) => `# ${l}`), ""];
  const table = (t: TomlTable) => {
    for (const [k, v] of Object.entries(t)) out.push(`${k} = ${tomlValue(v)}`);
  };
  table(sections.root);
  out.push("", "[provenance]");
  table(sections.provenance);
  out.push("", "[contract]");
  table(sections.contract);
  for (const f of sections.files) {
    out.push("", "[[files]]");
    table(f);
  }
  for (const d of sections.disclosures) {
    out.push("", "[[disclosures]]");
    table(d);
  }
  return `${out.join("\n")}\n`;
}

// ── Datasets (each reads only the passed handle; no caches, no network) ───────
//
// A dataset is a flat top-level TSV: a name, the SQLite table it primarily draws
// from, the emitted columns (direct columns keep their SQLite names; joined/derived
// values are named for what they are), a documented total order so output is
// byte-identical across runs, and the rows themselves. Direct columns keep their
// SQLite names as a loose column-name audit; derived columns are named for clarity.

type Dataset = { name: string; source_table: string; columns: string[]; order_by: string; rows: TsvScalar[][] };

const ORDER_PAGE_FRAGMENT = "page_id, sort_order, id";

/**
 * changelog.tsv — direct from `changelogs`, newest version first via the
 * numeric/beta/RC comparator (never SQL lexical order — "7.9.2" sorts above
 * "7.24rc1" as a string), then source order within a version. UNIQUE(version,
 * sort_order) makes this a total order.
 */
function readChangelog(database: Database): Dataset {
  // sort_order before description so the one long free-text column stays last.
  const columns = ["version", "released", "category", "is_breaking", "sort_order", "description"];
  const rows = database.prepare(`SELECT ${columns.join(", ")} FROM changelogs`).all() as Array<Record<string, TsvScalar>>;
  rows.sort((a, b) => compareVersions(String(b.version), String(a.version)) || Number(a.sort_order) - Number(b.sort_order));
  return {
    name: "changelog.tsv",
    source_table: "changelogs",
    columns,
    order_by: "version (numeric/beta/rc comparator, newest first), then sort_order",
    rows: rows.map((r) => columns.map((c) => r[c])),
  };
}

/**
 * callouts.tsv — `callouts` joined to `pages` (rosetta_id) and `sections` (anchor),
 * so a reader identifies the owning page/section by name without joining back to the
 * DB — the same rosetta_id/section_anchor pairing properties.tsv already emits. The
 * raw FK ids stay as a loose column-name audit; section_id/section_anchor are NULL
 * when no section resolves (rare since B-0023's `_lead`). Long `content` stays last.
 */
function readCallouts(database: Database): Dataset {
  const columns = ["page_id", "rosetta_id", "section_id", "section_anchor", "type", "sort_order", "content"];
  const rows = database
    .prepare(`
      SELECT c.page_id, pg.rosetta_id, c.section_id, s.anchor_id AS section_anchor,
             c.type, c.sort_order, c.content
      FROM callouts c
      JOIN pages pg ON pg.id = c.page_id
      LEFT JOIN sections s ON s.id = c.section_id
      ORDER BY c.page_id, c.sort_order, c.id`)
    .all() as Array<Record<string, TsvScalar>>;
  return {
    name: "callouts.tsv",
    source_table: "callouts",
    columns,
    order_by: ORDER_PAGE_FRAGMENT,
    rows: rows.map((r) => columns.map((c) => r[c])),
  };
}

/**
 * properties.tsv — `properties` joined to `pages` (slug/rosetta_id/title/url) and
 * `sections` (anchor). Since #90 landed, `section_id` is a real FK, so `section`
 * (the stored heading text) and `section_anchor` (the resolved anchor) sit side by
 * side — the export of #90's fix rather than the pre-#90 heading-text workaround.
 */
function readProperties(database: Database): Dataset {
  const columns = [
    "page_id", "rosetta_id", "slug", "title", "url",
    "name", "type", "default_val", "description",
    "section", "section_id", "section_anchor", "source_table_row_id", "sort_order",
  ];
  const rows = database
    .prepare(`
      SELECT p.page_id, pg.rosetta_id, pg.slug, pg.title, pg.url,
             p.name, p.type, p.default_val, p.description,
             p.section, p.section_id, s.anchor_id AS section_anchor,
             p.source_table_row_id, p.sort_order
      FROM properties p
      JOIN pages pg ON pg.id = p.page_id
      LEFT JOIN sections s ON s.id = p.section_id
      ORDER BY p.page_id, p.sort_order, p.id`)
    .all() as Array<Record<string, TsvScalar>>;
  return { name: "properties.tsv", source_table: "properties", columns, order_by: "page_id, sort_order, id", rows: rows.map((r) => columns.map((c) => r[c])) };
}

/**
 * videos.tsv — direct `videos` metadata plus per-video transcript aggregates from
 * `video_segments` (segment count, word count via the shared rule, UTF-8 bytes).
 * A video usually carries at least one segment, but the schema does not enforce it
 * (the cache importer can store a video with no segments), so the aggregate falls
 * back to honest zeros rather than assuming a row. The multiline `description` is
 * emitted last so the numeric columns stay left.
 */
function readVideos(database: Database): Dataset {
  const columns = [
    "video_id", "title", "channel", "upload_date", "duration_s", "url",
    "view_count", "like_count", "has_chapters",
    "segment_count", "transcript_word_count", "transcript_bytes", "description",
  ];
  const aggregates = new Map<number, { count: number; words: number; bytes: number }>();
  for (const s of database.prepare("SELECT video_id, transcript FROM video_segments").all() as Array<{ video_id: number; transcript: string }>) {
    const a = aggregates.get(s.video_id) ?? { count: 0, words: 0, bytes: 0 };
    a.count += 1;
    a.words += countWords(s.transcript);
    a.bytes += utf8Bytes(s.transcript);
    aggregates.set(s.video_id, a);
  }
  const videos = database
    .prepare("SELECT id, video_id, title, channel, upload_date, duration_s, url, view_count, like_count, has_chapters, description FROM videos ORDER BY video_id")
    .all() as Array<Record<string, TsvScalar> & { id: number }>;
  const rows = videos.map((v) => {
    const a = aggregates.get(v.id) ?? { count: 0, words: 0, bytes: 0 };
    return [
      v.video_id, v.title, v.channel, v.upload_date, v.duration_s, v.url,
      v.view_count, v.like_count, v.has_chapters,
      a.count, a.words, a.bytes, v.description,
    ];
  });
  return { name: "videos.tsv", source_table: "videos", columns, order_by: "video_id", rows };
}

/** commands.tsv — direct from `commands`, ordered by the UNIQUE path. */
function readCommands(database: Database): Dataset {
  const columns = ["path", "name", "type", "parent_path", "page_id", "description", "ros_version"];
  const rows = database.prepare(`SELECT ${columns.join(", ")} FROM commands ORDER BY path`).all() as Array<Record<string, TsvScalar>>;
  return { name: "commands.tsv", source_table: "commands", columns, order_by: "path", rows: rows.map((r) => columns.map((c) => r[c])) };
}

/** Table counts keyed by a column of `page_tables` (page_id or section_id). */
function tableCounts(database: Database, key: "page_id" | "section_id"): Map<number, { tables: number; rows: number }> {
  const out = new Map<number, { tables: number; rows: number }>();
  const where = key === "section_id" ? "WHERE section_id IS NOT NULL" : "";
  for (const t of database.prepare(`SELECT ${key} AS k, data_row_count FROM page_tables ${where}`).all() as Array<{ k: number; data_row_count: number }>) {
    const a = out.get(t.k) ?? { tables: 0, rows: 0 };
    a.tables += 1;
    a.rows += t.data_row_count;
    out.set(t.k, a);
  }
  return out;
}

/**
 * sections.tsv — one row per `sections` fragment (including the synthetic `_lead`
 * fragment, B-0023), keyed to its page, carrying the fragment's sizing (word count,
 * UTF-8 text/code bytes) and its table counts. This is the pivot-able view: grouping
 * these rows by page_id rolls the section counts up to (near-)page totals — the small
 * residual against pages.tsv is heading-text lines that live in no fragment. The
 * whole-page counts live in pages.tsv (two audiences, same core data). A fragment
 * with word_count = 0 is a self-flagging empty section (#93).
 */
function readSections(database: Database): Dataset {
  const columns = [
    "page_id", "rosetta_id", "slug", "title", "url",
    "section_id", "anchor_id", "heading", "level", "sort_order",
    "word_count", "text_bytes", "code_bytes", "table_count", "table_row_count",
  ];
  const secTables = tableCounts(database, "section_id");
  const secs = database
    .prepare(`
      SELECT s.id, s.page_id, pg.rosetta_id, pg.slug, pg.title, pg.url,
             s.anchor_id, s.heading, s.level, s.sort_order, s.word_count, s.text, s.code
      FROM sections s JOIN pages pg ON pg.id = s.page_id
      ORDER BY s.page_id, s.sort_order, s.id`)
    .all() as Array<Record<string, TsvScalar> & { id: number; text: string; code: string }>;
  const rows = secs.map((s) => {
    const t = secTables.get(s.id) ?? { tables: 0, rows: 0 };
    return [
      s.page_id, s.rosetta_id, s.slug, s.title, s.url,
      s.id, s.anchor_id, s.heading, s.level, s.sort_order,
      s.word_count, utf8Bytes(s.text), utf8Bytes(s.code), t.tables, t.rows,
    ];
  });
  return { name: "sections.tsv", source_table: "sections", columns, order_by: "page_id, sections.sort_order, sections.id", rows };
}

/**
 * tables.tsv — one row per `page_tables` record: the inventory of every Markdown
 * table the extractor captured (#92), keyed to its page and resolving section, with
 * the table's shape (column/data-row counts, ragged flag) and source size as the
 * UTF-8 byte length of the stored raw Markdown. This is the "what tables exist and
 * where" list — a lightweight index answering most table-audit questions without
 * exporting the cell data itself (E4's per-fragment files, issue #104).
 *
 * Column order puts the human-readable identity (title, source_heading) and the
 * shape/size stats up front, then the identifier columns, then the two long URL
 * columns last, so the file skims left-to-right for a human reviewer.
 *
 * `is_property_source` (0/1) flags whether this table actually produced ≥1 row in
 * the `properties` table (the data `routeros_lookup_property` surfaces) — a
 * property's `source_table_row_id` resolves back through `page_table_rows` to this
 * table. It is "did extraction yield properties from here", NOT "does this look like
 * a property table": a property-shaped table the gates skipped (the 27 property-
 * headed tables of #100) is honestly 0, which is the signal a human review uses to
 * find the tables B-0077 still needs to recognize.
 *
 * `table_url` deep-links to the section that contains the table (`url#anchor`);
 * Docusaurus has no per-table anchor, so a table with no resolvable section
 * (section_id NULL) links to the bare page URL, and a page with no URL yields NULL.
 * Ordered by the UNIQUE(page_id, sort_order) key, so it is a total order.
 */
function readTables(database: Database): Dataset {
  const columns = [
    "page_id", "sort_order", "title", "source_heading",
    "data_row_count", "column_count", "is_ragged", "is_property_source", "raw_bytes",
    "slug", "section_anchor", "rosetta_id", "section_id", "table_url", "url",
  ];
  const rows = database
    .prepare(`
      SELECT pt.page_id, pt.sort_order, pg.title, pt.source_heading,
             pt.data_row_count, pt.column_count, pt.is_ragged,
             EXISTS (
               SELECT 1 FROM page_table_rows ptr
               JOIN properties pr ON pr.source_table_row_id = ptr.id
               WHERE ptr.table_id = pt.id
             ) AS is_property_source,
             pt.raw_markdown,
             pg.slug, s.anchor_id AS section_anchor, pg.rosetta_id, pt.section_id, pg.url
      FROM page_tables pt
      JOIN pages pg ON pg.id = pt.page_id
      LEFT JOIN sections s ON s.id = pt.section_id
      ORDER BY pt.page_id, pt.sort_order, pt.id`)
    .all() as Array<Record<string, TsvScalar> & { raw_markdown: string; url: string | null; section_anchor: string | null }>;
  const rowsOut = rows.map((r) => {
    // A NULL url can't form a link — emit NULL rather than the string "null#anchor".
    const tableUrl = r.url == null ? null : r.section_anchor ? `${r.url}#${r.section_anchor}` : r.url;
    return [
      r.page_id, r.sort_order, r.title, r.source_heading,
      r.data_row_count, r.column_count, r.is_ragged, r.is_property_source, utf8Bytes(r.raw_markdown),
      r.slug, r.section_anchor, r.rosetta_id, r.section_id, tableUrl, r.url,
    ];
  });
  return { name: "tables.tsv", source_table: "page_tables", columns, order_by: "page_id, page_tables.sort_order, page_tables.id", rows: rowsOut };
}

/**
 * pages.tsv — one row per `pages` record with the page's own stored word count,
 * section/empty-section counts, UTF-8 text/code bytes, and table counts. This is the
 * whole-page view, small enough to read directly on GitHub; the per-section rows that
 * pivot up to (near-)these totals are sections.tsv. No section-sum column is emitted
 * here — pivot sections.tsv for that — so the two files never duplicate a rollup.
 */
function readPages(database: Database): Dataset {
  const columns = [
    "page_id", "rosetta_id", "slug", "title", "url",
    "word_count", "section_count", "empty_section_count",
    "text_bytes", "code_bytes", "table_count", "table_row_count",
  ];
  const pageTables = tableCounts(database, "page_id");
  const secStats = new Map<number, { count: number; empty: number }>();
  for (const s of database.prepare("SELECT page_id, word_count FROM sections").all() as Array<{ page_id: number; word_count: number }>) {
    const a = secStats.get(s.page_id) ?? { count: 0, empty: 0 };
    a.count += 1;
    if (s.word_count === 0) a.empty += 1;
    secStats.set(s.page_id, a);
  }
  const pages = database
    .prepare("SELECT id, rosetta_id, slug, title, url, word_count, text, code FROM pages ORDER BY id")
    .all() as Array<Record<string, TsvScalar> & { id: number; text: string; code: string }>;
  const rows = pages.map((p) => {
    const s = secStats.get(p.id) ?? { count: 0, empty: 0 };
    const t = pageTables.get(p.id) ?? { tables: 0, rows: 0 };
    return [
      p.id, p.rosetta_id, p.slug, p.title, p.url,
      p.word_count, s.count, s.empty,
      utf8Bytes(p.text), utf8Bytes(p.code), t.tables, t.rows,
    ];
  });
  return { name: "pages.tsv", source_table: "pages", columns, order_by: "page_id", rows };
}

// ── CLI-Reference overlay datasets (issue #124) ───────────────────────────────
//
// Six TSVs under cli-reference/ plus byte-exact source/<slug>.md files. Entries own a
// source path; fields own a name and zero-to-many inspect coordinates (never a path).
// All counts are derived here, never stored redundantly on the rows.

/** True only when the CLI-Reference overlay is present AND populated — an empty overlay
 * (fresh schema, no extract-cliref run yet) emits no cli-reference/ output at all. */
function hasCliRef(database: Database): boolean {
  const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cliref_pages'").get();
  if (!table) return false;
  return !!database.prepare("SELECT 1 FROM cliref_pages LIMIT 1").get();
}

/** field_id → number of inspect-arg links, from the computed view (materialized once). */
function fieldLinkCounts(database: Database): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of database.prepare("SELECT field_id, COUNT(*) AS c FROM cliref_field_inspect_links GROUP BY field_id").all() as Array<{ field_id: number; c: number }>) {
    m.set(r.field_id, r.c);
  }
  return m;
}

function childCounts(database: Database, table: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of database.prepare(`SELECT entry_id, COUNT(*) AS c FROM ${table} GROUP BY entry_id`).all() as Array<{ entry_id: number; c: number }>) {
    m.set(r.entry_id, r.c);
  }
  return m;
}

/** The six cli-reference/*.tsv datasets. Empty array when the overlay is absent. */
function readCliRefDatasets(database: Database): Dataset[] {
  if (!hasCliRef(database)) return [];
  const fieldCount = childCounts(database, "cliref_fields");
  const flagCount = childCounts(database, "cliref_flags");
  const linkCount = fieldLinkCounts(database);

  // pages.tsv — page metadata + source byte size + derived entry count. The raw
  // Markdown itself lives in source/<slug>.md, hashed by source_sha256.
  const pageCols = ["page_id", "slug", "url", "toc_name", "toc_group", "source_title", "source_order", "source_bytes", "source_sha256", "entry_count"];
  const entryByPage = new Map<number, number>();
  for (const r of database.prepare("SELECT page_id, COUNT(*) AS c FROM cliref_entries GROUP BY page_id").all() as Array<{ page_id: number; c: number }>) entryByPage.set(r.page_id, r.c);
  // source_bytes is computed in SQLite (length of the UTF-8 BLOB) so pages.tsv never loads
  // the full source_markdown into memory — cliRefSourceFiles() reads it separately to write
  // source/<slug>.md, and loading it twice doubled the large-text reads for nothing.
  const pages = database.prepare("SELECT id, slug, url, toc_name, toc_group, source_title, source_order, length(CAST(source_markdown AS BLOB)) AS source_bytes, source_sha256 FROM cliref_pages ORDER BY source_order").all() as Array<Record<string, TsvScalar> & { id: number; source_bytes: number }>;
  const pagesDs: Dataset = {
    name: "cli-reference/pages.tsv",
    source_table: "cliref_pages",
    columns: pageCols,
    order_by: "source_order",
    rows: pages.map((p) => [p.id, p.slug, p.url, p.toc_name, p.toc_group, p.source_title, p.source_order, p.source_bytes, p.source_sha256, entryByPage.get(p.id) ?? 0]),
  };

  // entries.tsv — the entry inventory with its exact/alias/manual-only match status,
  // resolved inspect path, and derived field/flag counts. Long description last.
  const entryCols = ["entry_id", "page_slug", "source_path", "source_heading", "source_type", "heading_level", "package", "conditions", "syscap", "source_parent_id", "match_kind", "inspect_path", "field_count", "flag_count", "source_order", "source_line", "source_end_line", "description_markdown"];
  const entries = database.prepare(`
    SELECT e.id, p.slug AS page_slug, e.source_path, e.source_heading, e.source_type, e.heading_level,
           e.package, e.conditions, e.syscap, e.source_parent_id,
           l.match_kind, sn.path AS inspect_path,
           e.source_order, e.source_line, e.source_end_line, e.description_markdown
    FROM cliref_entries e
    JOIN cliref_pages p ON p.id = e.page_id
    LEFT JOIN cliref_entry_schema_links l ON l.entry_id = e.id
    LEFT JOIN schema_nodes sn ON sn.id = l.schema_node_id
    ORDER BY e.page_id, e.source_order`).all() as Array<Record<string, TsvScalar> & { id: number }>;
  const entriesDs: Dataset = {
    name: "cli-reference/entries.tsv",
    source_table: "cliref_entries",
    columns: entryCols,
    order_by: "page_id, source_order",
    rows: entries.map((e) => [e.id, e.page_slug, e.source_path, e.source_heading, e.source_type, e.heading_level, e.package, e.conditions, e.syscap, e.source_parent_id, e.match_kind, e.inspect_path, fieldCount.get(e.id) ?? 0, flagCount.get(e.id) ?? 0, e.source_order, e.source_line, e.source_end_line, e.description_markdown]),
  };

  // fields.tsv — fields by their owning entry's source path (entry_source_path, NEVER a
  // field_path) plus a derived inspect_link_count. The zero-to-many coordinates live in
  // field-inspect-links.tsv. Long description last.
  const fieldCols = ["field_id", "entry_id", "entry_source_path", "field_kind", "name", "raw_type", "mandatory", "unsettable", "syscap", "inspect_link_count", "source_order", "source_line", "description_markdown"];
  const fields = database.prepare(`
    SELECT f.id, f.entry_id, e.source_path AS entry_source_path, f.field_kind, f.name, f.raw_type,
           f.mandatory, f.unsettable, f.syscap, f.source_order, f.source_line, f.description_markdown
    FROM cliref_fields f JOIN cliref_entries e ON e.id = f.entry_id
    ORDER BY f.entry_id, f.source_order`).all() as Array<Record<string, TsvScalar> & { id: number }>;
  const fieldsDs: Dataset = {
    name: "cli-reference/fields.tsv",
    source_table: "cliref_fields",
    columns: fieldCols,
    order_by: "entry_id, source_order",
    rows: fields.map((f) => [f.id, f.entry_id, f.entry_source_path, f.field_kind, f.name, f.raw_type, f.mandatory, f.unsettable, f.syscap, linkCount.get(f.id) ?? 0, f.source_order, f.source_line, f.description_markdown]),
  };

  // flags.tsv — print-output flag letters, kept apart from fields. Long description last.
  const flagCols = ["flag_id", "entry_id", "entry_source_path", "flag", "name", "source_order", "source_line", "description_markdown"];
  const flags = database.prepare(`
    SELECT fl.id, fl.entry_id, e.source_path AS entry_source_path, fl.flag, fl.name, fl.source_order, fl.source_line, fl.description_markdown
    FROM cliref_flags fl JOIN cliref_entries e ON e.id = fl.entry_id
    ORDER BY fl.entry_id, fl.source_order`).all() as Array<Record<string, TsvScalar> & { id: number }>;
  const flagsDs: Dataset = {
    name: "cli-reference/flags.tsv",
    source_table: "cliref_flags",
    columns: flagCols,
    order_by: "entry_id, source_order",
    rows: flags.map((fl) => [fl.id, fl.entry_id, fl.entry_source_path, fl.flag, fl.name, fl.source_order, fl.source_line, fl.description_markdown]),
  };

  // entry-inspect-links.tsv — the STORED entry crosswalk with its exact/alias detail.
  const entryLinkCols = ["entry_id", "entry_source_path", "match_kind", "match_detail", "schema_node_id", "inspect_path", "inspect_type"];
  const entryLinks = database.prepare(`
    SELECT l.entry_id, e.source_path AS entry_source_path, l.match_kind, l.match_detail,
           l.schema_node_id, sn.path AS inspect_path, COALESCE(sn.inspect_type, sn.type) AS inspect_type
    FROM cliref_entry_schema_links l
    JOIN cliref_entries e ON e.id = l.entry_id
    JOIN schema_nodes sn ON sn.id = l.schema_node_id
    ORDER BY l.entry_id`).all() as Array<Record<string, TsvScalar>>;
  const entryLinksDs: Dataset = {
    name: "cli-reference/entry-inspect-links.tsv",
    source_table: "cliref_entry_schema_links",
    columns: entryLinkCols,
    order_by: "entry_id",
    rows: entryLinks.map((r) => entryLinkCols.map((c) => r[c])),
  };

  // field-inspect-links.tsv — the COMPUTED view: one row per (field, inspect arg node),
  // exposing the actual zero-to-many cardinality explicitly.
  const fieldLinkCols = ["field_id", "entry_source_path", "field_name", "schema_node_id", "inspect_path"];
  const fieldLinks = database.prepare(`
    SELECT v.field_id, e.source_path AS entry_source_path, f.name AS field_name, v.schema_node_id, sn.path AS inspect_path
    FROM cliref_field_inspect_links v
    JOIN cliref_fields f ON f.id = v.field_id
    JOIN cliref_entries e ON e.id = f.entry_id
    JOIN schema_nodes sn ON sn.id = v.schema_node_id
    ORDER BY v.field_id, sn.path`).all() as Array<Record<string, TsvScalar>>;
  const fieldLinksDs: Dataset = {
    name: "cli-reference/field-inspect-links.tsv",
    source_table: "cliref_field_inspect_links",
    columns: fieldLinkCols,
    order_by: "field_id, inspect_path",
    rows: fieldLinks.map((r) => fieldLinkCols.map((c) => r[c])),
  };

  return [pagesDs, entriesDs, fieldsDs, flagsDs, entryLinksDs, fieldLinksDs];
}

/** Byte-exact source/<slug>.md files, reconstructed from cliref_pages.source_markdown. */
function cliRefSourceFiles(database: Database): Array<{ name: string; content: string; bytes: number; sha256: string }> {
  if (!hasCliRef(database)) return [];
  const pages = database.prepare("SELECT slug, source_markdown, source_sha256 FROM cliref_pages ORDER BY source_order").all() as Array<{ slug: string; source_markdown: string; source_sha256: string }>;
  return pages.map((p) => ({
    // Slugs are lowercase [a-z0-9-] segments joined by "/", so they are filesystem-safe
    // as a relative path; containedTarget() still guards traversal defensively.
    name: `cli-reference/source/${p.slug}.md`,
    content: p.source_markdown,
    bytes: utf8Bytes(p.source_markdown),
    sha256: p.source_sha256,
  }));
}

function readMeta(database: Database, key: string): string | null {
  try {
    const row = database.prepare("SELECT value FROM db_meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  } catch (e) {
    // Tolerate only a genuinely absent db_meta table (a pre-v5 or non-rosetta DB);
    // let corruption, locking, and other real failures surface rather than
    // silently reporting "(unstamped)" — a missing key already returns null above.
    if (e instanceof Error && /no such table/i.test(e.message)) return null;
    throw e;
  }
}

// ── The command ───────────────────────────────────────────────────────────────

export type ExportedFile = { name: string; source_table: string; rows: number; columns: string[]; order_by: string };
export type ExportedSourceFile = { name: string; bytes: number; sha256: string };
export type ExportSummary = { outDir: string; files: ExportedFile[]; sourceFiles: ExportedSourceFile[] };

export type ExportOptions = {
  /** Overwrite a non-empty directory that carries no rosetta manifest.toml. */
  force?: boolean;
  /**
   * Consulted only for a non-empty directory with no rosetta manifest, and only
   * when `force` is not set — return true to overwrite it anyway (e.g. an
   * interactive TTY confirmation). Omitted → such a directory is refused. Kept as
   * a callback so this module stays free of stdin/prompt coupling and testable.
   */
  confirmForeign?: (resolved: string) => boolean | Promise<boolean>;
};

const MANIFEST_NAME = "manifest.toml";
const EXPORT_FORMAT = "rosetta-datasets";

/**
 * The file list a prior `rosetta export` recorded in its manifest — the ownership
 * record that makes prune-then-publish safe: this run only ever deletes files a
 * manifest WE wrote listed, never anything else in the directory. Returns:
 *   - `{ owned }`  the dir holds our manifest; adopt it and prune its stale files
 *   - `"foreign"`  a manifest.toml exists but is not ours (no rosetta format marker)
 *   - `null`       no manifest.toml at all
 * In our generated manifest, `name = "..."` occurs only inside `[[files]]` blocks,
 * and `[[files]].name` is a directory-relative path (POSIX `/`), so a variable
 * file set (E3/E4's `products/**`, `pages/<slug>/**`) is owned and pruned the same
 * way as today's flat set — the manifest shape already supports directory files.
 */
function priorManifest(resolved: string): { owned: string[] } | "foreign" | null {
  const manifestPath = path.join(resolved, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return null;
  const text = readFileSync(manifestPath, "utf-8");
  if (!new RegExp(`^format = "${EXPORT_FORMAT}"$`, "m").test(text)) return "foreign";
  return { owned: [...text.matchAll(/^name = "(.+)"$/gm)].map((m) => m[1]) };
}

/**
 * Resolve `relFile` under the export root to the absolute path to write/delete, or
 * null if it escapes the root — lexically OR through a symlink. The lexical prefix
 * check alone can't stop a symlinked component (`root/pages -> /outside`, so that
 * touching `root/pages/x` acts on `/outside/x`); comparing the realpath of the
 * deepest existing ancestor against the realpath of the root closes that hole. So
 * neither a dataset write nor a stale-file prune can ever act outside the directory
 * the export owns, even from a tampered manifest or a planted symlink.
 */
function containedTarget(root: string, relFile: string): string | null {
  const target = path.resolve(root, relFile);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  let existing = target;
  while (!existsSync(existing)) existing = path.dirname(existing);
  const realRoot = realpathSync(root);
  const realExisting = realpathSync(existing);
  if (realExisting !== realRoot && !realExisting.startsWith(realRoot + path.sep)) return null;
  return target;
}

/**
 * After pruning an owned file, remove the directories it left empty — up to but
 * never including the export root, and stopping at the first non-empty dir. So
 * dropping the last file under `pages/<slug>/` cleans that dir, while a dir the
 * user themselves populated (or the root) is never touched.
 */
function removeEmptyAncestors(root: string, relFile: string): void {
  let dir = path.dirname(path.join(root, relFile));
  while (dir !== root && dir.startsWith(root + path.sep)) {
    try {
      if (readdirSync(dir).length > 0) break;
      rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
}

// Reading order = directory/manifest order. Deterministic.
const DATASET_READERS = [
  readChangelog,
  readCallouts,
  readProperties,
  readVideos,
  readCommands,
  readPages,
  readSections,
  readTables,
];

// Honest disclosures — what the DB cannot say, so a reader does not mistake an
// omission for an absence. Kept next to the code so it stays in sync with reality.
const DISCLOSURES = [
  {
    subject: "callouts.section_id / properties.section_id",
    note: "NULL marks a row with no resolvable section, not a missing value; the columns were added in schema v9 (issue #90). Pre-first-heading content now resolves to the synthetic lead fragment (anchor '_lead', B-0023) whenever that content exists, so current re-extractions should rarely produce NULL here. Distinguished from the empty string by the \\N token.",
  },
  {
    subject: "videos transcript provenance",
    note: "Whether a transcript is YouTube-automatic or author-provided is not retained (issue #21), so no provenance column is emitted; transcript_word_count/transcript_bytes count whatever text is stored.",
  },
  {
    subject: "commands per-version architecture",
    note: "No per-version path counts are emitted: command_versions is architecture-blind and dual-arch versions are last-writer-wins between x86 and arm64 (issue #91). commands.ros_version is the single stored value only.",
  },
  {
    subject: "sections.tsv vs pages.tsv word counts",
    note: "sections.tsv pivots up to nearly, not exactly, the pages.tsv word_count: section bodies (incl. the '_lead' fragment, B-0023) cover ~98% of page words, and the residual is heading-text lines, which belong to no fragment. pages.tsv.word_count is the authoritative whole-page count; a per-page sum over sections.tsv is the covered-body count, and the difference is that residual — not a drop.",
  },
  {
    subject: "tables.tsv table_url granularity + raw_bytes + is_property_source",
    note: "table_url deep-links to the section that contains the table (url#anchor), not the table itself — manual.mikrotik.com (Docusaurus) exposes no per-table anchor. A table with no resolvable section (section_id NULL) links to the bare page URL; a page with no URL yields NULL. raw_bytes is the UTF-8 size of the stored source Markdown (raw_markdown), not rendered output. is_property_source is 1 if and only if a properties row's source_table_row_id (the data routeros_lookup_property surfaces) resolves back to this table — i.e. extraction actually produced properties from it, NOT that the table merely looks property-shaped; a property-headed table the extractor gates skipped (issue #100) is honestly 0. The table's cell data is not exported here — this is the inventory list; the per-fragment cell files are E4 (issue #104).",
  },
];

// CLI-Reference-specific disclosures (issue #124), appended only when the overlay
// is present in the DB.
const CLIREF_DISCLOSURES = [
  {
    subject: "cli-reference field-inspect-links (the field view)",
    note: "field-inspect-links.tsv is derived by name from the stored entry crosswalk (cliref_field_inspect_links view), never stored — so it always reflects the current schema_nodes snapshot. A settable Argument matches inspect arg nodes by NAME under its entry's command subtree, so it can be zero-to-many; Read-only Argument rows are intentionally excluded because a same-name inspect arg describes input, not proof of an output field. inspect_link_count in fields.tsv is the row count of this view for that field.",
  },
  {
    subject: "cli-reference entry match_kind (exact / alias / manual-only)",
    note: "An entry with no entry-inspect-links row is manual-only: the CLI Reference documents a command CHR /console/inspect cannot self-report (build-flag or hardware-gated menu), NOT an extraction gap. An 'alias' link means the manual leaked an internal module segment into the heading path (match_detail names the dropped segment, e.g. caps-man/acl/access-list → /caps-man/access-list); the source_path is never rewritten. Ambiguous single-segment drops stay manual-only rather than guessing.",
  },
  {
    subject: "cli-reference source fidelity and raw_type",
    note: "source/<slug>.md is the byte-exact fetched Markdown (hashes to pages.tsv.source_sha256); entry/field/flag description_markdown columns are verbatim (no whitespace flattening). raw_type is stored unparsed — enums (enum (a | b)), ranges (num { 0..7 }), and composites are a deferred pass. The CLI-Reference section-landing argument-type glossary (/docs/cli-reference/) is not ingested here (prose, no command entries).",
  },
];

/**
 * Write the dataset directory. Reads only `database`.
 *
 * Safe replacement (issue #108) is manifest-owned prune-then-publish: the manifest
 * is both the index and the ownership record. A run adopts a directory that already
 * holds a manifest WE wrote (and prunes the files that manifest listed but this run
 * no longer produces — the stale-slug hazard that E3/E4's variable `products/**` /
 * `pages/<slug>/**` sets introduce); writes freely into a new or empty directory;
 * and refuses a non-empty directory with no rosetta manifest unless `force` (or
 * `confirmForeign`) says otherwise — so it can never delete or clobber a directory
 * it did not create. Datasets are written first and manifest.toml LAST, so a crash
 * never leaves a manifest naming half-written data; a crashed run (no manifest) is
 * treated as foreign and needs `--force` to resume, which the next run then heals.
 */
export async function runExport(outDir: string, database: Database, opts: ExportOptions = {}): Promise<ExportSummary> {
  const resolved = path.resolve(outDir);
  if (existsSync(resolved) && !statSync(resolved).isDirectory()) {
    throw new Error(`export: ${resolved} exists and is not a directory`);
  }

  // Ownership gate. Adopt our own prior export (and remember its owned set to prune
  // below); write into a new/empty dir; refuse a non-empty foreign dir unless forced.
  const prior = existsSync(resolved) ? priorManifest(resolved) : null;
  let ownedBefore: string[] = [];
  if (prior && prior !== "foreign") {
    ownedBefore = prior.owned;
  } else if (existsSync(resolved) && readdirSync(resolved).length > 0) {
    const ok = opts.force === true || (opts.confirmForeign ? await opts.confirmForeign(resolved) : false);
    if (!ok) {
      throw new Error(
        `export: ${resolved} is not empty and has no rosetta ${MANIFEST_NAME} — refusing to overwrite a directory this tool did not create. Pass --force to overwrite it.`,
      );
    }
  }

  // Create the target directory explicitly (the typical `rosetta export <dir>`
  // expectation), rather than leaning on Bun.write's implicit parent creation.
  mkdirSync(resolved, { recursive: true });

  const datasets = [...DATASET_READERS.map((read) => read(database)), ...readCliRefDatasets(database)];
  const rawFiles = cliRefSourceFiles(database);

  const manifest = emitToml({
    header: [
      "manifest.toml — generated by `rosetta export`. Do not edit by hand.",
      "Provenance + serialization contract for a rosetta dataset directory (B-0022 / issue #101).",
      "Every value here is derived from the SQLite DB alone, so a rebuild on the same DB is a no-op.",
    ],
    root: { format: "rosetta-datasets", format_version: 1, generator: "@tikoci/rosetta" },
    provenance: {
      // From db_meta — the whole point is a directory whose origin is knowable.
      // schema_version falls back to PRAGMA user_version so a fixture without the
      // stamped key still gets a real number rather than a hole.
      release_tag: readMeta(database, "release_tag") ?? "(unstamped)",
      schema_version: readMeta(database, "schema_version") ?? String((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version),
      source_commit: readMeta(database, "source_commit") ?? "(unstamped)",
      built_at: readMeta(database, "built_at") ?? "(unstamped)",
    },
    contract: {
      file_format: "tsv",
      encoding: "utf-8",
      line_ending: "lf",
      column_separator: "tab",
      null: TSV_NULL,
      escape: TSV_ESCAPE,
      word_count: WORD_COUNT_RULE,
      byte_count: "UTF-8 byte length of the stored text (Buffer.byteLength(text, 'utf8')).",
      filesystem_name: "Percent-encode any byte outside [A-Za-z0-9._-]; raw value stays in a column and the encoded name is emitted as its own column.",
    },
    files: [
      ...datasets.map((d) => ({ name: d.name, source_table: d.source_table, rows: d.rows.length, columns: d.columns, order_by: d.order_by })),
      ...rawFiles.map((f) => ({ name: f.name, source_table: "cliref_pages", bytes: f.bytes, sha256: f.sha256 })),
    ],
    disclosures: [...DISCLOSURES, ...(rawFiles.length > 0 ? CLIREF_DISCLOSURES : [])],
  });

  // Publish in three ordered steps: (1) prune the PRIOR manifest's stale files,
  // (2) write datasets, (3) write manifest.toml LAST.
  //
  // Prune BEFORE the writes so a file↔directory transition works: an old flat file
  // `pages` must be gone before a new `pages/<slug>/x.tsv` can be created (and the
  // inverse). Pruning before the new manifest also keeps a crash safe — the manifest
  // still lands last (never naming half-written data), and a run that dies mid-publish
  // leaves the OLD manifest on disk carrying the full owned set, so the next run
  // re-prunes rather than orphaning stale files. (A crash can still leave individual
  // dataset files a mix of the prior and current run; the directory is a regenerable
  // audit surface healed by the next successful export, not a transactional store.)
  const produced = new Set([...datasets.map((d) => d.name), ...rawFiles.map((f) => f.name)]);
  for (const stale of ownedBefore) {
    if (produced.has(stale) || stale === MANIFEST_NAME) continue;
    const target = containedTarget(resolved, stale); // lexical + symlink containment
    if (target === null) continue; // a traversal/symlink name can never delete outside the root
    rmSync(target, { force: true });
    removeEmptyAncestors(resolved, stale);
  }
  for (const d of datasets) {
    const target = containedTarget(resolved, d.name);
    if (target === null) throw new Error(`export: refusing to write ${d.name} — it resolves outside ${resolved} (traversal or symlink)`);
    await Bun.write(target, toTsv(d.columns, d.rows));
  }
  for (const f of rawFiles) {
    const target = containedTarget(resolved, f.name);
    if (target === null) throw new Error(`export: refusing to write ${f.name} — it resolves outside ${resolved} (traversal or symlink)`);
    await Bun.write(target, f.content);
  }
  await Bun.write(path.join(resolved, MANIFEST_NAME), manifest);

  return {
    outDir: resolved,
    files: datasets.map((d) => ({ name: d.name, source_table: d.source_table, rows: d.rows.length, columns: d.columns, order_by: d.order_by })),
    sourceFiles: rawFiles.map((f) => ({ name: f.name, bytes: f.bytes, sha256: f.sha256 })),
  };
}
