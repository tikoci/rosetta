/**
 * DB-backed verb resolver for {@link canonicalize}.
 *
 * `canonicalize.ts` is intentionally pure — it knows nothing about the DB.
 * This module is the rosetta-side adapter: given a `Database`, it returns
 * an `isVerb(token, parentPath)` function that consults the `commands`
 * table to decide whether a token at a given menu is a verb (`type='cmd'`)
 * or another path segment (`type='dir'`).
 *
 * Why path-aware lookup matters:
 *   /log/info "msg"             ← `info` is a cmd at /log
 *   /interface/wireless/info    ← `info` is a dir at /interface/wireless
 * The pure-module universal-verb-set heuristic can't tell these apart;
 * the DB can.
 *
 * The resolver caches per-call results in-memory — most realistic inputs
 * touch a small number of (token, parentPath) pairs and the cache turns
 * a sub-millisecond SQL query into a hash lookup.
 *
 * Cross-ref: rosetta issue #5 (H4), DESIGN.md "canonicalize: vendoring
 * intent and DB-backed resolver".
 */

import type { Database } from "bun:sqlite";

/**
 * Build an `isVerb` resolver bound to a rosetta DB. Returns a synchronous
 * function suitable for {@link CanonicalizeOptions.isVerb}.
 *
 * The resolver is path-aware: `(token, parentPath) => boolean`. A token
 * counts as a verb if there exists a `commands` row with
 * `name=token`, `parent_path=parentPath`, `type='cmd'`. Returns `false`
 * when no matching row exists (the caller may then treat the token as a
 * path segment).
 */
export function makeDbVerbResolver(
  db: Database,
): (token: string, parentPath: string) => boolean {
  const stmt = db.prepare(
    "SELECT 1 FROM commands WHERE name = ? AND parent_path = ? AND type = 'cmd' LIMIT 1",
  );
  // Per-resolver cache. Lifetime = lifetime of the resolver, which is the
  // lifetime of the process for searchAll's call site. A long-running TUI
  // session benefits; a one-shot CLI invocation pays a single SQL query
  // per unique (token, parentPath) pair regardless.
  const cache = new Map<string, boolean>();

  return (token: string, parentPath: string): boolean => {
    const key = `${parentPath}\x00${token}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const row = stmt.get(token, parentPath);
    const result = row !== null && row !== undefined;
    cache.set(key, result);
    return result;
  };
}
