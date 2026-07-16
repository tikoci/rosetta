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
import { parsePage } from "../extract-docusaurus.ts";

const one = <T>(sql: string): T => Object.values(db.prepare(sql).get() as object)[0] as T;
const rows = <T>(sql: string): T[] => db.prepare(sql).all() as T[];

const hasTable = (name: string): boolean =>
  one<number>(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = '${name}'`) > 0;
const hasColumn = (table: string, column: string): boolean =>
  rows<{ name: string }>(`PRAGMA table_info(${table})`).some((entry) => entry.name === column);

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
  for (const p of rows<{ text: string; url: string }>("SELECT text, url FROM pages")) {
    parsed += parsePage(p.text, p.url).properties.length;
  }
  const stored = one<number>("SELECT COUNT(*) FROM properties");
  console.log(`  parsed ${parsed} / stored ${stored} → LOST ${parsed - stored}`);

  if (hasColumn("properties", "section_id")) {
    const attributed = one<number>("SELECT COUNT(*) FROM properties WHERE section_id IS NOT NULL");
    console.log(`  ${String(attributed).padStart(5)}  properties with section_id; ${stored - attributed} honestly page-level`);
  }
  if (hasColumn("properties", "source_table_row_id")) {
    const tableDerived = one<number>("SELECT COUNT(*) FROM properties WHERE source_table_row_id IS NOT NULL");
    console.log(`  ${String(tableDerived).padStart(5)}  table-derived property rows linked to exact source rows`);
    console.log(`  ${String(stored - tableDerived).padStart(5)}  bullet/historical property rows (unlinked by design)`);
  }

  const callouts = one<number>("SELECT COUNT(*) FROM callouts");
  const attributedCallouts = hasColumn("callouts", "section_id")
    ? one<number>("SELECT COUNT(*) FROM callouts WHERE section_id IS NOT NULL")
    : 0;
  console.log(`  ${String(attributedCallouts).padStart(5)} / ${callouts} callouts with section_id`);
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
  console.log("\n── #92 tables: generic structural retention ──");
  let pipe = 0;
  let ragged = 0;
  let headerClassifierMatches = 0;
  let tablesProducingProperties = 0;
  let tableDerivedProperties = 0;
  let bulletDerivedProperties = 0;
  let dataRows = 0;
  let cells = 0;
  let cellsWithPipe = 0;
  let cellsWithTab = 0;
  let html = 0;
  const perFragment = new Map<string, number>();

  for (const p of rows<{ slug: string; text: string; url: string }>("SELECT slug, text, url FROM pages")) {
    html += (p.text.match(/<table[\s>]/gi) ?? []).length;
    const page = parsePage(p.text, p.url);
    const tableOrderByRowLine = new Map<number, number>();
    for (const table of page.tables) {
      pipe++;
      if (/\b(property|properties|parameter|parameters)\b/i.test(table.header.cells[0] ?? "")) {
        headerClassifierMatches++;
      }
      const key = `${p.slug}#${table.sourceHeading ?? "(page)"}`;
      perFragment.set(key, (perFragment.get(key) ?? 0) + 1);
      if (table.isRagged) ragged++;
      cells += table.header.cells.length;
      for (const cell of table.header.cells) {
        if (cell.includes("|")) cellsWithPipe++;
        if (cell.includes("\t")) cellsWithTab++;
      }
      for (const row of table.rows) {
        tableOrderByRowLine.set(row.line, table.sortOrder);
        dataRows++;
        cells += row.cells.length;
        for (const cell of row.cells) {
          if (cell.includes("|")) cellsWithPipe++;
          if (cell.includes("\t")) cellsWithTab++;
        }
      }
    }

    const propertyTableOrders = new Set<number>();
    for (const property of page.properties) {
      if (property.sourceTableRowLine === null) {
        bulletDerivedProperties++;
      } else {
        tableDerivedProperties++;
        const order = tableOrderByRowLine.get(property.sourceTableRowLine);
        if (order !== undefined) propertyTableOrders.add(order);
      }
    }
    tablesProducingProperties += propertyTableOrders.size;
  }

  console.log(`  ${String(pipe).padStart(5)}  pipe tables (${dataRows} data rows)`);
  console.log(`  ${String(headerClassifierMatches).padStart(5)}  broad first-header property/parameter classifier matches`);
  console.log(`  ${String(tablesProducingProperties).padStart(5)}  tables that actually produce property rows`);
  console.log(`  ${String(tableDerivedProperties).padStart(5)}  table-derived property rows`);
  console.log(`  ${String(bulletDerivedProperties).padStart(5)}  bullet-derived property rows`);
  console.log(`  ${String(ragged).padStart(5)}  genuinely ragged`);
  console.log(`  ${String(html).padStart(5)}  HTML <table> elements`);
  console.log(`  ${String([...perFragment.values()].filter((v) => v > 1).length).padStart(5)}  fragments with >1 table (of ${perFragment.size})`);
  console.log(`  ${String(cellsWithPipe).padStart(5)}  cells with a literal | → naive split("|") corrupts these`);
  console.log(`  ${String(cellsWithTab).padStart(5)}  cells with a TAB → TSV safety`);

  if (hasTable("page_tables")) {
    const storedTables = one<number>("SELECT COUNT(*) FROM page_tables");
    const storedRows = one<number>("SELECT COUNT(*) FROM page_table_rows");
    const storedCells = one<number>("SELECT COUNT(*) FROM page_table_cells");
    console.log(`  stored: ${storedTables} tables / ${storedRows} rows incl. headers / ${storedCells} cells`);
    console.log(`  parsed: ${pipe} tables / ${pipe + dataRows} rows incl. headers / ${cells} cells`);
  } else {
    console.log("  stored: schema predates generic page_tables (#92 not landed in this DB)");
  }

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
