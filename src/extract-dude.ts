#!/usr/bin/env bun
/**
 * extract-dude.ts — Extract "The Dude" documentation from Wayback Machine.
 *
 * One-time extractor: fetches archived wiki pages from web.archive.org,
 * parses HTML with linkedom, downloads screenshots to dude/images/,
 * caches raw HTML to dude/pages/, and populates dude_pages + dude_images tables.
 *
 * Usage:
 *   bun run src/extract-dude.ts              # Fetch from Wayback Machine + download images
 *   bun run src/extract-dude.ts --from-cache # Re-extract from cached dude/pages/ HTML
 *   bun run src/extract-dude.ts --from-cache --skip-images  # CI path: no image download
 *   bun run src/extract-dude.ts --force      # Force re-download even if cached
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { db, initDb } from "./db.ts";

// ── Configuration ──

const PROJECT_ROOT = join(import.meta.dirname, "..");
const PAGES_DIR = join(PROJECT_ROOT, "dude", "pages");
const IMAGES_DIR = join(PROJECT_ROOT, "dude", "images");
const FETCH_DELAY_MS = 500;

const FROM_CACHE = process.argv.includes("--from-cache");
const FORCE = process.argv.includes("--force");
const SKIP_IMAGES = process.argv.includes("--skip-images");

/** Page definition: wiki path suffix → metadata */
interface PageDef {
  /** Wiki path after /wiki/ (e.g. "Manual:The_Dude_v6/Probes") */
  wikiPath: string;
  /** Short slug for DB (e.g. "Probes", "Device_discovery") */
  slug: string;
  /** Human-readable breadcrumb path */
  path: string;
  /** Version tag: "v6" or "v3" */
  version: "v6" | "v3";
}

// ── Page list (from CDX API enumeration) ──

