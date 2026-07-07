/**
 * spike-docusaurus-rosetta-id.ts — T-0034 spike, not a production extractor.
 *
 * Validates the H7 Option-2 rosetta-id shape (a derivable, URL-based slug stored
 * alongside opaque integer PKs — see briefings/B-0012-docusaurus-manual-migration.md,
 * "H7 — Identity / rosetta-id design") against real manual.mikrotik.com URLs, before any
 * production schema or extractor code depends on the scheme.
 *
 * Not wired into the default extract pipeline. Run directly:
 *   bun run src/spike-docusaurus-rosetta-id.ts [path-to-sitemap.xml]
 * With no argument, fetches the live sitemap.xml.
 */

const SITEMAP_URL = "https://manual.mikrotik.com/sitemap.xml";

/**
 * URL path -> rosetta-id. Pure function so it's independently testable.
 *
 * Strips scheme+host, leading/trailing slashes, and lowercases. Also strips an
 * optional Docusaurus version-prefix segment (/docs/next/... or /docs/<semver>/...)
 * if present, even though manual.mikrotik.com does not version today (2026-07-07) —
 * B-0012 H7 flags this as cheap to build in now, expensive to retrofit later.
 */
export function deriveRosettaId(urlOrPath: string): string {
  let path: string;
  try {
    path = new URL(urlOrPath).pathname;
  } catch {
    path = urlOrPath;
  }

  path = path.replace(/^\/+|\/+$/g, "").toLowerCase();
  // Markdown-source links (and the docusaurus-plugin-llms .md endpoint, H1/H2) point at
  // the same page's .md/.mdx sibling URL — strip it so a page's own canonical id and an
  // internal link resolving to it collapse to the same rosetta-id (found empirically
  // 2026-07-07 while proving link resolution: without this, ./dhcp.md#anchor resolved to
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

/** Extract <loc> entries from a sitemap.xml document. */
export function parseSitemapLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

async function loadSitemap(source: string | undefined): Promise<string> {
  if (!source) {
    const res = await fetch(SITEMAP_URL);
    if (!res.ok) throw new Error(`Failed to fetch ${SITEMAP_URL}: ${res.status}`);
    return res.text();
  }
  return Bun.file(source).text();
}

async function main() {
  const source = process.argv[2];
  const xml = await loadSitemap(source);
  const urls = parseSitemapLocs(xml);
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
}

if (import.meta.main) {
  main();
}
