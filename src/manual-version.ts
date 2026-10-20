/**
 * manual-version.ts — which RouterOS manual a manual.mikrotik.com tree is (#187).
 *
 * Each tree's llms.txt names its own version in the header prose ("Index of the
 * RouterOS 7.26 manual, …"). The unversioned default tree is NOT the stable manual:
 * on 2026-10-20 it declared 7.26 while stable was 7.24.5, so neither "latest" nor
 * NEWESTa7.stable can stand in for it. The header is the only version signal the
 * site gives, so a tree without one is an error, not an unknown.
 *
 * Pure (no db.ts import): the extractors stamp the result into db_meta themselves.
 */

/** db_meta key: manual version of the tree extract-docusaurus read (pages/sections/properties). */
export const DOCS_MANUAL_VERSION_KEY = "docs_manual_version";
/** db_meta key: manual version of the tree extract-cliref read (cliref_* tables). */
export const CLIREF_MANUAL_VERSION_KEY = "cliref_manual_version";

const HEADER = /^Index of the RouterOS (\d+\.\d+(?:\.\d+)?(?:(?:alpha|beta|rc)\d+)?) manual\b/m;

/** The version an llms.txt declares for its tree. Throws when the header is missing. */
export function parseManualVersion(llmsTxt: string): string {
  const version = HEADER.exec(llmsTxt)?.[1];
  if (version === undefined) {
    throw new Error(
      'llms.txt has no "Index of the RouterOS <version> manual" header — the manual tree\'s version is unknown (#187). ' +
        "Re-check manual.mikrotik.com's llms.txt shape before extracting.",
    );
  }
  return version;
}

/**
 * Two stores read from one site in one build must describe the same manual tree.
 * Returns an error message when `other` (the stamp the sibling extractor left) disagrees,
 * or null when it agrees or is absent (that extractor has not run against this DB).
 */
export function manualVersionMismatch(
  mine: { key: string; version: string },
  other: { key: string; version: string | null },
): string | null {
  if (other.version === null || other.version === mine.version) return null;
  return (
    `manual version mismatch: ${mine.key}=${mine.version} but ${other.key}=${other.version} in this DB. ` +
    `Both stores must come from the same manual tree — re-run the extractor that wrote ${other.key} against the current site.`
  );
}
