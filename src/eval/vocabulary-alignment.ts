#!/usr/bin/env bun

/**
 * Vocabulary alignment census — the evidence behind B-0024 step 6.
 *
 * NOT a CI gate and NOT a source of truth. B-0024 steps 3–5 measured whether a property row can
 * be joined to the *menu* it documents. This measures the other half of the same join: whether
 * `properties` and the inspect command tree even share a **name** vocabulary, in both directions.
 *
 * The question matters for sequencing. A perfect menu join still cannot align prose with schema
 * if the two stores disagree about what an attribute is called — or about which attributes exist
 * at all. So this asks:
 *
 * 1. **Prose → schema.** Of the property rows inspect has never heard of, *why* hasn't it? The
 *    CLI-Reference overlay is the referee, because it is the only store that distinguishes a
 *    settable `Argument` from a `Read-only Argument` and is version-less rather than a single
 *    device's dump.
 * 2. **Schema → prose.** How many inspect argument names have no prose description anywhere?
 *    That is #61's "known, undocumented" population, which had never been counted.
 * 3. **The naming model.** inspect uses dotted names (`channel.frequency`); the manual does not.
 *    Is that absence, or the same attribute under a different key?
 *
 * Ground against a CI-BUILT artifact, not a local rebuild (`make db-sync`); `db_meta` is printed
 * first so the corpus under test is never ambiguous. See #94 and
 * `.github/instructions/local-db-grounding.instructions.md`.
 *
 * Usage:
 *   DB_PATH=~/.rosetta/ros-help.db bun run src/eval/vocabulary-alignment.ts
 */

import { db } from "../db.ts";

const rows = <T>(sql: string, ...args: unknown[]): T[] => db.prepare(sql).all(...(args as never[])) as T[];
const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).get(...(args as never[])) as T;
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const say = (s = "") => console.log(s);

// ── provenance ──────────────────────────────────────────────────────────────
const meta = new Map(rows<{ key: string; value: string }>("SELECT key, value FROM db_meta").map((r) => [r.key, r.value]));
say("# Vocabulary alignment census (B-0024 step 6)\n");
say(
  `Corpus: **${meta.get("release_tag") ?? "?"}** (schema ${meta.get("schema_version") ?? "?"}, ` +
    `\`source_commit\` \`${(meta.get("source_commit") ?? "?").slice(0, 7)}\`, built ${meta.get("built_at") ?? "?"}).`,
);

// The two vocabularies. inspect `arg` rows are *settable* arguments of a command; that is the
// whole reason a read-only field can be real and still absent here.
const ARG_NAMES = "SELECT DISTINCT lower(name) n FROM commands WHERE type = 'arg'";
const PROP_NAMES = "SELECT DISTINCT lower(name) n FROM properties";
/** Every distinct field name the overlay knows, with the kinds it appears as. */
const CLIREF_KINDS = "SELECT lower(name) n, group_concat(DISTINCT field_kind) k FROM cliref_fields GROUP BY lower(name)";

// ── 1. prose → schema ───────────────────────────────────────────────────────
say("\n## 1. Prose rows the inspect command tree has never heard of\n");

const totals = one<{ prop_rows: number; prop_names: number; arg_names: number }>(
  `SELECT (SELECT count(*) FROM properties) prop_rows,
          (SELECT count(*) FROM (${PROP_NAMES})) prop_names,
          (SELECT count(*) FROM (${ARG_NAMES})) arg_names`,
);
const unknown = one<{ unknown_rows: number; unknown_names: number }>(
  `SELECT (SELECT count(*) FROM properties WHERE lower(name) NOT IN (${ARG_NAMES})) unknown_rows,
          (SELECT count(*) FROM (${PROP_NAMES}) WHERE n NOT IN (${ARG_NAMES})) unknown_names`,
);
say(
  `${totals.prop_rows} property rows carry ${totals.prop_names} distinct names; the tree knows ` +
    `${totals.arg_names} argument names. **${unknown.unknown_rows} rows (${pct(unknown.unknown_rows, totals.prop_rows)})** ` +
    `across ${unknown.unknown_names} names have no counterpart there.`,
);

// The referee: a row absent from inspect but present in the overlay is a real field inspect
// cannot see, and the overlay says *why* — read-only, or simply not on the device that was dumped.
const buckets = rows<{ bucket: string; rows: number }>(
  `WITH unk AS (SELECT lower(name) n FROM properties WHERE lower(name) NOT IN (${ARG_NAMES})),
        kinds AS (${CLIREF_KINDS})
   SELECT CASE
            WHEN k IS NULL THEN 'unknown to the overlay too'
            WHEN k = 'Read-only Argument' THEN 'overlay: read-only only'
            WHEN k = 'Argument' THEN 'overlay: settable only'
            ELSE 'overlay: both kinds'
          END bucket, count(*) rows
   FROM unk LEFT JOIN kinds ON kinds.n = unk.n GROUP BY bucket ORDER BY rows DESC`,
);
say("\n| Why the tree cannot see it | Rows | Share of the gap |");
say("|---|---:|---:|");
for (const b of buckets) say(`| ${b.bucket} | ${b.rows} | ${pct(b.rows, unknown.unknown_rows)} |`);
say(
  "\n`read-only only` is a **kind** mismatch, not a naming one: inspect `arg` rows are settable " +
    "arguments, so a documented output column can never appear there. `settable only` is a " +
    "**coverage** mismatch: the field is settable somewhere, just not on the device this tree was " +
    "dumped from.",
);

