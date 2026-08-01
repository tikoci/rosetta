#!/usr/bin/env bun

/**
 * Command↔prose join census — the evidence behind B-0024 step 3.
 *
 * NOT a CI gate and NOT a source of truth. It measures whether *fragment-grained menu-path
 * extraction* (B-0024 "Option A") is precise and fine-grained enough to be the missing
 * command→property key, or whether it is only a ranking signal. It prints intermediate
 * numbers on purpose, so the conclusion in the briefing can be re-checked after a change
 * rather than taken on trust.
 *
 * The question it answers: `properties` rows have no column naming the command they
 * document. If a property's own *section* names the menu path, that could stand in for the
 * missing key. Does it, corpus-wide?
 *
 * The oracle is the inspect command tree: an `arg` row `/interface/bridge/port/add/pvid`
 * means the menu `/interface/bridge/port` accepts `pvid`. That validates an alignment; it
 * does **not** by itself justify a `high` confidence label, because a name like `comment`
 * is accepted almost everywhere (see the "oracle strength" section).
 *
 * Ground against a CI-BUILT artifact, not a local rebuild (`make db-sync`); `db_meta` is
 * printed first so the corpus under test is never ambiguous. See #94 and
 * `.github/instructions/local-db-grounding.instructions.md`.
 *
 * Usage:
 *   DB_PATH=~/.rosetta/ros-help.db bun run src/eval/command-prose-join.ts
 *   TOP_LEVEL=1 bun run src/eval/command-prose-join.ts   # allow bare top-level menus
 */

import { db } from "../db.ts";
import { extractMenuPaths, resolveToDir } from "../menu-paths.ts";
import {
  type ArgRow,
  acceptanceMap,
  gradeRow,
  type PropertyLookupConfidence,
  supportedPaths,
  tierRank,
} from "../property-confidence.ts";

// Bare top-level menus (`/certificate`) are invisible to the linker's regex. Measuring
// with and without them is how the cost of that gap gets a number.
const ALLOW_TOP_LEVEL = process.env.TOP_LEVEL === "1";

const rows = <T>(sql: string, ...args: unknown[]): T[] =>
  db.prepare(sql).all(...(args as never[])) as T[];

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const say = (s = "") => console.log(s);

// ── provenance ──────────────────────────────────────────────────────────────
const meta = new Map(
  rows<{ key: string; value: string }>("SELECT key, value FROM db_meta").map((r) => [r.key, r.value]),
);
say("# Command↔prose join census (B-0024 step 3)\n");
say(
  `Artifact: ${meta.get("release_tag") ?? "?"} · schema ${meta.get("schema_version") ?? "?"} · ` +
    `source_commit ${(meta.get("source_commit") ?? "?").slice(0, 7)} · ` +
    `top-level menus ${ALLOW_TOP_LEVEL ? "included" : "excluded (linker default)"}`,
);

// ── extraction inputs ───────────────────────────────────────────────────────
const dirPaths = new Set(
  rows<{ path: string }>("SELECT path FROM commands WHERE type = 'dir'").map((r) => r.path),
);

/**
 * Which menus accept a given property name, keyed by lowercased name. Built by the grader's own
 * {@link acceptanceMap} so the census cannot describe rules the shipped code does not follow.
 */
const acceptsByName = acceptanceMap(
  rows<ArgRow>("SELECT name, parent_path FROM commands WHERE type = 'arg' AND parent_path IS NOT NULL"),
);
const isKnownName = (n: string) => acceptsByName.has(n.toLowerCase());
const accepts = (name: string, menu: string) => acceptsByName.get(name.toLowerCase())?.has(menu) ?? false;

type Section = { id: number; page_id: number; heading: string; text: string; code: string };
const sections = rows<Section>("SELECT id, page_id, heading, text, code FROM sections");