const V6_PAGES: PageDef[] = [
  { wikiPath: "Manual:The_Dude", slug: "The_Dude", path: "The Dude", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Installation", slug: "Installation", path: "The Dude > v6 > Installation", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/First_use", slug: "First_use", path: "The Dude > v6 > First Use", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Interface", slug: "Interface", path: "The Dude > v6 > Interface", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Device_settings", slug: "Device_settings", path: "The Dude > v6 > Device Settings", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Device_discovery", slug: "Device_discovery", path: "The Dude > v6 > Device Discovery", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Device_map", slug: "Device_map", path: "The Dude > v6 > Device Map", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Device_list", slug: "Device_list", path: "The Dude > v6 > Device List", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Networks", slug: "Networks", path: "The Dude > v6 > Networks", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Links", slug: "Links", path: "The Dude > v6 > Links", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Agents", slug: "Agents", path: "The Dude > v6 > Agents", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Charts", slug: "Charts", path: "The Dude > v6 > Charts", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Functions", slug: "Functions", path: "The Dude > v6 > Functions", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Probes", slug: "Probes", path: "The Dude > v6 > Probes", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/MIB_Nodes", slug: "MIB_Nodes", path: "The Dude > v6 > MIB Nodes", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Notifications", slug: "Notifications", path: "The Dude > v6 > Notifications", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Syslog", slug: "Syslog", path: "The Dude > v6 > Syslog", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Services", slug: "Services", path: "The Dude > v6 > Services", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Logs", slug: "Logs", path: "The Dude > v6 > Logs", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/History", slug: "History", path: "The Dude > v6 > History", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Tools", slug: "Tools", path: "The Dude > v6 > Tools", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Panels", slug: "Panels", path: "The Dude > v6 > Panels", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Server_settings", slug: "Server_settings", path: "The Dude > v6 > Server Settings", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Files", slug: "Files", path: "The Dude > v6 > Files", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Exporting", slug: "Exporting", path: "The Dude > v6 > Search and Export", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Address_lists", slug: "Address_lists", path: "The Dude > v6 > Address Lists", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Admins", slug: "Admins", path: "The Dude > v6 > Admins", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/DB_import_export", slug: "DB_import_export", path: "The Dude > v6 > Database Import and Export", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Change_DB_path", slug: "Change_DB_path", path: "The Dude > v6 > Change DB Path", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/db_vacuum", slug: "db_vacuum", path: "The Dude > v6 > SQLite3 DB Vacuum", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/MigrationToNewDude", slug: "MigrationToNewDude", path: "The Dude > v6 > Migration from v3/v4 to v6", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Malformed_db_repair", slug: "Malformed_db_repair", path: "The Dude > v6 > Malformed DB Repair", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/The_dude_server_on_VM_CHR", slug: "Server_on_CHR", path: "The Dude > v6 > Server on CHR", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/The_Dude_server_on_hEX_RB750Gr3", slug: "Server_on_hEX", path: "The Dude > v6 > Server on hEX RB750Gr3", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/Dude_Telegram_Example", slug: "Telegram_Example", path: "The Dude > v6 > Telegram Notification Example", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/client_shortcut_arguments", slug: "Client_shortcuts", path: "The Dude > v6 > Client Shortcut Arguments", version: "v6" },
  { wikiPath: "Manual:The_Dude_v6/dude_v6.xx_changelog", slug: "Changelog_v6", path: "The Dude > v6 > Version Changelog", version: "v6" },
];

const V3_PAGES: PageDef[] = [
  { wikiPath: "Manual:The_Dude4", slug: "v3_Overview", path: "The Dude > v3/v4 > Overview", version: "v3" },
  { wikiPath: "Manual:The_Dude/Installation", slug: "v3_Installation", path: "The Dude > v3/v4 > Installation", version: "v3" },
  { wikiPath: "Manual:The_Dude/First_use", slug: "v3_First_use", path: "The Dude > v3/v4 > First Use", version: "v3" },
  { wikiPath: "Manual:The_Dude/Interface", slug: "v3_Interface", path: "The Dude > v3/v4 > Interface", version: "v3" },
  { wikiPath: "Manual:The_Dude/Device_settings", slug: "v3_Device_settings", path: "The Dude > v3/v4 > Device Settings", version: "v3" },
  { wikiPath: "Manual:The_Dude/Device_discovery", slug: "v3_Device_discovery", path: "The Dude > v3/v4 > Device Discovery", version: "v3" },
  { wikiPath: "Manual:The_Dude/Device_map", slug: "v3_Device_map", path: "The Dude > v3/v4 > Device Map", version: "v3" },
  { wikiPath: "Manual:The_Dude/Device_list", slug: "v3_Device_list", path: "The Dude > v3/v4 > Device List", version: "v3" },
  { wikiPath: "Manual:The_Dude/Networks", slug: "v3_Networks", path: "The Dude > v3/v4 > Networks", version: "v3" },
  { wikiPath: "Manual:The_Dude/Links", slug: "v3_Links", path: "The Dude > v3/v4 > Links", version: "v3" },
  { wikiPath: "Manual:The_Dude/Agents", slug: "v3_Agents", path: "The Dude > v3/v4 > Agents", version: "v3" },
  { wikiPath: "Manual:The_Dude/Charts", slug: "v3_Charts", path: "The Dude > v3/v4 > Charts", version: "v3" },
  { wikiPath: "Manual:The_Dude/Functions", slug: "v3_Functions", path: "The Dude > v3/v4 > Functions", version: "v3" },
  { wikiPath: "Manual:The_Dude/Probes", slug: "v3_Probes", path: "The Dude > v3/v4 > Probes", version: "v3" },
  { wikiPath: "Manual:The_Dude/MIB_Nodes", slug: "v3_MIB_Nodes", path: "The Dude > v3/v4 > MIB Nodes", version: "v3" },
  { wikiPath: "Manual:The_Dude/Notifications", slug: "v3_Notifications", path: "The Dude > v3/v4 > Notifications", version: "v3" },
  { wikiPath: "Manual:The_Dude/Syslog", slug: "v3_Syslog", path: "The Dude > v3/v4 > Syslog", version: "v3" },
  { wikiPath: "Manual:The_Dude/Services", slug: "v3_Services", path: "The Dude > v3/v4 > Services", version: "v3" },
  { wikiPath: "Manual:The_Dude/Logs", slug: "v3_Logs", path: "The Dude > v3/v4 > Logs", version: "v3" },
  { wikiPath: "Manual:The_Dude/History", slug: "v3_History", path: "The Dude > v3/v4 > History", version: "v3" },
  { wikiPath: "Manual:The_Dude/Tools", slug: "v3_Tools", path: "The Dude > v3/v4 > Tools", version: "v3" },
  { wikiPath: "Manual:The_Dude/Panels", slug: "v3_Panels", path: "The Dude > v3/v4 > Panels", version: "v3" },
  { wikiPath: "Manual:The_Dude/Server_settings", slug: "v3_Server_settings", path: "The Dude > v3/v4 > Server Settings", version: "v3" },
  { wikiPath: "Manual:The_Dude/Files", slug: "v3_Files", path: "The Dude > v3/v4 > Files", version: "v3" },
  { wikiPath: "Manual:The_Dude/Exporting", slug: "v3_Exporting", path: "The Dude > v3/v4 > Exporting", version: "v3" },
  { wikiPath: "Manual:The_Dude/Address_lists", slug: "v3_Address_lists", path: "The Dude > v3/v4 > Address Lists", version: "v3" },
  { wikiPath: "Manual:The_Dude/Admins", slug: "v3_Admins", path: "The Dude > v3/v4 > Admins", version: "v3" },
  { wikiPath: "Manual:The_Dude/Web_interface", slug: "v3_Web_interface", path: "The Dude > v3/v4 > Web Interface", version: "v3" },
  { wikiPath: "Manual:The_Dude/Changelog", slug: "v3_Changelog", path: "The Dude > v3/v4 > Changelog", version: "v3" },
];

const ALL_PAGES: PageDef[] = [...V6_PAGES, ...V3_PAGES];

// ── Wayback Machine helpers ──

const WIKI_BASE = "https://wiki.mikrotik.com/wiki/";

/** Build a Wayback Machine URL. Uses wildcard timestamp to get latest snapshot. */
function waybackUrl(wikiPath: string): string {
  return `https://web.archive.org/web/2024/${WIKI_BASE}${encodeURIComponent(wikiPath).replace(/%2F/g, "/").replace(/%3A/g, ":")}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch with retry for Wayback Machine rate limits. */
async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let attempt = 0; attempt < retries; attempt++) {
    const response = await fetch(url, {
      headers: { "User-Agent": "rosetta-dude-extractor/1.0 (MikroTik documentation tool)" },
    });
    if (response.ok) return response;
    if (response.status === 429 || response.status === 503) {
      const waitMs = (attempt + 1) * 2000;
      console.log(`  Rate limited (${response.status}), waiting ${waitMs}ms...`);
      await delay(waitMs);
      continue;
    }
    if (response.status === 404) {
      throw new Error(`404 Not Found: ${url}`);
    }
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  throw new Error(`Failed after ${retries} retries: ${url}`);
}

// ── HTML parsing ──

interface ParsedPage {
  title: string;
  text: string;
  code: string;
  lastEdited: string | null;
  images: Array<{ filename: string; altText: string | null; originalUrl: string; waybackImageUrl: string }>;
}

function parsePage(html: string, _waybackBaseUrl: string): ParsedPage {
  const { document } = parseHTML(html);

  // Title from first h1 or page heading
  const h1 = document.querySelector("#firstHeading, h1.firstHeading, h1");
  const title = h1?.textContent?.trim()?.replace(/^Manual:The Dude v6\//, "")
    .replace(/^Manual:The Dude\//, "")
    .replace(/^Manual:The Dude4?$/, "The Dude")
    .replace(/_/g, " ") ?? "Unknown";

  // Main content area
  const content = document.querySelector("#mw-content-text, .mw-parser-output, #bodyContent");
  if (!content) return { title, text: "", code: "", lastEdited: null, images: [] };

  // Remove navigation, TOC, edit links, Wayback Machine toolbar
  for (const sel of ["#toc", ".toc", ".mw-editsection", ".navbox", "#catlinks",
    ".printfooter", "#wm-ipp-base", "#wm-ipp", "#donato", ".wb-autocomplete-suggestions",
    "#mw-navigation", "#footer", ".noprint"]) {
    for (const el of content.querySelectorAll(sel)) el.remove();
  }

  // Extract code blocks
  const codeBlocks: string[] = [];
  for (const pre of content.querySelectorAll("pre, code.ros")) {
    const text = pre.textContent?.trim();
    if (text && text.length > 10) codeBlocks.push(text);
  }

  // Extract images
  const images: ParsedPage["images"] = [];
  const seenFilenames = new Set<string>();
  for (const img of content.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    const alt = img.getAttribute("alt") ?? null;

    // Skip tiny icons, navigation icons, and Wayback Machine UI images
    const width = Number.parseInt(img.getAttribute("width") ?? "0", 10);
    if (width > 0 && width < 30) continue;
    if (src.includes("web.archive.org/static/") || src.includes("/_static/")) continue;

    // Extract filename from MediaWiki image URLs
    // Patterns: /images/X/XX/Filename.JPG or /wiki/File:Filename.JPG
    let filename: string | null = null;
    const srcMatch = src.match(/\/images\/[0-9a-f]\/[0-9a-f]{2}\/([^/?]+)/i)
      ?? src.match(/\/([^/]+\.(?:jpg|jpeg|png|gif|svg))(?:\?|$)/i);
    if (srcMatch) {
      filename = decodeURIComponent(srcMatch[1]);
    }

    // Also check parent <a> links for File: references
    if (!filename) {
      const parentA = img.closest("a");
      const href = parentA?.getAttribute("href") ?? "";
      const fileMatch = href.match(/File:([^&"]+)/);
      if (fileMatch) filename = decodeURIComponent(fileMatch[1]);
    }

    if (!filename) continue;
    if (seenFilenames.has(filename)) continue;
    // Skip common wiki icons
    if (/^Icon-\w+\.png$/i.test(filename)) continue;
    if (/^Version\.png$/i.test(filename)) continue;
    seenFilenames.add(filename);

    // Build a usable image URL from the Wayback Machine
    let waybackImageUrl = src;
    if (src.startsWith("/")) {
      waybackImageUrl = `https://web.archive.org${src}`;
    }
    // Ensure we use the raw image URL (id_ prefix bypasses Wayback rewriting)
    waybackImageUrl = waybackImageUrl.replace(
      /\/web\/\d+\//,
      "/web/2024id_/",
    );

    const originalUrl = `${WIKI_BASE}File:${encodeURIComponent(filename)}`;

    images.push({ filename, altText: alt, originalUrl, waybackImageUrl });
  }

  // Extract body text
  const textContent = content.textContent ?? "";
  // Clean up whitespace: collapse multiple blank lines, trim
  const text = textContent.replace(/\n{3,}/g, "\n\n").trim();

  // Last edited date from footer
  const lastEditedEl = document.querySelector("#footer-info-lastmod, .lastmod");
  const lastEdited = lastEditedEl?.textContent?.replace(/.*last edited on\s*/i, "").trim() ?? null;

  return { title, text, code: codeBlocks.join("\n\n"), lastEdited, images };
}

