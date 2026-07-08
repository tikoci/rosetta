/**
 * rosetta-id.ts — URL-path-derived stable identifiers for Docusaurus-sourced content.
 *
 * Promoted from the T-0034 spike (src/spike-docusaurus-rosetta-id.ts, now removed) after
 * its H7 Option-2 shape (separate `rosetta_id TEXT UNIQUE` column, existing INTEGER PKs
 * untouched) was validated against a live 20-page prototype and confirmed in
 * briefings/B-0012-docusaurus-manual-migration.md, "H7 — Identity / rosetta-id design".
 *
 * Used by extract-docusaurus.ts to mint `pages.rosetta_id` and to resolve relative
 * Markdown links inside property descriptions to a canonical id/URL.
 */

const SITEMAP_URL = "https://manual.mikrotik.com/sitemap.xml";

/**
 * URL path -> rosetta-id. Pure function so it's independently testable.
 *
 * Strips scheme+host, leading/trailing slashes, and lowercases. Also strips an
 * optional Docusaurus version-prefix segment (/docs/next/... or /docs/<semver>/...)
 * if present, even though manual.mikrotik.com does not version today — B-0012 H7
 * flags this as cheap to build in now, expensive to retrofit later.
 */
export function deriveRosettaId(urlOrPath: string): string {
  let path: string;
  try {
    path = new URL(urlOrPath).pathname;
  } catch {
    path = urlOrPath;
  }

  path = path.replace(/^\/+|\/+$/g, "").toLowerCase();
  // Markdown-source links (and the docusaurus-plugin-llms .md endpoint) point at the
  // same page's .md/.mdx sibling URL — strip it so a page's own canonical id and an
  // internal link resolving to it collapse to the same rosetta-id (found empirically
  // during T-0034: without this, ./dhcp.md#anchor resolved to
  // "docs/network-management/dhcp.md" while the page itself was "docs/.../dhcp").
  path = path.replace(/\.mdx?$/, "");

  const segments = path.split("/");
  if (segments[0] === "docs" && segments.length > 1) {
    const second = segments[1];
    const isVersionPrefix = second === "next" || /^v?\d+(\.\d+)*(-[a-z0-9.]+)?$/.test(second);
    if (isVersionPrefix) {
      segments.splice(1, 1);
    }
  }

  return segments.join("/");
}

/** Build a live manual.mikrotik.com URL from a rosetta-id (inverse of deriveRosettaId, minus version-prefix). */
export function rosettaIdToUrl(rosettaId: string): string {
  return `https://manual.mikrotik.com/${rosettaId}`;
}

export interface CollisionReport {
  total: number;
  uniqueIds: number;
  collisions: Map<string, string[]>;
  maxLength: number;
  unexpectedChars: string[];
}

/** Derive rosetta-ids for a list of URLs and report any collisions. */
export function checkCollisions(urls: string[]): CollisionReport {
  const byId = new Map<string, string[]>();
  let maxLength = 0;
  const unexpectedChars = new Set<string>();

  for (const url of urls) {
    const id = deriveRosettaId(url);
    maxLength = Math.max(maxLength, id.length);
    for (const ch of id) {
      if (!/[a-z0-9/_-]/.test(ch)) unexpectedChars.add(ch);
    }
    const existing = byId.get(id);
    if (existing) existing.push(url);
    else byId.set(id, [url]);
  }

  const collisions = new Map<string, string[]>();
  for (const [id, sourceUrls] of byId) {
    if (sourceUrls.length > 1) collisions.set(id, sourceUrls);
  }

  return {
    total: urls.length,
    uniqueIds: byId.size,
    collisions,
    maxLength,
    unexpectedChars: [...unexpectedChars],
  };
}

/** Decode the five predefined XML entities. `&amp;` is decoded last so already-decoded `&` isn't re-processed. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Extract <loc> entries from a sitemap.xml document, decoding XML entities in each URL. */
export function parseSitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => decodeXmlEntities(m[1]));
}

/** Fetch and parse the live manual.mikrotik.com sitemap, or read a local file if `source` is given. */
export async function loadSitemapUrls(source?: string): Promise<string[]> {
  let xml: string;
  if (source) {
    xml = await Bun.file(source).text();
  } else {
    const res = await fetch(SITEMAP_URL);
    // Fail loud on a non-2xx: an HTML error page has no <loc> matches, which would
    // otherwise masquerade as "0 pages in scope" and be diagnosed as a filter bug.
    if (!res.ok) throw new Error(`Failed to fetch sitemap ${SITEMAP_URL}: HTTP ${res.status} ${res.statusText}`);
    xml = await res.text();
  }
  return parseSitemapLocs(xml);
}

if (import.meta.main) {
  (async () => {
    const source = process.argv[2];
    const urls = await loadSitemapUrls(source);
    const report = checkCollisions(urls);

    console.log(`Source: ${source ?? SITEMAP_URL}`);
    console.log(`Total URLs:       ${report.total}`);
    console.log(`Unique rosetta-ids: ${report.uniqueIds}`);
    console.log(`Max id length:    ${report.maxLength}`);
    console.log(`Unexpected chars: ${report.unexpectedChars.length === 0 ? "none" : report.unexpectedChars.join(" ")}`);
    console.log(`Collisions:       ${report.collisions.size}`);

    if (report.collisions.size > 0) {
      for (const [id, sourceUrls] of report.collisions) {
        console.log(`  ${id}:`);
        for (const u of sourceUrls) console.log(`    ${u}`);
      }
      process.exitCode = 1;
    }
  })().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