const sectionPaths = new Map<number, Set<string>>();
const pagePaths = new Map<number, Set<string>>();
for (const s of sections) {
  const found = extractMenuPaths([s.text, s.code], dirPaths, {
    allowTopLevel: ALLOW_TOP_LEVEL,
    resolve: true,
  });
  sectionPaths.set(s.id, found);
  let onPage = pagePaths.get(s.page_id);
  if (!onPage) {
    onPage = new Set();
    pagePaths.set(s.page_id, onPage);
  }
  for (const p of found) onPage.add(p);
}
const pathsOf = (sectionId: number) => sectionPaths.get(sectionId) ?? new Set<string>();

type Prop = {
  id: number;
  page_id: number;
  section_id: number;
  name: string;
  section: string | null;
  title: string;
};
const props = rows<Prop>(
  `SELECT p.id, p.page_id, p.section_id, p.name, p.section, pg.title
   FROM properties p JOIN pages pg ON pg.id = p.page_id
   WHERE p.section_id IS NOT NULL`,
);
say(`Corpus: ${props.length} properties · ${sections.length} sections · ${pagePaths.size} pages\n`);

const bySection = new Map<number, Prop[]>();
for (const p of props) {
  let list = bySection.get(p.section_id);
  if (!list) {
    list = [];
    bySection.set(p.section_id, list);
  }
  list.push(p);
}

// ── M1 coverage ─────────────────────────────────────────────────────────────
say("## M1 Coverage — does the property's own section name any menu path?\n");
let sectionCovered = 0;
let pageCovered = 0;
for (const p of props) {
  if (pathsOf(p.section_id).size > 0) sectionCovered++;
  if ((pagePaths.get(p.page_id)?.size ?? 0) > 0) pageCovered++;
}
say("| Scope | Property rows in a fragment naming >=1 menu path |");
say("|---|---|");
say(`| section-grained | ${sectionCovered} / ${props.length} (${pct(sectionCovered, props.length)}) |`);
say(`| page-grained (today's linker) | ${pageCovered} / ${props.length} (${pct(pageCovered, props.length)}) |`);
const barrenOwners = [...bySection.keys()].filter((id) => pathsOf(id).size === 0).length;
say(
  `\nProperty-owning sections: ${bySection.size} of ${sections.length}; ` +
    `naming no menu path: ${barrenOwners} (${pct(barrenOwners, bySection.size)}).`,
);

// ── M2 resolution ───────────────────────────────────────────────────────────
say("\n## M2 Resolution — is a section fine-grained enough to be a row-level key?\n");
const sizeBuckets = ["1", "2", "3-5", "6-10", "11-25", "26-50", "51+"];
const bucketOf = (n: number) =>
  n === 1 ? "1" : n === 2 ? "2" : n <= 5 ? "3-5" : n <= 10 ? "6-10" : n <= 25 ? "11-25" : n <= 50 ? "26-50" : "51+";
const secsIn = new Map<string, number>();
const rowsIn = new Map<string, number>();
for (const list of bySection.values()) {
  const b = bucketOf(list.length);
  secsIn.set(b, (secsIn.get(b) ?? 0) + 1);
  rowsIn.set(b, (rowsIn.get(b) ?? 0) + list.length);
}
say("| Properties sharing the section | Sections | Property rows |");
say("|---|---|---|");
for (const b of sizeBuckets) {
  if (!secsIn.has(b)) continue;
  say(`| ${b} | ${secsIn.get(b)} | ${rowsIn.get(b)} (${pct(rowsIn.get(b) ?? 0, props.length)}) |`);
}
const meanSection =
  [...bySection.keys()].reduce((a, id) => a + pathsOf(id).size, 0) / (bySection.size || 1);
const ownerPages = new Set(props.map((p) => p.page_id));
const meanPage =
  [...ownerPages].reduce((a, id) => a + (pagePaths.get(id)?.size ?? 0), 0) / (ownerPages.size || 1);
say(
  `\nMean candidate paths per property-owning fragment — section ${meanSection.toFixed(1)} vs ` +
    `page ${meanPage.toFixed(1)} (${(meanPage / (meanSection || 1)).toFixed(1)}x narrower).`,
);

