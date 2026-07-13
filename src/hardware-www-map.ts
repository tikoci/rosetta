/**
 * hardware-www-map.ts — loader for the curated `hardware-www-map.toml` answer key.
 *
 * The TOML file (see its header) maps off-matrix `manual.mikrotik.com/hardware/<slug>`
 * pages to the `mikrotik.com/product/<code>` codes the auto-resolver can't derive on its
 * own (e.g. sxt-2 -> RBSXTG-2HnDr2-168). Both ETL consumers read it through here so the shape
 * and the "which codes does a human vouch for" question have a single home — same pattern
 * as hardware-kind.ts and device-exceptions.toml.
 *
 * Two consumption points (see #70):
 *   - assess-www.ts seeds `curatedWwwCodes()` into its candidate fetch so the product
 *     pages actually get scraped into ros-www-assessment.json.
 *   - extract-hardware-catalog.ts calls `curatedWwwCodeForSlug()` to force-attach a
 *     single curated product to a hardware row, past the identity-agreement gate.
 */

import curated from "../hardware-www-map.toml";

export interface HardwareWwwEntry {
  /** The single marketing product a device page maps to. */
  www_code?: string;
  /** For a series/index page fronting several member products — every member code. */
  www_codes?: string[];
  /** "no-www" (verified absent) | "skip" (not a product page) | "verify" (flagged). */
  status?: "no-www" | "skip" | "verify";
  /**
   * Seed the code for fetch, but do NOT force-attach it to this slug's catalog row. Used for
   * radio-module / bundled-kit pages whose product identity is claimed at higher (matrix) rank
   * by the kits that embed it — e.g. R11e-LR8G is a subcode of the wAP/KNOT LR8G kits, so the
   * module's own declared code can't also be the module row's unique alias. Attaching anyway
   * trips the catalog's one-product-one-row / declared-code-among-aliases invariants. Their
   * specs still land in ros-www-assessment.json for the future module cross-link work (#70).
   */
  seed_only?: boolean;
  note?: string;
}

const MAP = curated as Record<string, HardwareWwwEntry>;

/** The curated map keyed by `manual.mikrotik.com/hardware/<slug>`. */
export function hardwareWwwMap(): Record<string, HardwareWwwEntry> {
  return MAP;
}

/**
 * Every product code the map vouches for — `www_code` plus every `www_codes` member,
 * flattened and de-duplicated across all slugs. Status-only entries (no code) contribute
 * nothing. This is the seed set for assess-www's candidate fetch.
 */
export function curatedWwwCodes(): string[] {
  const out = new Set<string>();
  for (const e of Object.values(MAP)) {
    if (e.www_code) out.add(e.www_code);
    for (const c of e.www_codes ?? []) out.add(c);
  }
  return [...out];
}

/**
 * The single curated product code for a `/hardware` slug, or undefined. Series pages
 * (`www_codes`), status-only entries, and `seed_only` entries return undefined on purpose: a
 * series page fronts several products and has no single canonical code to force-attach, and a
 * seed_only module/kit page's product identity is owned by the kits that embed it (see the
 * `seed_only` field). Their members/specs are still fetched via `curatedWwwCodes()` and
 * materialized/surfaced separately (see #70).
 */
export function curatedWwwCodeForSlug(slug: string): string | undefined {
  const e = MAP[slug];
  // Enforce the contract explicitly: only a plain single-code entry force-attaches. A series
  // (`www_codes`), a status-only entry, or a `seed_only` module/kit page returns undefined even
  // if some future edit also set `www_code` on it.
  if (!e || e.seed_only || e.status || e.www_codes) return undefined;
  return e.www_code;
}
