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
 * A page's identity segments: the tail of a Docusaurus `/docs/` slug, or the
 * breadcrumb path (HTML-corpus fallback). e.g. `.../firewall/filter` -> `["firewall","filter"]`.
 *
 * Only manual.mikrotik.com URLs carry a semantic doc slug. The legacy Confluence
 * corpus stores app-route URLs (`help.mikrotik.com/docs/spaces/ROS/pages/<id>/...`)
 * that also contain `/docs/`; those must NOT be parsed as a slug — they'd yield
 * `["spaces","ros","pages",...]` — so we fall back to their breadcrumb instead.
 */
export function pageIdentitySegs(url: string | null | undefined, breadcrumb = ""): string[] {
  const m = url?.match(/\/\/manual\.mikrotik\.com\/docs\/(.+)\/?$/);
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
 * One hyphenated slug segment may consume several command segments when it spells them
 * out in order (`/ip/packing` ↔ `ip-packing`, `bridge/vlan` ↔ `bridge-vlan-table`) — see
 * {@link flattenedRun}.
 *
 * A page with **no** trailing alignment scores 0 regardless of how many properties it
 * has — otherwise a property-rich but unrelated page (e.g. bridging-and-switching) would
 * win `/ip`. Path alignment dominates; property count only tie-breaks among aligned pages.
 */
export function scoreCandidate(cmdSegs: string[], pageSegs: string[], propCount: number): number {
  let depth = 0;
  let ci = cmdSegs.length - 1;
  let pi = pageSegs.length - 1;
  while (ci >= 0 && pi >= 0) {
    const run = flattenedRun(cmdSegs.slice(0, ci + 1), pageSegs[pi]);
    if (run >= 2) {
      // Each command segment in the run is an exact `-` component of the slug segment.
      depth += 3 * run;
      ci -= run;
    } else {
      const m = segMatch(cmdSegs[ci], pageSegs[pi]);
      if (m === 0) break;
      depth += m;
      ci--;
    }
    pi--;
  }
  if (depth === 0) return 0;
  return depth * 1000 + Math.min(propCount, 999);
}

/**
 * How many trailing command segments a single slug segment spells out as an in-order run of
 * its `-` components: `["interface","bridge","vlan"]` vs `bridge-vlan-table` → 2 (`bridge`,
 * `vlan`). Docusaurus slugs often flatten a menu path into one hyphenated segment, and a run
 * of two or more exact components is a word-boundary match on the command's own path — which
 * is why it outranks a plain prefix such as `vlan` ↔ `vlans-on-wireless` (#131).
 *
 * A run of one is deliberately not credited: a lone component (`container` ↔
 * `container-freeradius-server`, `client` ↔ `tr069-client`) is too weak to override the
 * existing exact/prefix rules.
 */
export function flattenedRun(cmdSegs: string[], pageSeg: string): number {
  const comps = pageSeg.split("-");
  if (comps.length < 2) return 0;
  for (let k = Math.min(cmdSegs.length, comps.length); k >= 2; k--) {
    const tail = cmdSegs.slice(cmdSegs.length - k);
    for (let start = 0; start + k <= comps.length; start++) {
      if (tail.every((seg, j) => comps[start + j] === seg)) return k;
    }
  }
  return 0;
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
