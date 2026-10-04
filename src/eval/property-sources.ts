#!/usr/bin/env bun

/**
 * Property-description sources census — the evidence behind B-0025.
 *
 * NOT a CI gate and NOT a source of truth. MikroTik is moving property tables out of manual
 * pages and into the CLI Reference (#169). `lookupProperty` answers from the manual first and
 * falls back to the CLI-Reference overlay only when the manual has nothing better than `low`.
 * This measures what that ordering actually returns, so the store-of-record question in B-0025
 * is argued from counts rather than examples:
 *
 * 1. **How much of the overlay is described?** A CLI-Reference field always proves the argument
 *    exists at an exact menu, but its `description_markdown` is often empty.
 * 2. **Who answers today?** For every settable field at an exact menu, the top `lookupProperty`
 *    row's source and tier, split by whether the overlay row has a description.
 * 3. **Which manual answers would a reorder replace?** Manual rows below `high` that win over an
 *    exact overlay row — the class behind `/ip/firewall/filter chain` → "Bridge firewall chain".
 *
 * Ground against a CI-BUILT artifact, not a local rebuild; `db_meta` is printed first so the
 * corpus under test is never ambiguous. See `.github/instructions/local-db-grounding.instructions.md`.
 *
 * Usage:
 *   DB_PATH=/path/to/verified-release.db bun run src/eval/property-sources.ts
 */

import { db } from "../db.ts";
import { lookupProperty } from "../query.ts";

const rows = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const say = (s = "") => console.log(s);

const meta = new Map(rows<{ key: string; value: string }>("SELECT key, value FROM db_meta").map((r) => [r.key, r.value]));
say("# Property-description sources census (B-0025)\n");
say(
  `Corpus: **${meta.get("release_tag") ?? "?"}** (schema ${meta.get("schema_version") ?? "?"}, ` +
    `\`source_commit\` \`${(meta.get("source_commit") ?? "?").slice(0, 7)}\`, built ${meta.get("built_at") ?? "?"}).\n`,
);

// ── 1. overlay description coverage ─────────────────────────────────────────
say("## 1. CLI-Reference fields with a description\n");
say("| field_kind | fields | described |");
say("|---|---:|---:|");
for (const r of rows<{ kind: string; n: number; described: number }>(
  `SELECT field_kind kind, COUNT(*) n, SUM(trim(description_markdown) <> '') described
   FROM cliref_fields GROUP BY field_kind ORDER BY field_kind`,
)) {
  say(`| ${r.kind} | ${r.n} | ${r.described} (${pct(r.described, r.n)}) |`);
}
say("\nSettable fields by top-level menu (≥100 fields):\n");
say("| menu | fields | described |");
say("|---|---:|---:|");
for (const r of rows<{ top: string; n: number; described: number }>(
  `SELECT substr(e.source_path, 1, instr(e.source_path || '/', '/') - 1) top,
          COUNT(*) n, SUM(trim(f.description_markdown) <> '') described
   FROM cliref_fields f JOIN cliref_entries e ON e.id = f.entry_id
   WHERE f.field_kind = 'Argument'
   GROUP BY top HAVING n >= 100 ORDER BY n DESC`,
)) {
  say(`| /${r.top} | ${r.n} | ${pct(r.described, r.n)} |`);
}

// ── 2. who answers today ────────────────────────────────────────────────────
// Command entries are named operations (`tool/fetch`), reached by explainCommand at path/verb,
// not by a menu-scoped lookupProperty — so only Directory/Settings Directory menus are counted.
const pairs = rows<{ path: string; name: string; described: number }>(
  `SELECT '/' || e.source_path path, f.name, MAX(trim(f.description_markdown) <> '') described
   FROM cliref_fields f JOIN cliref_entries e ON e.id = f.entry_id
   WHERE f.field_kind = 'Argument' AND e.source_type <> 'Command'
   GROUP BY e.source_path, f.name`,
);
const tally = new Map<string, { described: number; blank: number }>();
const reorderSamples: string[] = [];
for (const p of pairs) {
  const top = lookupProperty(p.name, p.path)[0];
  const key = top ? `${top.source} / ${top.confidence}` : "none";
  const t = tally.get(key) ?? { described: 0, blank: 0 };
  if (p.described) t.described++;
  else t.blank++;
  tally.set(key, t);
  if (top?.source === "manual" && top.confidence !== "high" && p.described && reorderSamples.length < 12) {
    reorderSamples.push(`${p.path} \`${p.name}\` → ${top.page_title}`);
  }
}
say(`\n## 2. Top answer for ${pairs.length} settable (menu, field) pairs with an exact overlay row\n`);
say("| top row | overlay row described | overlay row blank |");
say("|---|---:|---:|");
for (const [key, t] of [...tally].sort()) say(`| ${key} | ${t.described} | ${t.blank} |`);

// ── 3. what a reorder would replace ─────────────────────────────────────────
say("\n## 3. Manual rows below `high` that win over a described exact overlay row (sample)\n");
for (const s of reorderSamples) say(`- ${s}`);
