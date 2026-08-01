/**
 * property-confidence.ts — how much does a property row know about the command you asked for?
 *
 * `lookupProperty(name, commandPath)` returns rows from prose; the caller wants to know which
 * of them documents `name` *for that menu*. Until now the answer rested entirely on
 * `commands.page_id` — a nullable, page-grained, fuzzy slug-trailing link (`link-ranking.ts`).
 * Any row on the linked page was labelled `high`, and any row reached by the global fallback
 * was labelled `low`, so the label described **which query branch ran**, not what the row knows.
 *
 * B-0024 step 3 measured the alternative corpus-wide: menu paths named in the property's own
 * *section*. That signal is 75.6% precise when present but silent for 42.7% of property-owning
 * sections — a ranking signal, not a key. So it is used to grade and to rank; the page link
 * survives only as the `medium` tier for rows with no path evidence of their own.
 *
 * Three rules the measurement forces (`briefings/B-0024-command-prose-join.md` step 4):
 *
 * 1. **Field existence never sets the tier.** The command tree answers "is this a real field at
 *    this menu" — a fact about the *query*, not about a candidate row. It may confirm a tier
 *    reached by path alignment, or demote one that contradicts it, never promote.
 * 2. **Ubiquitous names cannot reach `high` on acceptance.** `comment` is accepted at 26+ menus,
 *    so acceptance carries no information. Rule 1 already enforces this structurally — nothing
 *    reaches `high` on acceptance — so no separate ubiquity check exists here.
 * 3. **Silence is `low`, not `medium`.** Absent evidence is not partial evidence; treating it as
 *    such is exactly the miscalibration this replaces.
 *
 * And one the measurement *answered* (step 4's open "support ratio" question): a section that
 * names a menu is not necessarily *about* it. The bridge-firewall section cites
 * `/ip/firewall/filter` in passing while documenting `/interface/bridge/filter`, and citation
 * alone was enough to mislabel it `high`. {@link supportedPaths} resolves that by asking which
 * of the named menus accepts the most of the section's *own* property names. Requiring the
 * winner keeps 87.2% of the alignments naming alone would accept; the blunter alternative (reject any
 * section naming more than one menu) keeps 42.4% and throws away correct alignments over incidental
 * cross-references. Both figures regenerate from `eval/command-prose-join.ts`.
 */

import { db } from "./db.ts";
import { extractMenuPaths } from "./menu-paths.ts";

export type PropertyLookupConfidence = "high" | "medium" | "low";

/** What is known about one candidate row relative to the requested menu. */
export type PathEvidence = {
  /** Menu paths named by the section documenting the row, resolved to real `dir` menus. */
  sectionPaths: ReadonlySet<string>;
  /**
   * The subset of `sectionPaths` the section is plausibly *about* rather than merely citing —
   * see {@link supportedPaths}. Equal to `sectionPaths` when support cannot be judged.
   */
  supportedPaths: ReadonlySet<string>;
  /** The row's page is the one `commands.page_id` links to for the requested menu. */
  pageAligned: boolean;
  /**
   * Does the requested menu accept this property name, per the inspect-derived command tree?
   * `null` when the name has no `arg` rows anywhere — silence that proves nothing either way.
   */
  acceptsName: boolean | null;
};

const depth = (p: string) => p.split("/").length - 1;

/**
 * Grade one row. Pure — see {@link gradeRows} for the DB-backed evidence gathering.
 *
 * A bare top-level menu (`/ip`) is not accepted as an *ancestor*: nearly every networking
 * section mentions one, so it would promote unrelated rows to `medium` on no real evidence.
 * A descendant counts at any depth — a section about `/ip/dhcp-server/network` is about
 * `/ip/dhcp-server`.
 */