// ── M3 precision ────────────────────────────────────────────────────────────
say("\n## M3 Precision — does an aligned path actually accept the property name?\n");
let scorable = 0;
let sectionHit = 0;
let sectionOne = 0;
let pageHit = 0;
let pageOne = 0;
let cascadeSection = 0;
let cascadePage = 0;
let cascadeNone = 0;
let condTotal = 0;
let condHit = 0;
const misses: string[] = [];
for (const p of props) {
  if (!isKnownName(p.name)) continue;
  scorable++;
  const secAccepting = [...pathsOf(p.section_id)].filter((m) => accepts(p.name, m));
  const pageAccepting = [...(pagePaths.get(p.page_id) ?? [])].filter((m) => accepts(p.name, m));
  if (pathsOf(p.section_id).size > 0) {
    condTotal++;
    if (secAccepting.length > 0) condHit++;
  }
  if (secAccepting.length > 0) {
    sectionHit++;
    cascadeSection++;
    if (secAccepting.length === 1) sectionOne++;
  } else {
    if (misses.length < 6) misses.push(`${p.name} @ "${p.title}" / ${p.section ?? "?"}`);
    if (pageAccepting.length > 0) cascadePage++;
    else cascadeNone++;
  }
  if (pageAccepting.length > 0) {
    pageHit++;
    if (pageAccepting.length === 1) pageOne++;
  }
}
say(`Oracle: ${acceptsByName.size} distinct inspect \`arg\` names. Scorable rows: ${scorable} of ${props.length} (${pct(scorable, props.length)}).\n`);
say("| Outcome | Rows |");
say("|---|---|");
say(`| section names >=1 accepting path | ${sectionHit} (${pct(sectionHit, scorable)}) |`);
say(`| ... exactly one (unambiguous) | ${sectionOne} / ${scorable} (${pct(sectionOne, scorable)}) |`);
say(`| section names no accepting path | ${scorable - sectionHit} (${pct(scorable - sectionHit, scorable)}) |`);
say(`| page-grained names >=1 accepting path | ${pageHit} (${pct(pageHit, scorable)}) |`);
say(`| ... exactly one | ${pageOne} / ${scorable} (${pct(pageOne, scorable)}) |`);
say(
  `\nConditional precision — of the ${condTotal} scorable rows whose section names any path, ` +
    `${condHit} (${pct(condHit, condTotal)}) have an accepting one. ` +
    `So the dominant failure is coverage, not misalignment.`,
);
say(
  `\nSection-first, page-fallback cascade: section ${cascadeSection} (${pct(cascadeSection, scorable)}) · ` +
    `page fallback ${cascadePage} (${pct(cascadePage, scorable)}) · ` +
    `unresolved ${cascadeNone} (${pct(cascadeNone, scorable)}).`,
);
say(`\nSample rows with no accepting path in their section: ${misses.join(" · ")}`);

// ── M3b oracle strength ─────────────────────────────────────────────────────
say("\n### Oracle strength — how much evidence is \"this menu accepts that name\"?\n");
const commonBuckets = ["1 menu", "2-5", "6-25", "26-100", "100+"];
const commonality = new Map<string, number>();
for (const p of props) {
  if (!isKnownName(p.name)) continue;
  const menus = [...(acceptsByName.get(p.name.toLowerCase()) ?? [])].filter((m) => dirPaths.has(m))
    .length;
  const b =
    menus <= 1 ? "1 menu" : menus <= 5 ? "2-5" : menus <= 25 ? "6-25" : menus <= 100 ? "26-100" : "100+";
  commonality.set(b, (commonality.get(b) ?? 0) + 1);
}
say("| Menus accepting this property's name corpus-wide | Scorable rows |");
say("|---|---|");
for (const b of commonBuckets) {
  if (commonality.has(b)) say(`| ${b} | ${commonality.get(b)} (${pct(commonality.get(b) ?? 0, scorable)}) |`);
}
say("\nRows in the high buckets are names like `comment`/`disabled`: acceptance there is nearly free and must not be read as evidence the row documents that command.");

