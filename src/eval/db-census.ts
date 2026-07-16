#!/usr/bin/env bun

/**
 * DB-only census — the evidence behind the B-0022 export audit (umbrella #95).
 *
 * NOT a CI gate and NOT a source of truth. It re-derives, from a runtime DB alone, the
 * measurements that produced #90–#94, so those findings can be re-checked after a fix
 * lands rather than taken on trust from a briefing. It prints intermediate numbers on
 * purpose: a census that only says "ok" is one a future agent can quietly satisfy.
 *
 * Ground against a CI-BUILT artifact, not a local rebuild. A typical repo-root
 * ros-help.db is the stale v0.10.0 Confluence corpus and will silently answer the wrong
 * question — that trap is #94, and it cost this audit a full wrong pass. `db_meta` is
 * printed first so the corpus under test is never ambiguous.
 *
 * Usage:
 *   DB_PATH=~/.rosetta/ros-help.db bun run src/eval/db-census.ts
 *   DB_PATH=<scratch>/ros-current.db bun run src/eval/db-census.ts
 */

import { db } from "../db.ts";
import { parseProperties } from "../extract-docusaurus.ts";

const one = <T>(sql: string): T => Object.values(db.prepare(sql).get() as object)[0] as T;
const rows = <T>(sql: string): T[] => db.prepare(sql).all() as T[];

/**
 * Escape-aware Markdown table row splitter.
 *
 * Mirrors extract-docusaurus.ts's private splitTableRow. RouterOS enum values embed
 * escaped pipes (`*md5 \| sha1*`) in 1,420 cells, so a naive line.split("|") misreports
 * 374 tables as ragged when the true count is 14. #92 step 1 exports the original; this
 * copy exists only so the census can run before that lands, and should be deleted then.
 */