export function gradeRow(requestedPath: string, ev: PathEvidence): PropertyLookupConfidence {
  if (ev.sectionPaths.has(requestedPath)) {
    // Named, but another menu it names owns more of this section's properties: a cross-reference.
    if (!ev.supportedPaths.has(requestedPath)) return "medium";
    // Rule 1: acceptance may demote, never promote. A section that names this menu but whose
    // name the menu rejects is suspect, not authoritative.
    return ev.acceptsName === false ? "medium" : "high";
  }
  for (const p of ev.sectionPaths) {
    if (requestedPath.startsWith(`${p}/`) && depth(p) >= 2) return "medium";
    if (p.startsWith(`${requestedPath}/`)) return "medium";
  }
  // Rule 3: the page tier is the only remaining evidence; without it, silence is `low`.
  return ev.pageAligned ? "medium" : "low";
}

const TIER_ORDER: Record<PropertyLookupConfidence, number> = { high: 0, medium: 1, low: 2 };

/** Sort key for a tier — lower is better. Stable-sort callers keep ties in their original order. */
export function tierRank(c: PropertyLookupConfidence): number {
  return TIER_ORDER[c];
}

/** Lowercased property name → the menus the command tree says accept it. */
export type AcceptanceMap = ReadonlyMap<string, ReadonlySet<string>>;

/** `commands` rows of `type = 'arg'`, which is where acceptance evidence lives. */
export type ArgRow = { name: string; parent_path: string };

/**
 * Build an {@link AcceptanceMap}. An arg lives under a verb, so
 * `/interface/bridge/port/add/pvid` proves the *menu* `/interface/bridge/port` takes `pvid`.
 *
 * Shared with `eval/command-prose-join.ts` so the census cannot drift from the grader it
 * describes — the same reason `menu-paths.ts` exists.
 */
export function acceptanceMap(argRows: Iterable<ArgRow>): AcceptanceMap {
  const map = new Map<string, Set<string>>();
  for (const r of argRows) {
    const key = r.name.toLowerCase();
    let menus = map.get(key);
    if (!menus) {
      menus = new Set();
      map.set(key, menus);
    }
    menus.add(r.parent_path);
    const menu = r.parent_path.slice(0, r.parent_path.lastIndexOf("/"));
    if (menu.includes("/")) menus.add(menu);
  }
  return map;
}

/**
 * Of the menus a section names, those accepting the most of the section's own property names —
 * i.e. the menu(s) the section is plausibly *about* rather than merely citing. Ties keep both:
 * a menu and its submenu are routinely documented together and equally supported.
 *
 * Two kinds of zero are distinguished, and the difference is the whole point:
 *
 * - **Silence** — the command tree has never heard of any of the section's property names. It
 *   cannot judge, so every named menu stays eligible.
 * - **Zero support** — it knows those names and none of the named menus takes any of them. That
 *   is evidence *against* every candidate, so none is eligible and the row cannot reach `high`.
 *
 * A section naming exactly one menu is scored like any other. Skipping the check there would
 * exempt precisely the sections with no competing menu to be measured against, which is where a
 * lone passing mention is least contradicted and most likely to be mistaken for authority.
 */
export function supportedPaths(
  paths: ReadonlySet<string>,
  sectionPropertyNames: readonly string[],
  accepts: AcceptanceMap,
): ReadonlySet<string> {
  if (paths.size === 0) return paths;
  const known = sectionPropertyNames.map((n) => n.toLowerCase()).filter((n) => accepts.has(n));
  if (known.length === 0) return paths;

  let best = 0;
  const scores = new Map<string, number>();
  for (const p of paths) {
    let n = 0;
    for (const name of known) {
      if (accepts.get(name)?.has(p)) n++;
    }
    scores.set(p, n);
    if (n > best) best = n;
  }
  if (best === 0) return EMPTY_PATHS;

  const winners = new Set<string>();
  for (const [p, n] of scores) {
    if (n === best) winners.add(p);
  }
  return winners;
}

/** Rows carrying just enough to grade them. */
export type GradableRow = { name: string; section_id: number | null };

// The `dir` set and the statements below do not change while the process holds the DB open, but
// they cannot be built at import time: `db.ts` is a singleton that tests point at an empty
// `:memory:` and populate in `beforeAll`. Built on first use instead.
let dirPathsCache: ReadonlySet<string> | null = null;
const dirPaths = (): ReadonlySet<string> =>
  (dirPathsCache ??= new Set(
    (db.prepare("SELECT path FROM commands WHERE type = 'dir'").all() as Array<{ path: string }>).map(
      (r) => r.path,
    ),
  ));