// ── M4 noise ────────────────────────────────────────────────────────────────
say("\n## M4 Noise — per-(section, path) support ratio\n");
say("For each path a property-owning section names: what share of that section's scorable properties does it accept?\n");
const supportOrder = ["0%", "<25%", "25-50%", "50-90%", "90-100%"];
const support = new Map<string, number>();
const zeroSupport: string[] = [];
let pairs = 0;
for (const [sectionId, list] of bySection) {
  const scorables = list.filter((p) => isKnownName(p.name));
  if (scorables.length === 0) continue;
  for (const path of pathsOf(sectionId)) {
    pairs++;
    const ratio = scorables.filter((p) => accepts(p.name, path)).length / scorables.length;
    const b = ratio === 0 ? "0%" : ratio < 0.25 ? "<25%" : ratio < 0.5 ? "25-50%" : ratio < 0.9 ? "50-90%" : "90-100%";
    support.set(b, (support.get(b) ?? 0) + 1);
    if (ratio === 0 && zeroSupport.length < 6) {
      const heading = sections.find((s) => s.id === sectionId)?.heading ?? "?";
      zeroSupport.push(`${path} @ "${heading}" (${scorables.length} props)`);
    }
  }
}
say(`Population: ${pairs} (section, path) pairs across sections owning >=1 scorable property.\n`);
say("| Support ratio | (section, path) pairs |");
say("|---|---|");
for (const b of supportOrder) {
  if (support.has(b)) say(`| ${b} | ${support.get(b)} (${pct(support.get(b) ?? 0, pairs)}) |`);
}
say(
  `\nUnscorable rows — names the command tree has never heard of, so no alignment here can be ` +
    `checked either way: ${props.length - scorable} / ${props.length} (${pct(props.length - scorable, props.length)}).`,
);
say(`\nSample zero-support paths (the \`/ip/settings\` class — a real menu, unrelated to the properties beside it): ${zeroSupport.join(" · ")}`);

// ── M5 table granularity ────────────────────────────────────────────────────
say("\n## M5 Table granularity — is a finer *structural* fragment available?\n");
const tablesPerSection = new Map(
  rows<{ sid: number; n: number }>(
    `SELECT s.id AS sid, COUNT(DISTINCT t.id) AS n
     FROM sections s JOIN page_tables t ON t.section_id = s.id GROUP BY s.id`,
  ).map((r) => [r.sid, r.n]),
);
let noTable = 0;
let oneTable = 0;
let manyTables = 0;
for (const id of bySection.keys()) {
  const n = tablesPerSection.get(id) ?? 0;
  if (n === 0) noTable++;
  else if (n === 1) oneTable++;
  else manyTables++;
}
say(`Property-owning sections by table count — 0: ${noTable} · 1: ${oneTable} · 2+: ${manyTables}`);

const propTables = rows<{ id: number; section_id: number; raw_markdown: string }>(
  `SELECT DISTINCT t.id, t.section_id, t.raw_markdown
   FROM page_tables t
   JOIN page_table_rows r ON r.table_id = t.id
   JOIN properties p ON p.source_table_row_id = r.id
   WHERE t.section_id IS NOT NULL`,
);
let same = 0;
let narrower = 0;
let wider = 0;
let disjoint = 0;
let silent = 0;
for (const t of propTables) {
  const tablePaths = extractMenuPaths([t.raw_markdown], dirPaths, {
    allowTopLevel: ALLOW_TOP_LEVEL,
    resolve: true,
  });
  const secPaths = pathsOf(t.section_id);
  if (tablePaths.size === 0) {
    silent++;
    continue;
  }
  const isSubset = [...tablePaths].every((p) => secPaths.has(p));
  const isSuperset = [...secPaths].every((p) => tablePaths.has(p));
  if (isSubset && isSuperset) same++;
  else if (isSubset) narrower++;
  else if (isSuperset) wider++;
  else disjoint++;
}
say(
  `Property-bearing tables (${propTables.length}) — own path set vs its section's: ` +
    `identical ${same} · narrower ${narrower} · wider ${wider} · disjoint ${disjoint} · names no path ${silent}`,
);
say(
  "\nA table never carries a path its section lacks, and most carry none at all — so a table-grained key " +
    "can only ever lose information relative to the section. This closes B-0024's table-granularity option.",
);