// Page attribution, because the two mismatches cluster on visibly different pages.
say("\n### Where the gap lives\n");
const byPage = rows<{ title: string; absent: number; read_only: number; settable: number; total: number }>(
  `WITH unk AS (SELECT page_id, lower(name) n FROM properties WHERE lower(name) NOT IN (${ARG_NAMES})),
        kinds AS (${CLIREF_KINDS})
   SELECT pg.title,
     sum(CASE WHEN k IS NULL THEN 1 ELSE 0 END) absent,
     sum(CASE WHEN k = 'Read-only Argument' THEN 1 ELSE 0 END) read_only,
     sum(CASE WHEN k LIKE '%Argument%' AND k <> 'Read-only Argument' THEN 1 ELSE 0 END) settable,
     count(*) total
   FROM unk JOIN pages pg ON pg.id = unk.page_id LEFT JOIN kinds ON kinds.n = unk.n
   GROUP BY pg.id ORDER BY total DESC LIMIT 12`,
);
say("| Page | Unknown to overlay | Read-only | Settable | Total |");
say("|---|---:|---:|---:|---:|");
for (const p of byPage) say(`| ${p.title} | ${p.absent} | ${p.read_only} | ${p.settable} | ${p.total} |`);

// The starkest single case: a whole menu the tree does not contain.
const poe = one<{ c: number }>("SELECT count(*) c FROM commands WHERE path LIKE '/interface/ethernet/poe%'");
say(
  `\n\`/interface/ethernet/poe\` has **${poe.c}** rows in \`commands\` — the PoE-Out property rows have no ` +
    "menu to join to at all, at any granularity. No ranking or proximity work reaches them.",
);

// ── 2. schema → prose ───────────────────────────────────────────────────────
say("\n## 2. Argument names with no prose anywhere — the “known, undocumented” population\n");
const reverse = one<{ args: number; documented: number; undocumented: number }>(
  `SELECT (SELECT count(*) FROM (${ARG_NAMES})) args,
          (SELECT count(*) FROM (${ARG_NAMES}) WHERE n IN (${PROP_NAMES})) documented,
          (SELECT count(*) FROM (${ARG_NAMES}) WHERE n NOT IN (${PROP_NAMES})) undocumented`,
);
say(
  `Of ${reverse.args} distinct argument names, ${reverse.documented} (${pct(reverse.documented, reverse.args)}) have a ` +
    `property row *somewhere* with that name and **${reverse.undocumented} (${pct(reverse.undocumented, reverse.args)}) ` +
    `have none anywhere in the corpus**.`,
);
say(
  "\nThis is a *name-level* upper bound on how much prose could ever be attached, and it is deliberately " +
    "generous: it counts a name as documented if any page uses it, regardless of menu. The menu-aligned " +
    "figure can only be worse — see B-0024 step 3.",
);

// ── 3. the naming model ─────────────────────────────────────────────────────
say("\n## 3. Dotted names — a different key, not missing content\n");
const dotted = one<{ dotted: number; full_name: number; leaf_name: number }>(
  `WITH d AS (SELECT DISTINCT lower(name) n, lower(substr(name, instr(name, '.') + 1)) leaf
              FROM commands WHERE type = 'arg' AND name LIKE '%.%')
   SELECT count(*) dotted,
          sum(CASE WHEN n IN (${PROP_NAMES}) THEN 1 ELSE 0 END) full_name,
          sum(CASE WHEN leaf IN (${PROP_NAMES}) THEN 1 ELSE 0 END) leaf_name
   FROM d`,
);
const leafExplains = one<{ rows: number }>(
  `WITH leaves AS (SELECT DISTINCT lower(substr(name, instr(name, '.') + 1)) n
                   FROM commands WHERE type = 'arg' AND name LIKE '%.%')
   SELECT count(*) rows FROM properties
   WHERE lower(name) NOT IN (${ARG_NAMES}) AND lower(name) IN (SELECT n FROM leaves)`,
);
const clirefDotted = one<{ cliref: number; shared: number }>(
  `WITH cd AS (SELECT DISTINCT lower(name) n FROM cliref_fields WHERE name LIKE '%.%'),
        id AS (SELECT DISTINCT lower(name) n FROM commands WHERE type = 'arg' AND name LIKE '%.%')
   SELECT (SELECT count(*) FROM cd) cliref, (SELECT count(*) FROM cd WHERE n IN (SELECT n FROM id)) shared`,
);
say(
  `${dotted.dotted} argument names are dotted. **${dotted.full_name}** are documented under the full dotted name; ` +
    `**${dotted.leaf_name}** are documented under the bare leaf (\`channel.frequency\` → \`frequency\`).`,
);
say(
  `\nBut the dotted model explains only **${leafExplains.rows}** of the ${unknown.unknown_rows} unmatched rows above: ` +
    "those leaves are mostly *also* plain arguments at some other menu, so they read as `known` already. " +
    "The dotted mismatch therefore produces **ambiguity** — one prose row standing in for several distinct " +
    "attributes — rather than absence. It is a real defect (#61 BL-3) and a small one by row count.",
);
say(
  `\nThe overlay is a third vocabulary and agrees with neither cleanly: ${clirefDotted.cliref} of its field names are ` +
    `dotted, of which ${clirefDotted.shared} match a dotted argument name.`,
);
