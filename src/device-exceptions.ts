/**
 * device-exceptions.ts — loader for the curated `device-exceptions.toml` answer key.
 *
 * The TOML file (see its header) lists the matrix.csv devices the canonical matcher can't
 * resolve on its own, keyed by matrix "Product name". Three ETL consumers read it through
 * here, the same way hardware-www-map.ts serves the slug-keyed map:
 *   - build-device-map.ts reads the whole map for device-map.tsv and its drift gate.
 *   - assess-www.ts seeds `exceptionWwwCodes()` into its candidate fetch, so a device with no
 *     /hardware page still gets its www product scraped into ros-www-assessment.json.
 *   - extract-hardware-catalog.ts calls `exceptionWwwCodeForDevice()` to force-attach that
 *     product to the matrix row, past the identity-agreement gate (#155).
 */

import exceptions from "../device-exceptions.toml";

export interface DeviceException {
  class: "curated-alias" | "no-hardware-page" | "no-www-product" | "accessory";
  hardware_slug?: string;
  www_code?: string;
  note?: string;
}

const MAP = exceptions as Record<string, DeviceException>;

/** The curated map keyed by matrix.csv "Product name". */
export function deviceExceptions(): Record<string, DeviceException> {
  return MAP;
}

/** Every human-verified www product code in the map — the assess-www seed set. */
export function exceptionWwwCodes(): string[] {
  return [...new Set(Object.values(MAP).flatMap((e) => (e.www_code ? [e.www_code] : [])))];
}

/** The human-verified www product code for a matrix row, or undefined. */
export function exceptionWwwCodeForDevice(matrixName: string): string | undefined {
  return MAP[matrixName]?.www_code;
}