// ── provenance available for a proximity join ───────────────────────────────
say("\n## Provenance available for a nearest-preceding-path (proximity) join\n");
for (const table of ["sections", "page_tables", "page_table_rows", "properties"]) {
  const cols = rows<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
  say(`- \`${table}\`: ${cols.join(", ")}`);
}
say(
  "\nNo source line/offset column exists on any of them — only `sort_order`. A proximity join would " +
    "need new provenance captured at extraction time, not a different query over what ships today.",
);

// ── Step 4: what the shipped grader does to the labels ──────────────────────
//
// Everything above measures the *signal*. This measures the *tool*: it replays
// `lookupProperty`'s candidate set and filter, grades every candidate with the production
// `gradeRow`/`supportedPaths`, and diffs the result against the labels the pre-B-0024 code
// would have produced (scoped branch ⇒ `high`, global fallback ⇒ `low`). The briefing and
// CHANGELOG figures come from here, so they can be regenerated after any rule change.
//
// Takes a couple of minutes — it is a census, not a gate.
say("\n## Step 4 — label transitions under the shipped grader\n");

// The grader always matches bare top-level menus, regardless of this run's TOP_LEVEL setting:
// that is a read-side choice it makes independently of the linker. Re-extract accordingly so
// these numbers describe the shipped code and not this script's flag.
const graderPaths = new Map<number, ReadonlySet<string>>();
for (const s of sections) {
  graderPaths.set(s.id, extractMenuPaths([s.text, s.code], dirPaths, { allowTopLevel: true, resolve: true }));
}
const graderSupported = new Map<number, ReadonlySet<string>>();
const supportedOf = (sectionId: number): ReadonlySet<string> => {
  let cached = graderSupported.get(sectionId);
  if (!cached) {
    const paths = graderPaths.get(sectionId) ?? new Set<string>();
    // `gradeRows` scores `SELECT DISTINCT name`; duplicates would weight one name twice and can
    // flip which menu wins support, so dedupe to keep the census on the grader's contract.
    const names = [...new Set((bySection.get(sectionId) ?? []).map((p) => p.name))];
    cached = supportedPaths(paths, names, acceptsByName);
    graderSupported.set(sectionId, cached);
  }
  return cached;
};

type Candidate = { page_id: number; section_id: number | null; name: string };
const candidatesByName = new Map<string, Candidate[]>();
for (const c of rows<Candidate>("SELECT page_id, section_id, name FROM properties")) {
  const key = c.name.toLowerCase();
  let list = candidatesByName.get(key);
  if (!list) {
    list = [];
    candidatesByName.set(key, list);
  }
  list.push(c);
}
const linkedPageOf = new Map<string, number>();
for (const c of rows<{ path: string; page_id: number }>(
  "SELECT path, page_id FROM commands WHERE page_id IS NOT NULL",
)) {
  if (!linkedPageOf.has(c.path)) linkedPageOf.set(c.path, c.page_id);
}

/** The realistic query population: (menu, name) pairs the command tree says are real. */
const queryPairs: Array<[string, string]> = [];
for (const [name, menus] of acceptsByName) {
  if (!candidatesByName.has(name)) continue;
  for (const m of menus) if (dirPaths.has(m)) queryPairs.push([m, name]);
}

// ── Step 5 evidence: where does a `high` label's exact match actually come from? ──────────
//
// `resolveToDir` walks a mention like `/certificate/import file-name=x` back to `/certificate`,
// so a section that never names a menu can still supply exact-match evidence for it. That is
// deliberate and usually right, but it also lets a section documenting a *command* (its output
// columns) claim to be about the command's *menu*. These maps separate the two so the shipped
// `high` population can be split by which kind of evidence produced it.
const namedPaths = new Map<number, ReadonlySet<string>>();
/** Section → menu → the deeper path(s) that collapsed onto it. Only menus the section never names. */
const collapsedFrom = new Map<number, Map<string, Set<string>>>();
for (const s of sections) {
  const named = extractMenuPaths([s.text, s.code], dirPaths, { allowTopLevel: true });
  namedPaths.set(s.id, named);
  const from = new Map<string, Set<string>>();
  for (const p of named) {
    if (dirPaths.has(p)) continue;
    const dir = resolveToDir(p, dirPaths);
    if (dir === null || named.has(dir)) continue;
    let sources = from.get(dir);
    if (!sources) {
      sources = new Set();
      from.set(dir, sources);
    }
    sources.add(p);
  }
  collapsedFrom.set(s.id, from);
}