type Stmts = {
  section: ReturnType<typeof db.prepare>;
  names: ReturnType<typeof db.prepare>;
  acceptance: ReturnType<typeof db.prepare>;
};
let stmtsCache: Stmts | null = null;
const stmts = (): Stmts =>
  (stmtsCache ??= {
    section: db.prepare("SELECT text, code FROM sections WHERE id = ?"),
    names: db.prepare("SELECT DISTINCT name FROM properties WHERE section_id = ?"),
    // One scan of the arg rows per section, rather than one per property name.
    acceptance: db.prepare(
      `SELECT DISTINCT c.name, c.parent_path FROM commands c
       WHERE c.type = 'arg' AND c.parent_path IS NOT NULL
         AND lower(c.name) IN (SELECT lower(name) FROM properties WHERE section_id = ?)`,
    ),
  });

/** Drop the cached `dir` set and statements — for tests that rebuild the DB behind the singleton. */
export function resetPropertyConfidenceCache(): void {
  dirPathsCache = null;
  stmtsCache = null;
}

/**
 * Grade a lookup's rows against the requested menu, in row order.
 *
 * `isPageAligned` is asked per row because the candidate set spans pages: the row on the page
 * `commands.page_id` links to gets the page tier, everything else has to earn its tier from its
 * own section.
 */
export function gradeRows<T extends GradableRow>(
  rows: readonly T[],
  requestedPath: string,
  isPageAligned: (row: T) => boolean,
): PropertyLookupConfidence[] {
  if (rows.length === 0) return [];

  const dirs = dirPaths();
  const { section, names, acceptance } = stmts();

  type Analysis = { paths: ReadonlySet<string>; supported: ReadonlySet<string>; accepts: AcceptanceMap };
  const analysed = new Map<number, Analysis>();

  const analyse = (id: number): Analysis => {
    const cached = analysed.get(id);
    if (cached) return cached;
    const s = section.get(id) as { text: string | null; code: string | null } | null;
    // `allowTopLevel` is a read-side choice: the linker deliberately ignores bare top-level
    // menus because changing it changes what `commands.page_id` links, but grading has no such
    // constraint and a section whose only mention is `/certificate` is still evidence for it.
    const paths = s
      ? extractMenuPaths([s.text, s.code], dirs, { allowTopLevel: true, resolve: true })
      : (EMPTY_PATHS as ReadonlySet<string>);
    // Support and acceptance only ever move an *aligned* row, so a section that does not name
    // the requested menu skips both scans — which is the common case, and the reason a
    // 20-candidate lookup stays in the tens of milliseconds.
    let result: Analysis;
    if (!paths.has(requestedPath)) {
      result = { paths, supported: paths, accepts: EMPTY_ACCEPTS };
    } else {
      const accepts = acceptanceMap(acceptance.all(id) as ArgRow[]);
      const sectionNames = (names.all(id) as Array<{ name: string }>).map((r) => r.name);
      result = { paths, supported: supportedPaths(paths, sectionNames, accepts), accepts };
    }
    analysed.set(id, result);
    return result;
  };

  return rows.map((row) => {
    if (row.section_id === null) {
      return gradeRow(requestedPath, {
        sectionPaths: EMPTY_PATHS,
        supportedPaths: EMPTY_PATHS,
        pageAligned: isPageAligned(row),
        acceptsName: null,
      });
    }
    const { paths, supported, accepts } = analyse(row.section_id);
    const menus = accepts.get(row.name.toLowerCase());
    return gradeRow(requestedPath, {
      sectionPaths: paths,
      supportedPaths: supported,
      pageAligned: isPageAligned(row),
      // Rule 1: only ever consulted for an aligned row, and `null` (no arg rows anywhere for
      // this name) must read as "unknown", not "rejected".
      acceptsName: menus ? menus.has(requestedPath) : null,
    });
  });
}

const EMPTY_PATHS: ReadonlySet<string> = new Set();
const EMPTY_ACCEPTS: AcceptanceMap = new Map();
