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
 * Versions (#188): every served manual tree is extracted — the default /docs/ tree plus each
 * /docs/<v>/ tree cli-compare.json lists — keyed by the version its llms.txt declares. See
 * resolveTreesLive() for which trees are fetched, skipped, or fail the build.
 *
 * Usage:
 *   bun run src/extract-cliref.ts                 # live fetch of every tree and page (never
 *                                                 # reads the cache); overwrites CACHE_DIR/<v>/,
 *                                                 # then prunes what this run did not discover
 *   bun run src/extract-cliref.ts --from-cache    # re-extract from CACHE_DIR, no network: each
 *                                                 # <v>/ dir with a _tree.json is one tree (the
 *                                                 # default tree also needs its _sitemap.txt)
 *   bun run src/extract-cliref.ts --limit=25       # cap page count per tree (smoke-testing)
 *   bun run src/extract-cliref.ts --check-counts   # assert parsed == source markers
 *   bun run src/extract-cliref.ts --reconcile-report=FILE  # where the cli-compare.json
 *                                                 # reconciliation TSV goes (default:
 *                                                 # CACHE_DIR/cli-compare-reconcile.tsv)
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pruneCache } from "./cache-prune.ts";
import { db, getDbMeta, initDb, setDbMeta } from "./db.ts";
import { CLIREF_MANUAL_VERSION_KEY, DOCS_MANUAL_VERSION_KEY, manualVersionMismatch, parseManualVersion } from "./manual-version.ts";
import { parseSitemapLocs } from "./rosetta-id.ts";

const BASE = "https://manual.mikrotik.com";
const LLMS_TXT_URL = `${BASE}/llms.txt`;
const SITEMAP_URL = `${BASE}/sitemap.xml`;
const CLI_COMPARE_URL = `${BASE}/cli-compare.json`;
const DEFAULT_DOCS_PREFIX = "/docs/";
const CLI_PREFIX = `${DEFAULT_DOCS_PREFIX}cli-reference/`;
// A declared tree label becomes a URL segment and a cache directory name, so it is held to
// the version shape parseManualVersion accepts.
const TREE_LABEL = /^\d+\.\d+(?:\.\d+)?(?:(?:alpha|beta|rc)\d+)?$/;
const CLI_SLUG = /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/;
/**
 * Pages under /docs/cli-reference/ that llms.txt lists but that document no CLI path:
 * - `index`: the old section landing page (the argument-type glossary), now /docs/cli-reference.md.
 * - `compare-versions`: MikroTik's CLI-compare tool page (prose + `<CliCompare />`), added
 *   2026-10-20 (#194).
 * A listed one is still fetched and must carry zero **Type:** entries (assertNonCliPage), so
 * MikroTik turning one into a real menu page fails the build instead of dropping it.
 */
export const NON_CLI_PAGES: ReadonlySet<string> = new Set(["index", "compare-versions"]);
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
const reportArg = argv.find((a) => a.startsWith("--reconcile-report="));
const RECONCILE_REPORT = reportArg ? reportArg.slice("--reconcile-report=".length) : join(CACHE_DIR, "cli-compare-reconcile.tsv");

// ── Discovery ──

/** CLI-Reference slug for a URL, or null when the URL is out of scope / not a CLI page. */
export function cliRefSlug(urlOrPath: string, cliPrefix = CLI_PREFIX): string | null {
  const slug = cliRefPathSlug(urlOrPath, cliPrefix);
  return slug === null || NON_CLI_PAGES.has(slug) ? null : slug;
}

/** A NON_CLI_PAGES slug when `urlOrPath` addresses one, else null. */
export function nonCliPageSlug(urlOrPath: string, cliPrefix = CLI_PREFIX): string | null {
  const slug = cliRefPathSlug(urlOrPath, cliPrefix);
  return slug !== null && NON_CLI_PAGES.has(slug) ? slug : null;
}

/** Fail when a page excluded as non-CLI has gained **Type:** entries (#194). */
export function assertNonCliPage(slug: string, md: string): void {
  const { entries } = countStructuralMarkers(md);
  if (entries > 0) {
    throw new Error(
      `${slug} is excluded as a non-CLI page but now has **Type:** entries (${entries}) — ` +
        "MikroTik made it a real CLI page; remove it from NON_CLI_PAGES so it is extracted (#194).",
    );
  }
}

function cliRefPathSlug(urlOrPath: string, cliPrefix: string): string | null {
  let path: string;
  try {
    path = new URL(urlOrPath).pathname;
  } catch {
    path = urlOrPath;
  }
  if (!path.startsWith(cliPrefix)) return null;
  const slug = path.slice(cliPrefix.length).replace(/\/$/, "");
  // A trailing-slash URL is the Docusaurus generated category page for a branching menu.
  // It has no .md of its own — but the menu's own Directory entry IS published, at
  // `<dir>.md` (`app/` -> `app.md`; it was `app/app.md` until 2026-10-06). That page
  // arrives through llms.txt (see loadCliRefSlugs), so the category URL stays excluded here.
  if (slug === "" || path.endsWith("/") || !CLI_SLUG.test(slug)) return null;
  return slug;
}

/** Cache filename for a slug: "interface/bridge" -> "interface__bridge.md". */
function cacheName(slug: string): string {
  return `${slug.replace(/\//g, "__")}.md`;
}

/**
 * Absolute cache path for a name, guaranteed to stay inside `dir`. cacheName()
 * already neutralizes "/" (→ "__"), but names derive from the network sitemap, so this
 * is an explicit containment backstop — a write can never escape the cache dir even from
 * a hostile slug (mirrors extract-docusaurus.ts's cache guard; satisfies CodeQL's
 * network-data-to-file / traversal check).
 */
function safeCachePath(dir: string, name: string): string {
  const target = resolve(dir, name);
  const root = resolve(dir);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`cache name ${JSON.stringify(name)} resolves outside ${dir}`);
  }
  return target;
}

// ── Trees (#188) ──