// The CLI-Reference overlay is the only source that distinguishes a settable `Argument` from a
// `Read-only Argument`, and it does so per command — exactly the distinction the collapse loses.
const clirefFieldKind = db.prepare(
  `SELECT 1 FROM cliref_fields f JOIN cliref_entries e ON e.id = f.entry_id
   WHERE e.source_path = ? AND f.name = ? COLLATE NOCASE AND f.field_kind = ? LIMIT 1`,
);
/** `source_path` in the overlay has no leading slash. */
const clirefSays = (path: string, name: string, kind: string): boolean =>
  clirefFieldKind.get(path.slice(1), name, kind) != null;

const READ_ONLY_VERBS = new Set(["print", "monitor", "export", "scan", "find", "get", "check"]);
let highNamed = 0;
let highCollapsed = 0;
let collapsedReadOnlyVerb = 0;
let collapsedRoConfirmed = 0;
let collapsedSettableAtMenu = 0;
let roVerbButSettable = 0;
let roVerbAndReadOnly = 0;

const transitions = new Map<string, number>();
const bump = (k: string) => transitions.set(k, (transitions.get(k) ?? 0) + 1);
let oldHigh = 0;
let oldLow = 0;
// Gate comparison: of the alignments that could reach `high` on naming alone, how many each
// candidate rule keeps. This is the evidence for choosing the support gate over exclusivity.
let gateNone = 0;
let gateSupport = 0;
let gateExclusive = 0;
const related = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
for (const [menu, name] of queryPairs) {
  const candidates = candidatesByName.get(name) ?? [];
  const linkedPage = linkedPageOf.get(menu) ?? null;
  const linkContributes = linkedPage !== null && candidates.some((c) => c.page_id === linkedPage);

  const menusForName = acceptsByName.get(name);
  const graded = candidates.map((c) => {
    const onLinkedPage = c.page_id === linkedPage;
    const paths = c.section_id === null ? new Set<string>() : (graderPaths.get(c.section_id) ?? new Set());
    const supported = c.section_id === null ? new Set<string>() : supportedOf(c.section_id);
    const after: PropertyLookupConfidence = gradeRow(menu, {
      sectionPaths: paths,
      supportedPaths: supported,
      pageAligned: onLinkedPage,
      acceptsName: paths.has(menu) ? (menusForName ? menusForName.has(menu) : null) : null,
    });
    if (paths.has(menu) && (menusForName ? menusForName.has(menu) : true)) {
      gateNone++;
      if (supported.has(menu)) gateSupport++;
      if ([...paths].every((q) => related(q, menu))) gateExclusive++;
    }
    return { onLinkedPage, after, row: c };
  });

  // `lookupProperty` keeps an off-page row only if it is at least as good as the best tier the
  // linked page itself offers.
  let bestLinkedRank: number | null = null;
  for (const g of graded) {
    if (!g.onLinkedPage) continue;
    const rank = tierRank(g.after);
    if (bestLinkedRank === null || rank < bestLinkedRank) bestLinkedRank = rank;
  }

  for (const g of graded) {
    // Pre-B-0024: the scoped branch returned only linked-page rows and called them all `high`;
    // otherwise the global fallback returned everything as `low`.
    const before: string = linkContributes ? (g.onLinkedPage ? "high" : "absent") : "low";
    if (before === "high") oldHigh++;
    else if (before === "low") oldLow++;
    const kept = bestLinkedRank === null || g.onLinkedPage || tierRank(g.after) <= bestLinkedRank;
    bump(`${before} → ${kept ? g.after : "absent"}`);

    // Step 5: split the surviving `high` labels by the provenance of their exact match.
    if (!kept || g.after !== "high" || g.row.section_id === null) continue;
    if (namedPaths.get(g.row.section_id)?.has(menu)) {
      highNamed++;
      continue;
    }
    highCollapsed++;
    const sources = collapsedFrom.get(g.row.section_id)?.get(menu) ?? new Set<string>();
    const verbs = [...sources].map((p) => p.slice(menu.length + 1).split("/")[0]);
    // The command each mention collapsed from, e.g. `/interface/wifi/scan`.
    const commands = verbs.map((v) => `${menu}/${v}`);
    const readOnlyThere = commands.some((c) => clirefSays(c, name, "Read-only Argument"));
    const settableHere = clirefSays(menu, name, "Argument");
    if (readOnlyThere) collapsedRoConfirmed++;
    if (settableHere) collapsedSettableAtMenu++;
    if (verbs.length > 0 && verbs.every((v) => READ_ONLY_VERBS.has(v))) {
      collapsedReadOnlyVerb++;
      if (settableHere) roVerbButSettable++;
      else if (readOnlyThere) roVerbAndReadOnly++;
    }
  }
}

