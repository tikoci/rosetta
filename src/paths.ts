/**
 * paths.ts — Shared DB path resolution for all entry points, plus the
 * committed data-snapshot paths that several extractors must agree on.
 *
 * Three modes:
 *   1. Compiled binary (IS_COMPILED) → next to executable
 *   2. Dev mode (.git exists in project root) → project root
 *   3. Package mode (bunx / bun add -g) → ~/.rosetta/
 *
 * DB_PATH env var overrides all modes.
 * This module must NOT import db.ts or bun:sqlite — it's used before the DB is opened.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

declare const IS_COMPILED: boolean;
declare const VERSION: string;

/** True when running as a compiled binary (bun build --compile) */
export function isCompiled(): boolean {
  try {
    return typeof IS_COMPILED !== "undefined" && IS_COMPILED;
  } catch {
    return false;
  }
}

/** True when running from a git checkout (dev mode) */
function isDevMode(projectRoot: string): boolean {
  return existsSync(path.join(projectRoot, ".git"));
}

/**
 * Resolve the directory where ros-help.db should live.
 * - Compiled: directory containing the executable
 * - Dev: project root (one level up from src/)
 * - Package (bunx / global install): ~/.rosetta/
 */
export function resolveBaseDir(srcDir: string): string {
  if (isCompiled()) {
    return path.dirname(process.execPath);
  }

  const projectRoot = path.resolve(srcDir, "..");
  if (isDevMode(projectRoot)) {
    return projectRoot;
  }

  // Package mode — stable user-local directory
  const dataDir = path.join(homedir(), ".rosetta");
  mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

/**
 * Resolve the full path to ros-help.db.
 * Priority: DB_PATH env var → --db CLI flag → auto-detect.
 */
export function resolveDbPath(srcDir: string): string {
  const envPath = process.env.DB_PATH?.trim();
  if (envPath) return envPath;

  // --db flag parsed at init time so ESM static imports don't race it
  const dbArgIdx = process.argv.indexOf("--db");
  if (dbArgIdx !== -1 && process.argv[dbArgIdx + 1]) {
    return process.argv[dbArgIdx + 1];
  }

  return path.join(resolveBaseDir(srcDir), "ros-help.db");
}

/** Detect invocation mode: "compiled" | "dev" | "package" */
export type InvocationMode = "compiled" | "dev" | "package";

export function detectMode(srcDir: string): InvocationMode {
  if (isCompiled()) return "compiled";
  const projectRoot = path.resolve(srcDir, "..");
  if (isDevMode(projectRoot)) return "dev";
  return "package";
}

/** True when the invocation is a git checkout (dev mode). Keeps the "dev" mode
 *  policy comparison in one place so callers don't hard-code the literal. */
export function isDevInvocation(mode: InvocationMode): boolean {
  return mode === "dev";
}

/**
 * Current product-matrix snapshot, relative to the project root.
 *
 * Snapshots are date-stamped and committed under `matrix/` (see `matrix/CLAUDE.md`).
 * Five entry points read this file — extract-devices, extract-hardware-catalog,
 * build-device-map, assess-hardware, assess-www — and they must all read the *same*
 * snapshot, or the `devices` table and the hardware overlay silently describe
 * different product sets. Bump this one constant when committing a new
 * `matrix/YYYY-MM-DD/` directory; committing the directory alone is a no-op.
 */
export const MATRIX_CSV_RELATIVE_PATH = "matrix/2026-07-20/matrix.csv";

/**
 * Schema version for ros-help.db.
 * Increment when making destructive schema changes (DROP/RENAME table or column).
 * Stamped into the DB via `PRAGMA user_version` by initDb() and checked at MCP
 * startup to detect stale DBs for bunx users who auto-update the package.
 *
 * Bump history:
 *   v5 — added `db_meta` key/value table for release-tag provenance and
 *        atomic-download / version-pinned-URL update flow (2026-04-21).
 *   v6 — added `pages.rosetta_id` (TEXT, unique-when-not-null) for
 *        Docusaurus-sourced pages extracted by extract-docusaurus.ts; legacy
 *        Confluence-sourced rows keep NULL (2026-07-07, T-0035).
 *   v7 — added `hardware_catalog` + `device_aliases` tables (B-0017 Track A,
 *        issue #35): the full /hardware + www.mikrotik.com device universe,
 *        superset of `devices` (which is untouched), with an optional link
 *        back for the rows matrix.csv also tracks.
 *   v8 — hardware_catalog gains a `name` column and renames `devices_id` ->
 *        `device_id` (matching device_test_results.device_id); adds the
 *        `device_overview` VIEW as the documented catalog read surface
 *        (B-0017 Phase 1.5, PR #36 design review). v7 never shipped in a
 *        release, so initDb() drops the pre-rename tables and the extractor
 *        rebuilds them.
 *   v9 — `properties` drops UNIQUE(page_id, name, section) and gains
 *        `section_id`; `callouts` gains `section_id` (issue #90). The UNIQUE
 *        constraint plus INSERT OR IGNORE silently destroyed 141 distinct
 *        properties — the corpus documents one property name several times
 *        within a single section, so section is not an identity. Measured
 *        corpus-wide, no section-based key reaches zero loss. Extractors now
 *        assert parsed == stored. initDb() rebuilds `properties` in place
 *        (rows kept, section_id NULL) and the extractor repopulates.
 *   v10 — adds normalized `page_tables`, `page_table_rows`, and `page_table_cells`
 *         storage for every Docusaurus pipe table; `properties.source_table_row_id`
 *         links table-derived properties to their exact generic source row (#92).
 */
export const SCHEMA_VERSION = 10;

/**
 * Resolve the version string.
 * Compiled mode: injected at build time via --define.
 * Dev/package mode: read from package.json.
 */
export function resolveVersion(srcDir: string): string {
  try {
    if (typeof VERSION !== "undefined") return VERSION;
  } catch {}
  try {
    const pkgPath = path.join(srcDir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Parse the MAJOR.MINOR.PATCH base of a version string, ignoring a `v` prefix
 * and any prerelease suffix (`-rc.N`, `-beta.N`, `beta2`, …). Returns null when
 * no numeric base is recoverable ("unknown").
 *
 * We deliberately drop the prerelease counter: a dev checkout's package.json
 * routinely reads `0.11.0-rc.0` while the *published* DB it should ground on is
 * `v0.11.0-rc.102`. Comparing rc counters would flag the correct DB as "ahead"
 * on every session. Only the base triple is a meaningful staleness axis.
 */
function parseBaseVersion(v: string): [number, number, number] | null {
  const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 / 0 / 1 comparing the base triples of two version strings. null if either is unparseable. */
function compareBaseVersion(a: string, b: string): number | null {
  const pa = parseBaseVersion(a);
  const pb = parseBaseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export type DbGroundingStatus =
  | "ok"
  | "schema_mismatch"
  | "internal_inconsistent"
  | "provenance_incomplete"
  | "tag_behind"
  | "unstamped";

export type DbGroundingVerdict = {
  status: DbGroundingStatus;
  detail: string;
  /** True only when status === "ok". Convenience for exit codes / boolean gates. */
  ok: boolean;
};

/**
 * Classify whether a resolved DB can be trusted to ground claims about the code
 * that is querying it. Pure — no DB access — so it is shared unchanged by
 * getDbStats (open connection), MCP startup, and the db-doctor CLI (probe).
 *
 * Precedence (first match wins):
 *   1. schema_mismatch       — PRAGMA user_version ≠ code SCHEMA_VERSION. The
 *      on-disk shape is unqueryable by this build; the hard case already forced
 *      a redownload in checkDbFreshness. Terminal signal.
 *   2. internal_inconsistent — db_meta.schema_version ≠ PRAGMA user_version. The
 *      dead giveaway of a DB whose pragma was bumped in place by initDb() over a
 *      stale corpus (the #94 "Frankenstein"): stamped provenance no longer
 *      describes the bytes.
 *   3. unstamped             — neither release_tag nor source_commit. A local
 *      `make extract` working build: fine for extraction, not for grounding
 *      claims about shipped data.
 *   4. provenance_incomplete — claims release identity (has release_tag OR
 *      source_commit) but is missing one of the four stamps a CI release always
 *      writes (release_tag, source_commit, built_at, schema_version). Fail
 *      closed: partial provenance can't be trusted as a grounding source.
 *   5. tag_behind            — release_tag's MAJOR.MINOR.PATCH is behind the
 *      running code's. Content predates this checkout.
 *   6. ok                    — all four stamps present, schema coherent, tag
 *      current (schema/release-compatible with this build — not proof the DB was
 *      built from this exact commit; a release DB is built from an ancestor).
 */
export function classifyDbGrounding(input: {
  pragmaSchema: number;
  metaSchema: number | null;
  releaseTag: string | null;
  builtAt: string | null;
  sourceCommit: string | null;
  codeSchema: number;
  codeVersion: string;
  mode: InvocationMode;
}): DbGroundingVerdict {
  const verdict = (status: DbGroundingStatus, detail: string): DbGroundingVerdict => ({
    status,
    detail,
    ok: status === "ok",
  });

  if (input.pragmaSchema !== input.codeSchema) {
    return verdict(
      "schema_mismatch",
      `DB schema v${input.pragmaSchema} ≠ code schema v${input.codeSchema}; this build cannot query the on-disk shape.`,
    );
  }

  if (input.metaSchema !== null && input.metaSchema !== input.pragmaSchema) {
    return verdict(
      "internal_inconsistent",
      `db_meta.schema_version=${input.metaSchema} disagrees with PRAGMA user_version=${input.pragmaSchema} — the DB was bumped in place over a stale corpus; its provenance no longer describes its contents.`,
    );
  }

  const hasReleaseIdentity = input.releaseTag !== null || input.sourceCommit !== null;
  if (!hasReleaseIdentity) {
    return verdict(
      "unstamped",
      "No release_tag/source_commit — a local extraction build, not a CI release. Fine for extraction work; not a grounding source for claims about shipped data.",
    );
  }

  // Claims release identity — a real CI release stamps all four. Missing any is a
  // malformed/partial artifact: fail closed rather than trust it (built_at is
  // required here, so it is not merely informational).
  if (
    input.releaseTag === null ||
    input.sourceCommit === null ||
    input.builtAt === null ||
    input.metaSchema === null
  ) {
    const missing = [
      input.releaseTag === null ? "release_tag" : null,
      input.sourceCommit === null ? "source_commit" : null,
      input.builtAt === null ? "built_at" : null,
      input.metaSchema === null ? "schema_version" : null,
    ].filter(Boolean).join(", ");
    return verdict(
      "provenance_incomplete",
      `Partial db_meta provenance (missing ${missing}); a CI release stamps all four, so this DB's origin cannot be trusted for grounding.`,
    );
  }

  const cmp = compareBaseVersion(input.releaseTag, `v${input.codeVersion}`);
  if (cmp === null) {
    // All four stamps are present, but the release_tag (or code version) has no
    // parseable MAJOR.MINOR.PATCH, so freshness cannot be verified. Never fall
    // through to "ok" — an unverifiable version is not a grounded one.
    return verdict(
      "provenance_incomplete",
      `Cannot compare DB release ${input.releaseTag} with running code v${input.codeVersion}; version is unparseable, so freshness is unverified.`,
    );
  }
  if (cmp < 0) {
    return verdict(
      "tag_behind",
      `DB release ${input.releaseTag} is behind the running code (v${input.codeVersion}); its content predates this checkout.`,
    );
  }

  return verdict(
    "ok",
    `DB release ${input.releaseTag} (schema v${input.pragmaSchema}) is coherent with this build.`,
  );
}
