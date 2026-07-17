/**
 * version-compare.ts — RouterOS version ordering, as a PURE module.
 *
 * Deliberately dependency-free: no `bun:sqlite`, no `db.ts`, no `paths.ts`. It was
 * split out of `query.ts` so that `src/export.ts` (whose entire premise is a DB-only
 * audit surface) can order versions without transitively importing the DB singleton.
 * Keep it that way — adding an import here re-couples every DB-only consumer.
 *
 * Ordering for one base version: `beta` < `rc` < final release, and within a
 * prerelease channel the number breaks the tie (`7.24beta1` < `7.24beta2` <
 * `7.24rc1` < `7.24`). A channel marker with no number (`beta`, `rc`) sorts as N=0,
 * i.e. below its numbered siblings. Callers no longer need a secondary sort key to
 * disambiguate same-base prereleases (though several keep one for stable ties on
 * equal versions, which is fine).
 */

/** Compare two RouterOS version strings: negative if a<b, positive if a>b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const normalize = (v: string) => {
    const betaMatch = v.match(/beta(\d*)/);
    const rcMatch = v.match(/rc(\d*)/);
    const clean = v.replace(/beta\d*/, "").replace(/rc\d*/, "");
    const parts = clean.split(".").map(Number);
    // beta < rc < release for the same numeric version
    const suffix = betaMatch ? 0 : rcMatch ? 1 : 2;
    // within a prerelease channel, a higher number is newer (beta1 < beta2)
    const pre = Number((betaMatch ?? rcMatch)?.[1] || 0);
    return { parts, suffix, pre };
  };
  const na = normalize(a);
  const nb = normalize(b);
  for (let i = 0; i < Math.max(na.parts.length, nb.parts.length); i++) {
    const pa = na.parts[i] ?? 0;
    const pb = nb.parts[i] ?? 0;
    if (pa !== pb) return pa - pb;
  }
  if (na.suffix !== nb.suffix) return na.suffix - nb.suffix;
  return na.pre - nb.pre;
}