const total = [...transitions.values()].reduce((a, b) => a + b, 0);
say(`Realistic (menu, name) pairs: ${queryPairs.length} · row labels compared: ${total}\n`);
say("| Transition | Rows | Share |");
say("|---|---:|---:|");
for (const [k, v] of [...transitions].sort((a, b) => b[1] - a[1])) {
  say(`| \`${k.replace(" → ", "` → `")}\` | ${v} | ${pct(v, total)} |`);
}
const survived = transitions.get("high → high") ?? 0;
const rescued = (transitions.get("absent → high") ?? 0) + (transitions.get("absent → medium") ?? 0);
say(
  `\nOf the ${oldHigh} labels that shipped as \`high\`, ${survived} survive (${pct(survived, oldHigh)}).` +
    ` ${rescued} rows the old candidate set suppressed entirely are now returned with evidence.` +
    ` The \`low\` population (${oldLow}) is dominated by lookups where no page is linked at all.`,
);

// ── Step 5: how thin is the evidence under the labels that survived? ────────
say("\n## Step 5 — provenance of the shipped `high` labels\n");
const highTotal = highNamed + highCollapsed;
say("| Evidence for the exact match | Rows | Share of `high` |");
say("|---|---:|---:|");
say(`| the section names the menu itself | ${highNamed} | ${pct(highNamed, highTotal)} |`);
say(
  `| only a deeper path collapsed onto it (\`resolveToDir\`) | ${highCollapsed} | ${pct(highCollapsed, highTotal)} |`,
);
say(
  `\nOf the ${highCollapsed} collapsed-evidence rows, the CLI-Reference overlay calls the name a settable` +
    ` \`Argument\` at the menu itself for ${collapsedSettableAtMenu} (${pct(collapsedSettableAtMenu, highCollapsed)})` +
    ` — the collapse doing its job — and a \`Read-only Argument\` at the command it collapsed from for` +
    ` ${collapsedRoConfirmed} (${pct(collapsedRoConfirmed, highCollapsed)}), which is the section-documents-output` +
    ` failure mode.`,
);
say(
  `\nRefusing to collapse read-only verbs (${[...READ_ONLY_VERBS].join("/")}) would demote` +
    ` ${collapsedReadOnlyVerb} rows, of which the overlay says ${roVerbButSettable} are settable at the menu` +
    ` anyway (wrong demotions) and ${roVerbAndReadOnly} are genuinely read-only there. Verb shape is a` +
    ` proxy for the wrong thing; \`field_kind\` is the signal.`,
);

say(
  `\nSupport gate vs the blunter alternative — of ${gateNone} alignments that naming alone would call` +
    ` \`high\`, the shipped support gate keeps ${gateSupport} (${pct(gateSupport, gateNone)}) and rejecting` +
    ` any section that names an unrelated menu keeps ${gateExclusive} (${pct(gateExclusive, gateNone)}).`,
);
