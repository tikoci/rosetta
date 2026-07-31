/**
 * menu-paths.ts — extracting RouterOS menu paths from documentation text.
 *
 * Pure and DB-free (the caller supplies the set of known `dir` paths), so both the
 * page linker (`link-commands.ts`) and the command↔prose join census
 * (`eval/command-prose-join.ts`) measure the *same* extraction rather than two copies
 * that drift. See `briefings/B-0024-command-prose-join.md`.
 *
 * Two behaviours here are load-bearing and deliberately preserved from the original
 * inline implementation in `link-commands.ts`, because changing either changes what the
 * linker links:
 *
 * - `MENU_PATH_RE` requires a **second** segment, so a bare top-level menu (`/certificate`,
 *   `/queue`) is never extracted. `extractMenuPaths({ allowTopLevel: true })` opts into
 *   matching those; the linker does not.
 * - `normalizeMenuPath` maps spaces to slashes, so `/certificate/import file-name=x`
 *   becomes the pseudo-path `/certificate/import/file-name`, which is not a menu.
 *   `resolveToDir` walks such a path back to the nearest real `dir` — the same walk
 *   `link-commands.ts` performs when it builds candidate pages.
 */

/** Requires a second segment; `allowTopLevel` swaps in the single-segment variant. */
export const MENU_PATH_RE = /\/[a-z][a-z0-9-]+(?:[/ ][a-z][a-z0-9-]+)+/g;
const MENU_PATH_RE_TOP_LEVEL = /\/[a-z][a-z0-9-]+(?:[/ ][a-z][a-z0-9-]+)*/g;

/** Filesystem-shaped paths that look like menus but never are. */
export const IGNORE_PATHS: ReadonlySet<string> = new Set([
  "/bin/bash", "/bin/sh", "/dev/null", "/usr/bin", "/usr/local",
  "/etc/config", "/tmp/backup", "/var/log", "/proc/sys",
]);

/**
 * Top-level menus accepted even when the DB has no `dir` row for them — the extractor
 * runs before/independently of a complete command tree.
 */
export const TOP_LEVEL_MENUS: readonly string[] = [
  "ip", "ipv6", "interface", "system", "routing", "tool", "queue",
  "ppp", "mpls", "certificate", "user", "snmp", "radius", "log",
  "file", "disk", "container", "iot", "caps-man",
];

/** `/ip firewall filter` → `/ip/firewall/filter`. Also lowercases. */
export function normalizeMenuPath(p: string): string {
  return p.replace(/ /g, "/").toLowerCase();
}

/** Does this path start with a plausible RouterOS top-level menu? */
export function isRouterOsPath(p: string, dirPaths: ReadonlySet<string>): boolean {
  if (IGNORE_PATHS.has(p)) return false;
  const first = p.split("/")[1];
  return dirPaths.has(`/${first}`) || TOP_LEVEL_MENUS.includes(first);
}

/**
 * Walk a path back to the nearest ancestor that is a real `dir`, so a mention of
 * `/certificate/import file-name=` counts as evidence for `/certificate` rather than for
 * a pseudo-path. Returns null when no ancestor is a known menu.
 */
export function resolveToDir(p: string, dirPaths: ReadonlySet<string>): string | null {
  let cur = p;
  while (cur.includes("/", 1)) {
    if (dirPaths.has(cur)) return cur;
    cur = cur.slice(0, cur.lastIndexOf("/"));
  }
  return dirPaths.has(cur) ? cur : null;
}

export type ExtractOptions = {
  /** Match bare top-level menus (`/certificate`). Off by default — see module note. */
  allowTopLevel?: boolean;
  /** Reduce each match to the nearest real `dir` via {@link resolveToDir}. */
  resolve?: boolean;
};

/** Menu paths mentioned across the given texts, de-duplicated. */
export function extractMenuPaths(
  texts: Iterable<string | null | undefined>,
  dirPaths: ReadonlySet<string>,
  opts: ExtractOptions = {},
): Set<string> {
  const re = opts.allowTopLevel ? MENU_PATH_RE_TOP_LEVEL : MENU_PATH_RE;
  const found = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const match of text.matchAll(re)) {
      const normalized = normalizeMenuPath(match[0]);
      if (!isRouterOsPath(normalized, dirPaths)) continue;
      if (!opts.resolve) {
        found.add(normalized);
        continue;
      }
      const dir = resolveToDir(normalized, dirPaths);
      if (dir) found.add(dir);
    }
  }
  return found;
}