function splitTableRow(line: string): string[] {
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
  if (cells[0] === "") cells.shift();
  if (cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function provenance(): void {
  console.log("── corpus under test ──");
  for (const m of rows<{ key: string; value: string }>("SELECT key, value FROM db_meta ORDER BY key")) {
    console.log(`  ${m.key.padEnd(32)} ${m.value}`);
  }
  const hosts = rows<{ host: string; n: number }>(`
    SELECT CASE
             WHEN url LIKE '%manual.mikrotik.com%' THEN 'Docusaurus'
             WHEN url LIKE '%help.mikrotik.com%'   THEN 'Confluence (STALE — see #94)'
             ELSE 'other' END AS host,
           COUNT(*) AS n
    FROM pages GROUP BY host`);
  for (const h of hosts) console.log(`  ${"pages".padEnd(32)} ${h.n} (${h.host})`);
}

/** #90 — properties destroyed on insert, and section resolution. */
function properties(): void {
  console.log("\n── #90 properties: data loss + section identity ──");

  let parsed = 0;
  for (const p of rows<{ text: string }>("SELECT text FROM pages")) parsed += parseProperties(p.text).length;
  const stored = one<number>("SELECT COUNT(*) FROM properties");
  console.log(`  parsed ${parsed} / stored ${stored} → LOST ${parsed - stored}`);
  console.log("    cause: UNIQUE(page_id, name, section) + INSERT OR IGNORE, section = heading TEXT");

  const join = rows<{ result: string; n: number }>(`
    WITH m AS (
      SELECT (SELECT COUNT(*) FROM sections s WHERE s.page_id = p.page_id AND s.heading = p.section) AS n
      FROM properties p WHERE p.section IS NOT NULL AND p.section <> ''
    )
    SELECT CASE WHEN n = 0 THEN 'no matching section (h4-h6: sections stop at h3)'
                WHEN n = 1 THEN 'unique match'
                ELSE 'ambiguous (anchor_id disambiguation discarded)' END AS result,
           COUNT(*) AS n
    FROM m GROUP BY result ORDER BY n DESC`);
  for (const r of join) console.log(`  ${String(r.n).padStart(5)}  ${r.result}`);

  const repeated = one<number>(
    "SELECT COUNT(*) FROM (SELECT page_id, heading FROM sections GROUP BY page_id, heading HAVING COUNT(*) > 1)",
  );
  console.log(`  ${String(repeated).padStart(5)}  page/heading pairs that repeat`);
  console.log(`  ${String(one<number>("SELECT COUNT(*) FROM callouts")).padStart(5)}  callouts, none with section attribution`);
}

/** #91 — command_versions is arch-blind. */
function commands(): void {
  console.log("\n── #91 commands: arch-blind version history ──");
  for (const t of rows<{ type: string; n: number }>("SELECT type, COUNT(*) AS n FROM commands GROUP BY type ORDER BY n DESC")) {
    console.log(`  ${String(t.n).padStart(6)}  ${t.type}`);
  }
  const dual = one<number>(
    "SELECT COUNT(*) FROM (SELECT version FROM ros_versions GROUP BY version HAVING COUNT(DISTINCT arch) > 1)",
  );
  console.log(`  ${String(dual).padStart(6)}  versions present for BOTH arches → last-writer-wins in command_versions`);
  console.log(`  ${String(one<number>("SELECT COUNT(DISTINCT version) FROM schema_node_presence")).padStart(6)}  distinct versions in schema_node_presence (release-pruned active head — by design)`);
  console.log("    note: never order versions lexically — '7.9.2' > '7.24rc1' as a string.");
}

/** #92 — generic tables, and #93 — section sizing. */
function tablesAndSizing(): void {
  console.log("\n── #92 tables: what ETL discards ──");
  let pipe = 0;
  let ragged = 0;
  let propertyLike = 0;
  let dataRows = 0;
  let cellsWithPipe = 0;
  let cellsWithTab = 0;
  let html = 0;
  const perFragment = new Map<string, number>();

  for (const p of rows<{ slug: string; text: string }>("SELECT slug, text FROM pages")) {
    html += (p.text.match(/<table[\s>]/gi) ?? []).length;
    const lines = p.text.split("\n");
    let inFence = false;
    let fragment: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const h = lines[i].match(/^#{1,6}\s+(.+)$/);
      if (h) {
        fragment = h[1].trim();
        continue;
      }
      const isTable = /^\s*\|.*\|\s*$/.test(lines[i]) && lines[i + 1] && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1]);
      if (!isTable) continue;

      const header = splitTableRow(lines[i]);
      pipe++;
      if (/\b(property|properties|parameter|parameters)\b/i.test(header[0] ?? "")) propertyLike++;
      const key = `${p.slug}#${fragment ?? "(page)"}`;
      perFragment.set(key, (perFragment.get(key) ?? 0) + 1);

      let j = i + 2;
      let isRagged = false;
      while (j < lines.length && /^\s*\|/.test(lines[j])) {
        const cells = splitTableRow(lines[j]);
        if (cells.length !== header.length) isRagged = true;
        for (const c of cells) {
          if (c.includes("|")) cellsWithPipe++;
          if (c.includes("\t")) cellsWithTab++;
        }
        dataRows++;
        j++;
      }
      if (isRagged) ragged++;
      i = j - 1;
    }
  }

  console.log(`  ${String(pipe).padStart(5)}  pipe tables (${dataRows} data rows)`);
  console.log(`  ${String(propertyLike).padStart(5)}  property-like → already extracted`);
  console.log(`  ${String(pipe - propertyLike).padStart(5)}  NON-property tables → DISCARDED by ETL today`);
  console.log(`  ${String(ragged).padStart(5)}  genuinely ragged`);
  console.log(`  ${String(html).padStart(5)}  HTML <table> elements`);
  console.log(`  ${String([...perFragment.values()].filter((v) => v > 1).length).padStart(5)}  fragments with >1 table (of ${perFragment.size})`);
  console.log(`  ${String(cellsWithPipe).padStart(5)}  cells with a literal | → naive split("|") corrupts these`);
  console.log(`  ${String(cellsWithTab).padStart(5)}  cells with a TAB → TSV safety`);

  console.log("\n── #93 sizing: retrieval units ──");
  const size = db
    .prepare(`
      SELECT (SELECT COUNT(*) FROM pages) AS pages,
             (SELECT CAST(AVG(LENGTH(CAST(text AS BLOB))) AS INT) FROM pages) AS page_avg,
             (SELECT MAX(LENGTH(CAST(text AS BLOB))) FROM pages) AS page_max,
             (SELECT COUNT(*) FROM sections) AS sections,
             (SELECT CAST(AVG(LENGTH(CAST(text AS BLOB))) AS INT) FROM sections) AS sec_avg,
             (SELECT MAX(LENGTH(CAST(text AS BLOB))) FROM sections) AS sec_max,
             (SELECT COUNT(*) FROM sections WHERE TRIM(text) = '') AS empty_sections`)
    .get() as Record<string, number>;
  console.log(`  pages    ${size.pages} — avg ${size.page_avg}B, max ${size.page_max}B`);
  console.log(`  sections ${size.sections} — avg ${size.sec_avg}B, max ${size.sec_max}B`);
  console.log(`  ${String(size.empty_sections).padStart(5)}  EMPTY sections (heading, no body)`);
}

/** TSV feasibility: tabs and newlines in columns an export would emit as cells. */
function tsvSafety(): void {
  console.log("\n── TSV safety: tabs/newlines in candidate scalar columns ──");
  const checks: Array<[string, string, string]> = [
    ["properties", "description", "tab"],
    ["properties", "name", "tab"],
    ["changelogs", "description", "tab"],
    ["callouts", "content", "tab"],
    ["video_segments", "transcript", "tab"],
    ["callouts", "content", "newline"],
  ];
  for (const [table, column, kind] of checks) {
    const ch = kind === "tab" ? 9 : 10;
    const n = one<number>(`SELECT COUNT(*) FROM ${table} WHERE ${column} LIKE '%' || char(${ch}) || '%'`);
    console.log(`  ${String(n).padStart(5)}  ${table}.${column} containing a ${kind}`);
  }
  const codeTabs = one<number>(
    "SELECT COUNT(*) FROM pages WHERE text LIKE '%' || char(9) || '%' AND code LIKE '%' || char(9) || '%'",
  );
  console.log(`  ${String(codeTabs).padStart(5)}  pages with tabs inside fenced code (legitimate — never a TSV cell)`);
}

provenance();
properties();
commands();
tablesAndSizing();
tsvSafety();
