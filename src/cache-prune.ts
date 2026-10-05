/**
 * cache-prune.ts — keep an extractor's page cache equal to its last live run (#160).
 *
 * A live run re-fetches every page it discovers and overwrites that page's cache file; it
 * never reads the cache. After a *complete* live run (no --limit, no fetch errors) the
 * extractor calls pruneCache() to delete the cached pages that run did not discover — pages
 * upstream has since removed — so a later --from-cache run reproduces that live run exactly.
 */

import { readdirSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Delete every file under `dir` (recursively) whose name ends in `ext` and whose
 * `/`-separated path relative to `dir` is not in `keep`. Returns the deleted relative
 * paths, sorted. Subdirectories the prune leaves empty are removed too.
 *
 * Only `ext` files are candidates. That keeps index files (`_sitemap.txt`, `_llms.txt`)
 * out of reach, and a cache nested under another extractor's cache root — the
 * `manual/pages/hardware/*.html` and `manual/pages/www/*.html` caches sit inside
 * extract-docusaurus's `manual/pages/` root of `*.md` pages.
 */
export function pruneCache(dir: string, keep: Iterable<string>, ext: string): string[] {
  const kept = new Set(keep);
  // A complete live run always discovers pages; an empty set here is a caller bug, and
  // pruning to it would wipe the whole cache.
  if (kept.size === 0) throw new Error(`pruneCache: refusing to prune ${dir} to an empty page set`);
  const removed: string[] = [];
  const walk = (rel: string): void => {
    const abs = rel === "" ? dir : join(dir, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        const before = removed.length;
        walk(path);
        if (removed.length > before && readdirSync(join(dir, path)).length === 0) rmdirSync(join(dir, path));
      } else if (entry.name.endsWith(ext) && !kept.has(path)) {
        rmSync(join(dir, path));
        removed.push(path);
      }
    }
  };
  walk("");
  removed.sort();
  console.log(
    `Pruned ${removed.length} cached page(s) this live run did not discover from ${dir}` +
      (removed.length > 0 ? `: ${removed.slice(0, 10).join(", ")}${removed.length > 10 ? ", …" : ""}` : ""),
  );
  return removed;
}