/**
 * One served CLI-Reference tree. `label` is the version its llms.txt declares and is the
 * tree's identity; `docsPrefix` is where it was read from (`/docs/` for the default tree,
 * `/docs/<v>/` for a versioned one).
 */
export interface CliRefTree {
  label: string;
  docsPrefix: string;
  isDefault: boolean;
  fetchedAt: string;
  llmsTxt: string;
}

function treeCliPrefix(tree: CliRefTree): string {
  return `${tree.docsPrefix}cli-reference/`;
}

/** The tree's own cache directory, `CACHE_DIR/<label>/`. */
function treeCacheDir(tree: Pick<CliRefTree, "label">): string {
  return safeCachePath(CACHE_DIR, tree.label);
}

export interface CliCompareChange {
  path: string;
  added: { params: string[]; flags: string[] };
  removed: { params: string[]; flags: string[] };
}

export interface CliComparePair {
  changedCommands: CliCompareChange[];
  addedCommands: string[];
  removedCommands: string[];
}

/** MikroTik's https://manual.mikrotik.com/cli-compare.json: the served versions and per-pair diffs. */
export interface CliCompare {
  versions: string[];
  pairs: Record<string, CliComparePair>;
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Parse and shape-check cli-compare.json. A served file that does not parse is broken: throw. */
export function parseCliCompare(text: string): CliCompare {
  const fail = (why: string): never => {
    throw new Error(`cli-compare.json is served but malformed (${why}) — re-check its shape before extracting (#188)`);
  };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail("not JSON");
  }
  const j = raw as { versions?: unknown; pairs?: unknown };
  if (!isStringArray(j.versions)) return fail("versions is not a string array");
  for (const v of j.versions) if (!TREE_LABEL.test(v)) fail(`version ${JSON.stringify(v)}`);
  if (typeof j.pairs !== "object" || j.pairs === null) return fail("pairs is not an object");
  const sides = (x: unknown) => {
    const o = x as { params?: unknown; flags?: unknown } | null;
    if (!o || !isStringArray(o.params) || !isStringArray(o.flags)) fail("change side lacks params/flags arrays");
    return { params: (o as { params: string[] }).params, flags: (o as { flags: string[] }).flags };
  };
  const pairs: Record<string, CliComparePair> = {};
  for (const [key, value] of Object.entries(j.pairs as Record<string, unknown>)) {
    const p = value as { changedCommands?: unknown; addedCommands?: unknown; removedCommands?: unknown };
    if (!Array.isArray(p.changedCommands) || !isStringArray(p.addedCommands) || !isStringArray(p.removedCommands)) {
      fail(`pair ${key}`);
    }
    pairs[key] = {
      addedCommands: p.addedCommands as string[],
      removedCommands: p.removedCommands as string[],
      changedCommands: (p.changedCommands as Array<{ path?: unknown; added?: unknown; removed?: unknown }>).map((c) => {
        if (typeof c.path !== "string") fail(`pair ${key} change without a path`);
        return { path: c.path as string, added: sides(c.added), removed: sides(c.removed) };
      }),
    };
  }
  return { versions: j.versions, pairs };
}

async function fetchText(url: string): Promise<{ status: number; text: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  return { status: res.status, text: res.ok ? await res.text() : "" };
}

/**
 * Which trees a live run extracts. The default tree's declared version is resolved first;
 * every version cli-compare.json lists, plus that one, is then probed at /docs/<v>/:
 *
 *   200                         → extract it from /docs/<v>/ (for the default's own version
 *                                 this is the dedupe case: one tree, its stable URL, is_default)
 *   404, the default's version  → covered by the default /docs/ tree, silently (7.26 today)
 *   404, any other version      → warn and skip — an upstream absence never fails a build
 *   anything else, or a 200 whose llms.txt declares another version → throw: served but broken
 *
 * cli-compare.json itself: 404 → warn and fall back to the default tree alone; a 200 that
 * does not parse → throw (parseCliCompare).
 */
async function resolveTreesLive(): Promise<{ trees: CliRefTree[]; compare: CliCompare | null; compareText: string | null }> {
  const fetchedAt = new Date().toISOString();
  const root = await fetchText(LLMS_TXT_URL);
  if (root.status !== 200) throw new Error(`Failed to fetch ${LLMS_TXT_URL}: HTTP ${root.status}`);
  const defaultLabel = parseManualVersion(root.text);

  const cmp = await fetchText(CLI_COMPARE_URL);
  let compare: CliCompare | null = null;
  if (cmp.status === 404) {
    console.log(`::warning::${CLI_COMPARE_URL} returned 404 — extracting the default tree only, with no reconciliation`);
  } else if (cmp.status !== 200) {
    throw new Error(`Failed to fetch ${CLI_COMPARE_URL}: HTTP ${cmp.status}`);
  } else {
    compare = parseCliCompare(cmp.text);
  }

  // Default first: its rows are stored first, so their ids match a single-tree build.
  const labels = [defaultLabel, ...(compare?.versions ?? []).filter((v) => v !== defaultLabel)];
  const trees: CliRefTree[] = [];
  for (const label of new Set(labels)) {
    const docsPrefix = `${DEFAULT_DOCS_PREFIX}${label}/`;
    const probe = await fetchText(`${BASE}${docsPrefix}llms.txt`);
    const isDefault = label === defaultLabel;
    if (probe.status === 200) {
      const declared = parseManualVersion(probe.text);
      if (declared !== label) throw new Error(`${docsPrefix}llms.txt declares ${declared}, not ${label} — served but broken (#188)`);
      trees.push({ label, docsPrefix, isDefault, fetchedAt, llmsTxt: probe.text });
    } else if (probe.status === 404) {
      if (isDefault) trees.push({ label, docsPrefix: DEFAULT_DOCS_PREFIX, isDefault, fetchedAt, llmsTxt: root.text });
      else console.log(`::warning::cli-compare.json lists ${label}, but ${docsPrefix}llms.txt returned 404 — tree skipped`);
    } else {
      throw new Error(`Failed to fetch ${BASE}${docsPrefix}llms.txt: HTTP ${probe.status}`);
    }
  }
  return { trees, compare, compareText: compare === null ? null : cmp.text };
}

