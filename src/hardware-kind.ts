/**
 * hardware-kind.ts — one taxonomy for "what is this /hardware page, really?".
 *
 * A manual.mikrotik.com/hardware page that no current matrix.csv row claims is NOT
 * automatically a defect: the page set is a superset of the current product matrix. It
 * mixes genuinely different things — off-matrix routers, plug-in radio modules, PSUs and
 * antennas, and series/index landing pages — and each wants different downstream handling
 * (searchable as a device? offered only under an `include-accessories` flag? surfaced as a
 * bundled-module pointer? never a device at all?). This classifier is the single place that
 * call is made, so build-device-map.ts (the reviewable `hardware-unmatched.tsv`) and any DB
 * or MCP/TUI surface stay in agreement instead of each re-deriving it (B-0018).
 *
 * Kinds:
 *   device        — a standalone RouterOS device (router / switch / AP / CPE / wireless
 *                   system) with its own /hardware page but no current matrix.csv row. Either
 *                   discontinued or an active product the matrix simply doesn't carry yet.
 *                   Lifecycle (active vs EOL) is orthogonal metadata, NOT encoded in the kind.
 *   accessory     — hardware that is not itself a RouterOS device: PSU, PoE injector, antenna,
 *                   GPS, enclosure, SFP/optical transceiver, out-of-band management dongle.
 *   module        — a plug-in radio module sold as its own SKU (LoRa / LTE / BT miniPCIe or
 *                   M.2). These are what a device's `&`-compound product code points at, so
 *                   they are the target of the step-2 "include module" cross-links.
 *   series-or-doc — a series / index / family landing page, or a documentation subpage
 *                   (e.g. `compliance`). Not an individual product; never a device.
 *
 * Kept rule-based on purpose: the inputs (category, slug shape) are enough to classify the
 * current set with no per-slug curation. `OVERRIDES` is the escape hatch for the odd page a
 * rule gets wrong; it is intentionally empty today (every one of the ~100 unmatched pages as
 * of the 2026-07 review classifies correctly by rule). Prefer a new rule over more overrides
 * if a whole class starts recurring — same discipline as device-exceptions.toml.
 */

export type HardwareKind = "device" | "accessory" | "module" | "series-or-doc";

/** Slugs whose rule-derived kind is wrong. Empty by design — see the module header. */
export const OVERRIDES: Record<string, HardwareKind> = {};

/** Non-`*-series` slugs that are documentation subpages, not products. */
const DOC_SLUGS = new Set(["compliance"]);

/** Standalone radio-module SKUs (LoRa/LTE/BT plug-ins), matched on their code prefix. */
const MODULE_SLUG_RE = /^(r11e-(lr|lte)|tg-(lr|bt))/;

/** manual.mikrotik.com/hardware categories that are accessories/interfaces, not devices. */
const ACCESSORY_CATEGORIES = new Set(["Accessories", "Antennas", "Interfaces"]);

/**
 * Classify a /hardware page. `slug` is the page slug (last URL segment), `category` its
 * declared hardware category (may be null), `isSeries` whether the page is a series/index page.
 */
export function classifyHardwareKind(
  slug: string,
  category: string | null,
  isSeries: boolean,
): HardwareKind {
  if (Object.hasOwn(OVERRIDES, slug)) return OVERRIDES[slug];
  if (isSeries || slug.endsWith("-series") || DOC_SLUGS.has(slug)) return "series-or-doc";
  if (MODULE_SLUG_RE.test(slug)) return "module";
  if (category && ACCESSORY_CATEGORIES.has(category)) return "accessory";
  return "device";
}
