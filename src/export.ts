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
import { existsSync, mkdirSync, statSync } from "node:fs";
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
  const columns = ["version", "released", "category", "is_breaking", "description", "sort_order"];
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

/** callouts.tsv — direct from `callouts`; section_id is NULL for page-level callouts. */
function readCallouts(database: Database): Dataset {
  const columns = ["page_id", "section_id", "type", "content", "sort_order"];
  const rows = database
    .prepare(`SELECT ${columns.join(", ")} FROM callouts ORDER BY ${ORDER_PAGE_FRAGMENT}`)
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
 * pages.tsv — the flat, un-rolled-up view: one row per `sections` fragment, keyed to
 * its page, carrying the fragment's sizing (word count, UTF-8 text/code bytes) and
 * its table counts. A spreadsheet user does their own sorting/grouping here; the
 * page-level rollup lives in pages_summary.tsv (two audiences, same core data).
 * A fragment with word_count = 0 is a self-flagging empty section (#93).
 */
function readPagesFlat(database: Database): Dataset {
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
  return { name: "pages.tsv", source_table: "sections", columns, order_by: "page_id, sections.sort_order, sections.id", rows };
}

/**
 * pages_summary.tsv — the rollup view: one row per `pages` record with the page's
 * stored word count, section/empty-section counts, UTF-8 text/code bytes, and table
 * counts. Small enough to read directly on GitHub; the granular rows are pages.tsv.
 */
function readPagesSummary(database: Database): Dataset {
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
  return { name: "pages_summary.tsv", source_table: "pages", columns, order_by: "page_id", rows };
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
export type ExportSummary = { outDir: string; files: ExportedFile[] };

// Reading order = directory/manifest order. Deterministic.
const DATASET_READERS = [
  readChangelog,
  readCallouts,
  readProperties,
  readVideos,
  readCommands,
  readPagesFlat,
  readPagesSummary,
];

// Honest disclosures — what the DB cannot say, so a reader does not mistake an
// omission for an absence. Kept next to the code so it stays in sync with reality.
const DISCLOSURES = [
  {
    subject: "callouts.section_id / properties.section_id",
    note: "NULL marks a genuinely page-level row, not a missing value; the columns were added in schema v9 (issue #90). Pre-first-heading content now resolves to the synthetic lead fragment (anchor '_lead', B-0023), so a NULL here is content with no lead fragment at all (e.g. a title-only page) — rare. Distinguished from the empty string by the \\N token.",
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
    subject: "changelog.tsv prerelease ordering",
    note: "Rows are version-ordered by the shared comparator, but it does not yet distinguish prerelease numbers (7.24beta1 vs 7.24beta2 compare equal), so same-base prereleases are ordered only by the secondary sort_order key. Deterministic, not fully version-sorted (issue #104).",
  },
];

/**
 * Write the dataset directory. Reads only `database`. Overwrites its own fixed
 * file set in place; it never deletes anything, so it can never remove a file or
 * directory it did not create. (Safe replacement of a VARIABLE file set — E4's
 * per-fragment tables, where a previous run's slugs may be stale — is deliberately
 * deferred; the fixed flat file set here has no stale-file hazard.)
 */
export async function runExport(outDir: string, database: Database): Promise<ExportSummary> {
  const resolved = path.resolve(outDir);
  if (existsSync(resolved) && !statSync(resolved).isDirectory()) {
    throw new Error(`export: ${resolved} exists and is not a directory`);
  }
  // Create the target directory explicitly (the typical `rosetta export <dir>`
  // expectation), rather than leaning on Bun.write's implicit parent creation.
  mkdirSync(resolved, { recursive: true });

  const datasets = DATASET_READERS.map((read) => read(database));

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
    files: datasets.map((d) => ({ name: d.name, source_table: d.source_table, rows: d.rows.length, columns: d.columns, order_by: d.order_by })),
    disclosures: DISCLOSURES,
  });

  // Overwrite only the files we own; nothing is deleted. Write the datasets first
  // and manifest.toml last, so a failed run can't leave a manifest that names data
  // files that were never (or only partially) written.
  for (const d of datasets) await Bun.write(path.join(resolved, d.name), toTsv(d.columns, d.rows));
  await Bun.write(path.join(resolved, "manifest.toml"), manifest);

  return { outDir: resolved, files: datasets.map((d) => ({ name: d.name, source_table: d.source_table, rows: d.rows.length, columns: d.columns, order_by: d.order_by })) };
}