/** --from-cache: every CACHE_DIR/<v>/ holding a _tree.json is one tree, read back as the live run left it. */
function readCachedTrees(): { trees: CliRefTree[]; compare: CliCompare | null } {
  const trees: CliRefTree[] = [];
  const dirs = existsSync(CACHE_DIR) ? readdirSync(CACHE_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
  for (const d of dirs.map((x) => x.name).sort()) {
    if (!TREE_LABEL.test(d)) continue;
    const dir = safeCachePath(CACHE_DIR, d);
    let meta: { label: string; docsPrefix: string; isDefault: boolean; fetchedAt: string };
    try {
      meta = JSON.parse(readFileSync(join(dir, "_tree.json"), "utf8"));
    } catch {
      continue; // not a tree directory this extractor wrote
    }
    if (meta.label !== d) throw new Error(`${dir}/_tree.json names tree ${meta.label}`);
    // Rebuild the prefix from the validated directory name rather than trusting the file's
    // string: any tree may be /docs/<its own label>/, and only the default tree may be /docs/.
    const isDefault = meta.isDefault === true;
    const docsPrefix = isDefault && meta.docsPrefix === DEFAULT_DOCS_PREFIX ? DEFAULT_DOCS_PREFIX : `${DEFAULT_DOCS_PREFIX}${d}/`;
    if (meta.docsPrefix !== docsPrefix) throw new Error(`${dir}/_tree.json has docsPrefix ${JSON.stringify(meta.docsPrefix)}, expected ${docsPrefix}`);
    trees.push({
      label: d,
      docsPrefix,
      isDefault,
      fetchedAt: String(meta.fetchedAt),
      llmsTxt: readFileSync(join(dir, "_llms.txt"), "utf8"),
    });
  }
  if (trees.length === 0) {
    throw new Error(`--from-cache set but no cached trees (<version>/_tree.json) under ${CACHE_DIR} — run one live extract first (#188)`);
  }
  if (trees.filter((t) => t.isDefault).length !== 1) throw new Error(`--from-cache: expected exactly one default tree under ${CACHE_DIR}`);
  trees.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  const comparePath = join(CACHE_DIR, "_cli-compare.json");
  const compare = existsSync(comparePath) ? parseCliCompare(readFileSync(comparePath, "utf8")) : null;
  return { trees, compare };
}

/** URL-parent slug segment used as the sidebar group ("interface/wifi" -> "interface"). */
function tocGroup(slug: string): string {
  return slug.includes("/") ? slug.slice(0, slug.lastIndexOf("/")) : "";
}

/**
 * Page inventory: the union of the sitemap's directly-addressable pages and llms.txt's
 * published-.md list (#137).
 *
 * The sitemap serves a branching menu as a trailing-slash category URL (`…/app/`), which
 * has no .md of its own — so sitemap-only discovery silently drops the Directory entry for
 * every branching menu (256 of 1,070 leaves, ~24%, when this was found). Those menus ARE
 * published, as `<dir>.md` (as `<dir>/<basename(dir)>.md` until 2026-10-06), and llms.txt
 * lists them alongside every other .md. Taking the union restores them without guessing at URLs.
 *
 * reconcileTrailingDirs() then asserts the two sources still agree on that shape, so the
 * next inventory change fails the build instead of quietly shrinking the corpus.
 */
async function loadCliRefSlugs(tree: CliRefTree, tocNames: Map<string, string>): Promise<string[]> {
  // The sitemap lists no versioned URLs (0 of 2,306 on 2026-10-20), so for a non-default tree
  // llms.txt is the whole inventory — and the #137 trailing-dir gate has nothing to check. The
  // default tree keeps both even when it is read from /docs/<v>/ (the dedupe case): the sitemap
  // describes the default version, and its slugs are relative to the cli-reference root.
  if (!tree.isDefault) {
    console.log(`Discovery [${tree.label}]: ${tocNames.size} pages from ${tree.docsPrefix}llms.txt (no sitemap for versioned trees)`);
    return [...tocNames.keys()].sort();
  }
  const cacheDir = treeCacheDir(tree);
  const cached = safeCachePath(cacheDir, "_sitemap.txt");
  let xml: string;
  if (FROM_CACHE) {
    try {
      xml = readFileSync(cached, "utf8");
    } catch {
      throw new Error(`--from-cache set but no cached _sitemap.txt at ${cached}`);
    }
  } else {
    const res = await fetch(SITEMAP_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Failed to fetch ${SITEMAP_URL}: HTTP ${res.status}`);
    xml = await res.text();
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cached, xml);
  }
  const locs = parseSitemapLocs(xml);
  const sitemap = new Set(locs.map((l) => cliRefSlug(l)).filter((s): s is string => s !== null));
  const discovered = new Set([...sitemap, ...tocNames.keys()]);
  const llmsOnly = [...tocNames.keys()].filter((s) => !sitemap.has(s));
  const sitemapOnly = [...sitemap].filter((s) => !tocNames.has(s));
  console.log(
    `Discovery [${tree.label}]: ${discovered.size} pages = ${sitemap.size} sitemap + ${llmsOnly.length} llms.txt-only` +
      (sitemapOnly.length > 0 ? ` (${sitemapOnly.length} sitemap-only, absent from llms.txt)` : ""),
  );
  reconcileTrailingDirs(locs, discovered);
  return [...discovered].sort();
}

/**
 * Every trailing-slash category URL must contribute its menu's own Directory page, or that
 * menu's entry is being dropped — the #137 defect, which was invisible precisely because it
 * looked like a category page with no source. The page is `app` today (`app/` -> `app.md`)
 * and was `app/app` until 2026-10-06; either shape satisfies the gate.
 *
 * Fails loud on a shape change in either direction: MikroTik publishing a category with no
 * Directory leaf is a real inventory change that must be re-verified by hand, not absorbed.
 */
export function reconcileTrailingDirs(locs: string[], discovered: ReadonlySet<string>): void {
  const orphans: string[] = [];
  for (const loc of locs) {
    let path: string;
    try {
      path = new URL(loc).pathname;
    } catch {
      continue;
    }
    if (!path.startsWith(CLI_PREFIX) || !path.endsWith("/")) continue;
    const dir = path.slice(CLI_PREFIX.length).replace(/\/$/, "");
    if (dir === "" || !CLI_SLUG.test(dir)) continue; // the section root itself
    // The sitemap serves a non-CLI page as a trailing-slash URL too (`compare-versions/`,
    // #194). It is not a menu, so it owns no Directory leaf.
    if (NON_CLI_PAGES.has(dir)) continue;
    if (!discovered.has(dir) && !discovered.has(`${dir}/${dir.split("/").pop()}`)) orphans.push(dir);
  }
  if (orphans.length > 0) {
    throw new Error(
      `Discovery shape drift: ${orphans.length} sitemap category dir(s) have no <dir> or <dir>/<basename> page ` +
        `in the discovered inventory (sitemap ∪ llms.txt) — their Directory entry would be dropped ` +
        `silently (#137). Re-verify the inventory before extracting: ${orphans.slice(0, 10).join(", ")}` +
        (orphans.length > 10 ? `, … (+${orphans.length - 10} more)` : ""),
    );
  }
}

/**
 * llms.txt's published-.md list: slug -> sidebar label. The label is not derivable from the
 * slug ("caps-man" -> "Caps Man"); the key set is also half of discovery (loadCliRefSlugs).
 * Listed NON_CLI_PAGES come back separately, to be checked rather than extracted.
 */
export function parseLlmsToc(llmsTxt: string, cliPrefix = CLI_PREFIX): { names: Map<string, string>; nonCliPages: string[] } {
  const names = new Map<string, string>();
  const nonCliPages: string[] = [];
  for (const m of llmsTxt.matchAll(/^- \[([^\]]*)\]\((https:\/\/[^)]*)\)/gm)) {
    const url = m[2].replace(/\.md$/, "");
    const slug = cliRefSlug(url, cliPrefix);
    if (slug !== null) names.set(slug, m[1]);
    const nonCli = nonCliPageSlug(url, cliPrefix);
    if (nonCli !== null) nonCliPages.push(nonCli);
  }
  return { names, nonCliPages };
}

