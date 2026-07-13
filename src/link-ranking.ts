/**
 * link-ranking.ts — Pure ranking helpers for link-commands.ts: decide which
 * documentation page a RouterOS command path most authoritatively belongs to.
 *
 * No DB, no I/O — imported by link-commands.ts and unit-tested directly
 * (link-ranking.test.ts). The rule: a page is authoritative for a command only
 * if its own slug/breadcrumb *trails* the command path (e.g. `/ip/firewall/filter`
 * ⇒ `.../firewall/filter`), not merely because it mentions the path in an example.
 */

/** Segment similarity: exact match beats a prefix relationship (`dhcp-server` ↔ `dhcp`). */
export function segMatch(a: string, b: string): number {
  if (a === b) return 3;
  // Prefix relationship handles doc-vs-menu naming drift, e.g. /ip/dhcp-server <-> docs/.../dhcp.
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return 2;
  return 0;
}

/**
 * A page's identity segments: the tail of its `/docs/` slug (Docusaurus), or the
 * breadcrumb path (HTML-corpus fallback). e.g. `.../firewall/filter` -> `["firewall","filter"]`.
 */
export function pageIdentitySegs(url: string | null | undefined, breadcrumb = ""): string[] {
  const m = url?.match(/\/docs\/(.+?)\/?$/);
  if (m) return m[1].split("/").filter(Boolean);
  return breadcrumb
    .split(">")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== "docs");
}

/**
 * Contiguous trailing-segment match anchored at the command leaf. `/ip/firewall/filter`
 * against `docs/firewall-and-quality-of-service/firewall/filter` matches `filter` then
 * `firewall` (depth 6) before the top-level `ip` diverges; an unrelated page scores 0.
 *
 * A page with **no** trailing alignment scores 0 regardless of how many properties it
 * has — otherwise a property-rich but unrelated page (e.g. bridging-and-switching) would
 * win `/ip`. Path alignment dominates; property count only tie-breaks among aligned pages.
 */
export function scoreCandidate(cmdSegs: string[], pageSegs: string[], propCount: number): number {
  let depth = 0;
  for (let i = 1; i <= Math.min(cmdSegs.length, pageSegs.length); i++) {
    const m = segMatch(cmdSegs[cmdSegs.length - i], pageSegs[pageSegs.length - i]);
    if (m === 0) break;
    depth += m;
  }
  if (depth === 0) return 0;
  return depth * 1000 + Math.min(propCount, 999);
}

export type PageCandidate = { id: number; segs: string[]; propCount: number };

/**
 * Pick the most authoritative page id for a command path, or `null` when no candidate
 * aligns. A null result means the command is left unlinked — an honest low-confidence
 * fallback in lookupProperty beats a high-confidence link to the wrong page.
 */
export function pickBestPageId(cmdPath: string, candidates: PageCandidate[]): number | null {
  const cmdSegs = cmdPath.split("/").filter(Boolean);
  let bestId: number | null = null;
  let best = 0;
  for (const c of candidates) {
    const s = scoreCandidate(cmdSegs, c.segs, c.propCount);
    if (s > best) {
      best = s;
      bestId = c.id;
    }
  }
  return bestId;
}
