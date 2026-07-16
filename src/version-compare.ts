/**
 * version-compare.ts — RouterOS version ordering, as a PURE module.
 *
 * Deliberately dependency-free: no `bun:sqlite`, no `db.ts`, no `paths.ts`. It was
 * split out of `query.ts` so that `src/export.ts` (whose entire premise is a DB-only
 * audit surface) can order versions without transitively importing the DB singleton.
 * Keep it that way — adding an import here re-couples every DB-only consumer.
 *
 * KNOWN LIMITATION: the prerelease *number* is not yet part of the order, so
 * `7.24beta1`, `7.24beta2`, `7.24beta3` compare equal (likewise `7.20rc1` vs
 * `7.20rc2`). Callers that sort changelog/command rows fall back to a secondary key,
 * so output stays deterministic, but it is not fully version-ordered across
 * prereleases of the same base. Tracked for a shared-comparator fix in issue #104;
 * fixing it here improves every caller at once.
 */

/** Compare two RouterOS version strings: negative if a<b, positive if a>b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const normalize = (v: string) => {
    const beta = v.includes("beta");
    const rc = v.includes("rc");
    const clean = v.replace(/beta\d*/, "").replace(/rc\d*/, "");
    const parts = clean.split(".").map(Number);
    // beta < rc < release for the same numeric version
    const suffix = beta ? 0 : rc ? 1 : 2;
    return { parts, suffix };
  };
  const na = normalize(a);
  const nb = normalize(b);
  for (let i = 0; i < Math.max(na.parts.length, nb.parts.length); i++) {
    const pa = na.parts[i] ?? 0;
    const pb = nb.parts[i] ?? 0;
    if (pa !== pb) return pa - pb;
  }
  return na.suffix - nb.suffix;
}