async function fetchPage(tree: CliRefTree, slug: string): Promise<string | null> {
  const cacheDir = treeCacheDir(tree);
  const file = safeCachePath(cacheDir, cacheName(slug));
  if (FROM_CACHE) {
    // Read directly (try/catch) rather than existsSync-then-read, closing the check-then-use
    // race CodeQL flags.
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }
  // A live run never reads the cache (#160): every page is re-fetched and its cache file
  // overwritten. A reused July copy of routing__route.md once kept a section MikroTik had
  // since removed, so a "live" local build disagreed with CI's empty-cache build (#159).
  const res = await fetch(`${BASE}${treeCliPrefix(tree)}${slug}.md`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const body = await res.text();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, body);
  await Bun.sleep(FETCH_DELAY_MS);
  return body;
}

/**
 * The tree's landing page, /docs/[<v>/]cli-reference.md (#193), cached as `_landing.md`. Every
 * served tree has one; a tree that does not serve it is incomplete, so this throws rather
 * than storing a tree without its standard properties.
 */
async function fetchLanding(tree: CliRefTree): Promise<string> {
  const cacheDir = treeCacheDir(tree);
  const file = safeCachePath(cacheDir, "_landing.md");
  if (FROM_CACHE) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      throw new Error(`--from-cache set but no cached landing page at ${file} — run one live extract first (#193)`);
    }
  }
  const url = `${BASE}${tree.docsPrefix}cli-reference.md`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`[${tree.label}] Failed to fetch ${url}: HTTP ${res.status} — the tree is served without its landing page (#193)`);
  const body = await res.text();
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(file, body);
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
 * Split off the preamble (title / blurb / import lines / `---` rule). The body's own
 * headings are command paths, so the page-title h1 must not be walked as one — the
 * title of `app.md` is `# app`. Returns the body plus the 1-based source line the body
 * starts on (for absolute line attribution).
 *
 * Two preamble shapes have been served: MDX source with `import {…}` lines and an empty
 * `> -----------` blurb (until 2026-10-06), and rendered Markdown with a real
 * `> RouterOS directory reference for /…` blurb and no imports (since). Skipping the
 * leading title, blurb, import, blank and rule lines covers both.
 */