// ── Image download ──

async function downloadImage(url: string, dest: string): Promise<boolean> {
  if (existsSync(dest) && !FORCE) return true;
  try {
    const response = await fetchWithRetry(url);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength < 100) return false; // too small, probably an error page
    writeFileSync(dest, Buffer.from(buffer));
    return true;
  } catch (e) {
    console.log(`  Warning: failed to download image: ${e}`);
    return false;
  }
}

// ── Main extraction ──

async function main() {
  initDb();

  mkdirSync(PAGES_DIR, { recursive: true });
  mkdirSync(IMAGES_DIR, { recursive: true });

  // Idempotent: clear existing data
  db.run("DELETE FROM dude_images");
  db.run("DELETE FROM dude_pages");

  const insertPage = db.prepare(`
    INSERT INTO dude_pages (slug, title, path, version, url, wayback_url, text, code, last_edited, word_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertImage = db.prepare(`
    INSERT INTO dude_images (page_id, filename, alt_text, caption, local_path, original_url, wayback_url, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let pageCount = 0;
  let imageCount = 0;
  let errorCount = 0;

  for (const pageDef of ALL_PAGES) {
    const cacheFile = join(PAGES_DIR, `${pageDef.slug}.html`);
    const wbUrl = waybackUrl(pageDef.wikiPath);
    const originalUrl = `${WIKI_BASE}${pageDef.wikiPath}`;

    let html: string;

    if (FROM_CACHE || (existsSync(cacheFile) && !FORCE)) {
      // Read from cache
      if (!existsSync(cacheFile)) {
        console.log(`  SKIP (no cache): ${pageDef.slug}`);
        continue;
      }
      html = readFileSync(cacheFile, "utf-8");
      console.log(`  [cache] ${pageDef.slug}`);
    } else {
      // Fetch from Wayback Machine
      console.log(`  [fetch] ${pageDef.slug} ...`);
      try {
        const response = await fetchWithRetry(wbUrl);
        html = await response.text();
        // Cache the raw HTML
        writeFileSync(cacheFile, html);
        await delay(FETCH_DELAY_MS);
      } catch (e) {
        console.log(`  ERROR: ${pageDef.slug}: ${e}`);
        errorCount++;
        continue;
      }
    }

    // Parse HTML
    const parsed = parsePage(html, wbUrl);
    if (!parsed.text && !parsed.code) {
      console.log(`  WARN: empty content for ${pageDef.slug}`);
    }

    const wordCount = parsed.text.split(/\s+/).filter(Boolean).length;

    // Insert page
    db.transaction(() => {
      insertPage.run(
        pageDef.slug,
        parsed.title,
        pageDef.path,
        pageDef.version,
        originalUrl,
        wbUrl,
        parsed.text,
        parsed.code || null,
        parsed.lastEdited,
        wordCount,
      );

      const pageRow = db.prepare("SELECT id FROM dude_pages WHERE slug = ?").get(pageDef.slug) as { id: number };
      const pageId = pageRow.id;

      // Download and insert images
      for (let i = 0; i < parsed.images.length; i++) {
        const img = parsed.images[i];
        const localPath = `dude/images/${img.filename}`;

        insertImage.run(
          pageId,
          img.filename,
          img.altText,
          null, // caption — could be inferred from surrounding text
          localPath,
          img.originalUrl,
          img.waybackImageUrl,
          i,
        );
        imageCount++;
      }
    })();

    pageCount++;
  }

  // Download images outside the DB transaction loop (allows partial success)
  if (SKIP_IMAGES) {
    console.log("\nSkipping image download (--skip-images).");
  } else {
    console.log("\nDownloading images...");
    const allImages = db.prepare("SELECT DISTINCT filename, wayback_url FROM dude_images").all() as Array<{ filename: string; wayback_url: string }>;
    let downloadedCount = 0;
    let skipCount = 0;
    for (const img of allImages) {
      const destPath = join(IMAGES_DIR, img.filename);
      if (existsSync(destPath) && !FORCE) {
        skipCount++;
        continue;
      }
      const ok = await downloadImage(img.wayback_url, destPath);
      if (ok) {
        downloadedCount++;
        console.log(`  ✓ ${img.filename}`);
      }
      await delay(FETCH_DELAY_MS);
    }
    console.log(`\nDone: ${pageCount} pages, ${imageCount} image refs, ${downloadedCount} downloaded, ${skipCount} cached, ${errorCount} errors`);
  }

  // Summary
  const stats = db.prepare("SELECT COUNT(*) AS c FROM dude_pages").get() as { c: number };
  const imgStats = db.prepare("SELECT COUNT(*) AS c FROM dude_images").get() as { c: number };
  console.log(`DB: ${stats.c} dude_pages, ${imgStats.c} dude_images`);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