function splitPreamble(md: string): { title: string | null; body: string; bodyStartLine: number } {
  const lines = md.split("\n");
  let start = 0;
  let title: string | null = null;
  if (lines[0]?.startsWith("# ")) {
    title = lines[0].slice(2).trim();
    start = 1;
  }
  while (start < lines.length && /^(?:\s*|>.*|import\s*\{.*|-{3,}\s*)$/.test(lines[start])) {
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
  // The attribute list runs to the first `>` that is NOT inside a quoted value — a `typ`
  // like `iface_enum { <l2tp>:0xfffffffe }` embeds a literal `>`, so a naive `[^>]` / `.*?>`
  // stops mid-tag and truncates the attributes. `(?:[^">]|"[^"]*")*` consumes whole quoted
  // runs (including embedded `>` and newlines) so the tag closes on the real `>`.
  for (const m of block.matchAll(/<ArgTableRow\b((?:[^">]|"[^"]*")*)>([\s\S]*?)<\/ArgTableRow>/g)) {
    const attrs = m[1];
    const attr = (n: string) => attrs.match(new RegExp(`\\b${n}="([\\s\\S]*?)"`))?.[1] ?? null;
    // 1-based source line of this row = block start + newlines before the match.
    const rowLine = blockStartLine + block.slice(0, m.index).split("\n").length - 1;
    // Required attributes fail loud like every other structural anomaly in this parser;
    // a missing arg/typ would otherwise become an anonymous field/flag that the aggregate
    // count-reconciliation cannot catch.
    const requireAttr = (n: string) => {
      const v = attr(n);
      if (v === null) throw new Error(`${slug}: ArgTableRow missing "${n}" attribute at line ${rowLine}`);
      return v;
    };
    const body = trimBlankLines(decode(m[2]));

    if (kind === "Flag") {
      entry.flags.push({
        flag: decode(requireAttr("arg")),
        name: decode(requireAttr("typ")),
        descriptionMarkdown: body,
        sourceOrder: entry.flags.length,
        sourceLine: rowLine,
      });
    } else if (kind === "Argument" || kind === "Read-only Argument") {
      entry.fields.push({
        fieldKind: kind,
        name: decode(requireAttr("arg")),
        rawType: decode(requireAttr("typ")),
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

export function parsePage(slug: string, md: string, tocName: string, url = `${BASE}${CLI_PREFIX}${slug}`): CliRefPage {
  const { title, body, bodyStartLine } = splitPreamble(md);
  const lines = body.split("\n");
  const entries: CliRefEntry[] = [];
  const parentStack: Array<{ level: number; localId: number }> = [];
  let current: CliRefEntry | null = null;
  const descLines: string[] = [];
  let inFence = false;
  const seenMarkers = new Map<number, Set<string>>();

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
      seenMarkers.set(localId, new Set());
      parentStack.push({ level, localId });
      continue;
    }

    if (!current) continue; // stray content before the first heading (only preamble remnants)

    const field = line.match(/^\*\*(Type|Package|Conditions|Syscap):\*\*\s*(.*)$/);
    if (field) {
      const markers = seenMarkers.get(current.localId);
      if (markers?.has(field[1])) {
        throw new Error(`${slug}: duplicate ${field[1]} marker at line ${sourceLine}`);
      }
      markers?.add(field[1]);
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

  for (const entry of entries) {
    if (!seenMarkers.get(entry.localId)?.has("Type")) {
      throw new Error(`${slug}: entry ${JSON.stringify(entry.sourceHeading)} has no **Type:** marker`);
    }
  }

  return {
    slug,
    url,
    tocName,
    tocGroup: tocGroup(slug),
    sourceTitle: title,
    sourceMarkdown: md,
    sourceSha256: new Bun.CryptoHasher("sha256").update(md).digest("hex"),
    entries,
  };
}

/** Count source structure while ignoring examples inside fenced code blocks. */
export function countStructuralMarkers(md: string): { entries: number; rows: number } {
  let entries = 0;
  let rows = 0;
  let inFence = false;
  for (const line of md.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\*\*Type:\*\*/.test(line)) entries++;
    rows += line.match(/<ArgTableRow\b/g)?.length ?? 0;
  }
  return { entries, rows };
}

// ── Landing page (#193) ──

/**
 * The CLI Reference landing page's fact sections, in page order. Every tree must carry all
 * four; any other `##` section (7.24's "Grafts and Captures", "Headings") is kept only as raw
 * source. Each section's rows have exactly one shape, so anything else in a row position
 * fails extraction instead of being skipped.
 */
export const LANDING_SECTIONS = [
  "Argument types",
  "Standard list entry properties",
  "Standard print modifiers",
  "address-flags",
] as const;

export type LandingSection = (typeof LANDING_SECTIONS)[number];

export interface LandingRow {
  section: LandingSection;
  name: string;
  descriptionMarkdown: string;
  sourceOrder: number;
  sourceLine: number;
}

// `- **name** — text` (Argument types) or `- **`name`** — text` (the two standard-name lists).
const LANDING_BULLET = /^- \*\*(`?)([^*`]+)\1\*\* — (.+)$/;
// `| <flag> | <meaning> |`; a flag may be backslash-escaped (`\+`).
const FLAG_ROW = /^\|\s*(\\?\S)\s*\|\s*(.+?)\s*\|\s*$/;

/**
 * Parse the landing page's four fact sections. Throws when a section is missing or
 * duplicated, when a bullet or table row in one of them does not match its shape, when a
 * name repeats within a section, or when a section yields no rows. Prose lines between the
 * rows (intros, the "Argument types can be nested" note) are not rows and are left in the
 * raw source.
 */
export function parseLandingPage(md: string): LandingRow[] {
  const rows: LandingRow[] = [];
  const seen = new Map<LandingSection, Set<string>>();
  let section: LandingSection | null = null;
  let inFence = false;
  let tableHeader = false;
  const fail = (line: number, why: string): never => {
    throw new Error(`cli-reference landing page line ${line}: ${why} (#193)`);
  };
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sourceLine = i + 1;
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^## (.+?)\s*$/.exec(line);
    if (heading) {
      const name = heading[1];
      section = (LANDING_SECTIONS as readonly string[]).includes(name) ? (name as LandingSection) : null;
      if (section !== null) {
        if (seen.has(section)) fail(sourceLine, `section "${section}" appears twice`);
        seen.set(section, new Set());
      }
      tableHeader = false;
      continue;
    }
    if (section === null) continue;
    const names = seen.get(section) as Set<string>;
    const push = (name: string, descriptionMarkdown: string) => {
      if (names.has(name)) fail(sourceLine, `"${name}" repeats in "${section}"`);
      names.add(name);
      rows.push({ section: section as LandingSection, name, descriptionMarkdown, sourceOrder: names.size - 1, sourceLine });
    };
    if (section === "address-flags") {
      if (!line.startsWith("|")) continue;
      if (!tableHeader) {
        if (!/^\|\s*Flag\s*\|\s*Meaning\s*\|\s*$/.test(line)) fail(sourceLine, `address-flags table header is not "| Flag | Meaning |"`);
        tableHeader = true;
        continue;
      }
      if (/^\|[\s:|-]+\|\s*$/.test(line)) continue; // the |---|---| separator
      const m = FLAG_ROW.exec(line);
      if (!m) fail(sourceLine, `address-flags row does not match "| flag | meaning |": ${JSON.stringify(line)}`);
      push((m as RegExpExecArray)[1].replace(/^\\/, ""), (m as RegExpExecArray)[2]);
      continue;
    }
    if (!line.startsWith("- ")) continue;
    const m = LANDING_BULLET.exec(line);
    if (!m) fail(sourceLine, `bullet in "${section}" does not match "- **name** — description": ${JSON.stringify(line)}`);
    push((m as RegExpExecArray)[2], (m as RegExpExecArray)[3]);
  }
  for (const s of LANDING_SECTIONS) {
    if (!seen.has(s)) fail(lines.length, `section "${s}" is missing`);
    if ((seen.get(s) as Set<string>).size === 0) fail(lines.length, `section "${s}" has no rows`);
  }
  return rows;
}

// ── cli-compare.json reconciliation (#188) ──

/**
 * Names cli-compare.json lists that are not CLI pages. `Headings` is a `##` section of the
 * 7.24 landing page that MikroTik's generator counted as a command (gone from 7.25 on).
 */
export const CLI_COMPARE_ARTIFACTS: ReadonlySet<string> = new Set(["Headings"]);

/** One disagreement: `only_in` names the side that has the item the other lacks. */
export interface ReconcileRow {
  pair: string;
  kind: "command-added" | "command-removed" | "param-added" | "param-removed" | "flag-added" | "flag-removed";
  path: string;
  name: string;
  only_in: "rosetta" | "cli-compare";
}

/** Page slug -> the field names and print-flag letters of all its entries. */
function pageVocabulary(pages: CliRefPage[]): Map<string, { params: Set<string>; flags: Set<string> }> {
  const out = new Map<string, { params: Set<string>; flags: Set<string> }>();
  for (const p of pages) {
    const v = { params: new Set<string>(), flags: new Set<string>() };
    for (const e of p.entries) {
      for (const f of e.fields) v.params.add(f.name);
      for (const fl of e.flags) v.flags.add(fl.flag);
    }
    out.set(p.slug, v);
  }
  return out;
}

const minus = (a: Iterable<string>, b: ReadonlySet<string>) => [...a].filter((x) => !b.has(x));

/**
 * Compare each cli-compare.json pair with the same diff computed from rosetta's own rows, as
 * sets, never counts: a page's params are the field names of all its entries, its flags the
 * print-flag letters. Pairs naming a tree this run did not extract are skipped. An empty
 * result means the two agree exactly.
 */
export function reconcileCliCompare(treePages: ReadonlyMap<string, CliRefPage[]>, compare: CliCompare): ReconcileRow[] {
  const rows: ReconcileRow[] = [];
  for (const [pair, theirs] of Object.entries(compare.pairs)) {
    const [from, to] = pair.split("->");
    const a = treePages.get(from);
    const b = treePages.get(to);
    if (a === undefined || b === undefined) continue;
    const va = pageVocabulary(a);
    const vb = pageVocabulary(b);
    const push = (kind: ReconcileRow["kind"], path: string, name: string, onlyIn: ReconcileRow["only_in"]) =>
      rows.push({ pair, kind, path, name, only_in: onlyIn });

    const ourAdded = new Set(minus(vb.keys(), new Set(va.keys())));
    const ourRemoved = new Set(minus(va.keys(), new Set(vb.keys())));
    const theirAdded = new Set(minus(theirs.addedCommands, CLI_COMPARE_ARTIFACTS));
    const theirRemoved = new Set(minus(theirs.removedCommands, CLI_COMPARE_ARTIFACTS));
    for (const x of minus(ourAdded, theirAdded)) push("command-added", x, "", "rosetta");
    for (const x of minus(theirAdded, ourAdded)) push("command-added", x, "", "cli-compare");
    for (const x of minus(ourRemoved, theirRemoved)) push("command-removed", x, "", "rosetta");
    for (const x of minus(theirRemoved, ourRemoved)) push("command-removed", x, "", "cli-compare");

    const theirChanged = new Map(theirs.changedCommands.map((c) => [c.path, c]));
    const paths = new Set([...theirChanged.keys(), ...[...va.keys()].filter((k) => vb.has(k))]);
    for (const path of [...paths].sort()) {
      const pa = va.get(path);
      const pb = vb.get(path);
      const ours = {
        "param-added": pa && pb ? minus(pb.params, pa.params) : [],
        "param-removed": pa && pb ? minus(pa.params, pb.params) : [],
        "flag-added": pa && pb ? minus(pb.flags, pa.flags) : [],
        "flag-removed": pa && pb ? minus(pa.flags, pb.flags) : [],
      };
      const c = theirChanged.get(path);
      const their = {
        "param-added": c?.added.params ?? [],
        "param-removed": c?.removed.params ?? [],
        "flag-added": c?.added.flags ?? [],
        "flag-removed": c?.removed.flags ?? [],
      };
      for (const kind of ["param-added", "param-removed", "flag-added", "flag-removed"] as const) {
        const o = new Set(ours[kind]);
        const t = new Set(their[kind]);
        for (const x of minus(o, t)) push(kind, path, x, "rosetta");
        for (const x of minus(t, o)) push(kind, path, x, "cli-compare");
      }
    }
  }
  return rows;
}

/** The reconciliation as TSV; the header is always written, so an empty report is one line. */
export function reconcileTsv(rows: ReconcileRow[]): string {
  const cols = ["pair", "kind", "path", "name", "only_in"] as const;
  return [cols.join("\t"), ...rows.map((r) => cols.map((c) => r[c]).join("\t")), ""].join("\n");
}

/**
 * Per tree, the reconcile rows of every compared pair that names it; null when no pair
 * naming it was compared. A pair's rows count against both of its trees, because a
 * disagreement can't say which side is wrong. Stored on cliref_trees for the export (#188).
 */
export function treeMismatchCounts(
  rows: ReconcileRow[],
  compare: CliCompare | null,
  extracted: readonly string[],
): Map<string, number | null> {
  const out = new Map<string, number | null>(extracted.map((v) => [v, null]));
  if (compare === null) return out;
  for (const pair of Object.keys(compare.pairs)) {
    const [from, to] = pair.split("->");
    if (!out.has(from) || !out.has(to)) continue;
    const n = rows.filter((r) => r.pair === pair).length;
    for (const v of [from, to]) out.set(v, (out.get(v) ?? 0) + n);
  }
  return out;
}

/**
 * Report, never fail (maintainer decision on #188, 2026-10-21): write the TSV, log per-pair
 * counts, and add them to the GitHub job summary. release.yml turns a non-empty report into
 * a tracking issue, so a mismatch reaches a person instead of a log.
 */
function reportReconciliation(rows: ReconcileRow[], compare: CliCompare, extracted: ReadonlySet<string>): void {
  mkdirSync(resolve(RECONCILE_REPORT, ".."), { recursive: true });
  writeFileSync(RECONCILE_REPORT, reconcileTsv(rows));
  const lines: string[] = [];
  for (const pair of Object.keys(compare.pairs)) {
    const [from, to] = pair.split("->");
    if (!extracted.has(from) || !extracted.has(to)) {
      lines.push(`| ${pair} | not compared (tree not extracted) |`);
      continue;
    }
    const n = rows.filter((r) => r.pair === pair).length;
    lines.push(`| ${pair} | ${n === 0 ? "agrees" : `${n} mismatch(es)`} |`);
  }
  console.log(`cli-compare.json reconciliation: ${rows.length} mismatch(es) -> ${RECONCILE_REPORT}`);
  for (const l of lines) console.log(`  ${l}`);
  if (rows.length > 0) console.log(`::warning::CLI Reference disagrees with cli-compare.json in ${rows.length} place(s); see ${RECONCILE_REPORT}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    appendFileSync(summary, `### CLI Reference vs cli-compare.json\n\n| Pair | Result |\n|---|---|\n${lines.join("\n")}\n\n`);
  }
}

// ── Storage ──

interface TreeResult {
  tree: CliRefTree;
  pages: CliRefPage[];
  landingMarkdown: string;
  landingRows: LandingRow[];
  /** Cache filenames (relative to the tree's dir) a complete live run keeps. */
  keep: string[];
}

function store(results: TreeResult[], mismatches: ReadonlyMap<string, number | null>): void {
  const insTree = db.prepare(
    `INSERT INTO cliref_trees (manual_version, base_url, is_default, fetched_at, retained, llms_txt, llms_sha256, landing_markdown, landing_sha256, cli_compare_mismatches)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
  );
  const insStandard = db.prepare(
    `INSERT INTO cliref_standard (manual_version, section, name, description_markdown, source_order, source_line)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insPage = db.prepare(
    `INSERT INTO cliref_pages (manual_version, slug, url, toc_name, toc_group, source_title, source_markdown, source_sha256, source_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
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
    for (const { tree, pages, landingMarkdown, landingRows } of results) {
      insTree.run(
        tree.label,
        `${BASE}${tree.docsPrefix}`,
        tree.isDefault ? 1 : 0,
        tree.fetchedAt,
        tree.llmsTxt,
        new Bun.CryptoHasher("sha256").update(tree.llmsTxt).digest("hex"),
        landingMarkdown,
        new Bun.CryptoHasher("sha256").update(landingMarkdown).digest("hex"),
        mismatches.get(tree.label) ?? null,
      );
      for (const r of landingRows) {
        insStandard.run(tree.label, r.section, r.name, r.descriptionMarkdown, r.sourceOrder, r.sourceLine);
      }
      let pageOrder = 0;
      for (const page of pages) {
        const { id: pageId } = insPage.get(
          tree.label,
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
    }
  })();
}

// ── Main ──

/** Discover, fetch and parse one tree, with every per-tree completeness gate. */
async function extractTree(tree: CliRefTree): Promise<TreeResult> {
  const cacheDir = treeCacheDir(tree);
  if (!FROM_CACHE) {
    // The tree's index files, written before any page so --from-cache can rebuild the run.
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(safeCachePath(cacheDir, "_llms.txt"), tree.llmsTxt);
    const { llmsTxt: _omit, ...meta } = tree;
    writeFileSync(safeCachePath(cacheDir, "_tree.json"), `${JSON.stringify(meta, null, 2)}\n`);
  }
  const cliPrefix = treeCliPrefix(tree);
  const { names: tocNames, nonCliPages } = parseLlmsToc(tree.llmsTxt, cliPrefix);
  let slugs = await loadCliRefSlugs(tree, tocNames);
  if (LIMIT !== undefined) slugs = slugs.slice(0, LIMIT);

  const pages: CliRefPage[] = [];
  const missing: string[] = [];
  for (const slug of slugs) {
    const md = await fetchPage(tree, slug);
    if (md === null) {
      missing.push(slug);
      continue;
    }
    const tocName = tocNames.get(slug);
    if (tocName === undefined) throw new Error(`[${tree.label}] No llms.txt toc_name for slug ${JSON.stringify(slug)}`);
    pages.push(parsePage(slug, md, tocName, `${BASE}${cliPrefix}${slug}`));
  }

  // Listed non-CLI pages are fetched (and cached, for --from-cache) only to prove they still
  // are. A missing one is fine: nothing would have been extracted from it anyway.
  const checkedNonCli: string[] = [];
  for (const slug of nonCliPages) {
    const md = await fetchPage(tree, slug);
    if (md === null) continue;
    assertNonCliPage(slug, md);
    checkedNonCli.push(slug);
  }
  if (checkedNonCli.length > 0) console.log(`[${tree.label}] Non-CLI pages checked (no **Type:** entries): ${checkedNonCli.join(", ")}`);

  const entries = pages.flatMap((p) => p.entries);
  const fields = entries.flatMap((e) => e.fields);
  const flags = entries.flatMap((e) => e.flags);
  console.log(
    `[${tree.label}${tree.isDefault ? ", default" : ""}] Parsed ${pages.length} pages -> ${entries.length} entries, ${fields.length} fields, ${flags.length} flags`,
  );
  if (missing.length > 0) {
    // In a full live run, a missing .md is a fetch failure that would silently ship a
    // partial overlay (the count asserts below only see fetched pages). Fail hard: a tree
    // that is served but incomplete is broken (#188). --limit is intentionally partial. A
    // full cached run is expected to be complete: the cached index supplies the inventory.
    const msg = `[${tree.label}] Missing (no .md): ${missing.join(", ")}`;
    if (LIMIT === undefined) {
      throw new Error(`${msg}\nRefusing to store a partial overlay from a full run.`);
    }
    console.log(msg);
  }

  // Crash-early: parsed structure must reconcile with the raw source markers, per tree.
  const markerCounts = pages.map((p) => countStructuralMarkers(p.sourceMarkdown));
  const rawTypeMarkers = markerCounts.reduce((sum, c) => sum + c.entries, 0);
  const rawRows = markerCounts.reduce((sum, c) => sum + c.rows, 0);
  if (rawTypeMarkers !== entries.length) {
    throw new Error(`[${tree.label}] entry drift: ${rawTypeMarkers} **Type:** markers, ${entries.length} entries parsed`);
  }
  if (rawRows !== fields.length + flags.length) {
    throw new Error(
      `[${tree.label}] row drift: ${rawRows} <ArgTableRow> in source, ${fields.length + flags.length} fields+flags parsed`,
    );
  }
  if (CHECK_COUNTS) console.log(`[${tree.label}] Count check OK: ${rawTypeMarkers} entries, ${rawRows} field+flag rows`);

  const landingMarkdown = await fetchLanding(tree);
  const landingRows = parseLandingPage(landingMarkdown);
  const perSection = LANDING_SECTIONS.map((sec) => `${landingRows.filter((r) => r.section === sec).length} ${sec}`).join(", ");
  console.log(`[${tree.label}] Landing page: ${perSection}`);
  return { tree, pages, landingMarkdown, landingRows, keep: ["_landing.md", ...[...slugs, ...checkedNonCli].map(cacheName)] };
}

async function main(): Promise<void> {
  let trees: CliRefTree[];
  let compare: CliCompare | null;
  if (FROM_CACHE) {
    console.log(`Discovering trees from cache: ${CACHE_DIR}`);
    ({ trees, compare } = readCachedTrees());
  } else {
    let compareText: string | null;
    ({ trees, compare, compareText } = await resolveTreesLive());
    mkdirSync(CACHE_DIR, { recursive: true });
    const comparePath = safeCachePath(CACHE_DIR, "_cli-compare.json");
    if (compareText !== null) writeFileSync(comparePath, compareText);
    else rmSync(comparePath, { force: true });
  }
  const defaultTree = trees.find((t) => t.isDefault);
  if (defaultTree === undefined) throw new Error("no default tree resolved");
  console.log(`Manual trees: ${trees.map((t) => `${t.label}${t.isDefault ? " (default)" : ""} from ${t.docsPrefix}`).join(", ")}`);

  const results: TreeResult[] = [];
  for (const tree of trees) results.push(await extractTree(tree));

  const treePages = new Map(results.map((r) => [r.tree.label, r.pages]));
  const reconciled = compare === null ? [] : reconcileCliCompare(treePages, compare);
  if (compare !== null) reportReconciliation(reconciled, compare, new Set(treePages.keys()));
  const mismatches = treeMismatchCounts(reconciled, compare, [...treePages.keys()]);

  initDb();
  // extract-docusaurus runs first in both `make extract` and release.yml, and reads the
  // default tree; a disagreeing stamp means the prose and the overlay's default tree would
  // describe different manuals (#187).
  const mismatch = manualVersionMismatch(
    { key: CLIREF_MANUAL_VERSION_KEY, version: defaultTree.label },
    { key: DOCS_MANUAL_VERSION_KEY, version: getDbMeta(DOCS_MANUAL_VERSION_KEY) },
  );
  if (mismatch !== null) throw new Error(mismatch);
  db.run("DELETE FROM cliref_entry_schema_links;");
  db.run("DELETE FROM cliref_flags;");
  db.run("DELETE FROM cliref_fields;");
  db.run("DELETE FROM cliref_entries;");
  db.run("DELETE FROM cliref_pages;");
  db.run("DELETE FROM cliref_standard;");
  db.run("DELETE FROM cliref_trees;");
  store(results, mismatches);
  setDbMeta(CLIREF_MANUAL_VERSION_KEY, defaultTree.label);
  console.log(`Stored ${results.length} tree(s) into ${process.env.DB_PATH ?? "ros-help.db"}`);

  // The cache is a record of the last complete live run, so --from-cache reproduces it.
  // A full live run that got here fetched every discovered page of every tree (a missing one
  // threw above); a --limit run is partial on purpose and must not prune what it skipped.
  // A tree dir from an earlier run that this run did not extract is removed whole, so a
  // cached rebuild cannot resurrect a tree the site no longer serves.
  if (!FROM_CACHE) {
    if (LIMIT !== undefined) {
      console.log("Cache not pruned: a --limit run is partial");
      return;
    }
    const current = new Set(trees.map((t) => t.label));
    for (const d of readdirSync(CACHE_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && TREE_LABEL.test(d.name) && !current.has(d.name)) {
        rmSync(safeCachePath(CACHE_DIR, d.name), { recursive: true, force: true });
        console.log(`Removed cached tree ${d.name}: not served this run`);
      }
    }
    pruneCache(CACHE_DIR, results.flatMap((r) => r.keep.map((name) => `${r.tree.label}/${name}`)), ".md");
  }
}

if (import.meta.main) {
  await main();
}
