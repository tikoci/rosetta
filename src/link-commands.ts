#!/usr/bin/env bun

/**
 * link-commands.ts — Link commands to documentation pages.
 *
 * For each page, extract RouterOS menu paths mentioned in its code blocks (and, for
 * the legacy HTML corpus, <strong>/<code> elements), then link each command dir to the
 * most *authoritative* mentioning page — the one whose own slug/breadcrumb trails the
 * command path (see link-ranking.ts). A dir with no aligned page is left unlinked rather
 * than pointed at a page that merely mentions it in an example.
 *
 * The linking is page_id on the `commands` table (nullable, many commands per page).
 *
 * Usage: bun run src/link-commands.ts
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseHTML } from "linkedom";
import { db, initDb } from "./db.ts";
import { type PageCandidate, pageIdentitySegs, pickBestPageId } from "./link-ranking.ts";
import {
  extractMenuPaths,
  isRouterOsPath as isRouterOsMenuPath,
  normalizeMenuPath,
} from "./menu-paths.ts";

const HTML_DIR =
  process.argv[2] || resolve(import.meta.dirname, "../box/latest/ROS");

initDb();

// Reset all links
db.run("UPDATE commands SET page_id = NULL;");

type PageRef = { id: number; title: string; html_file: string; code: string; path: string; url: string };
const pages = db.prepare("SELECT id, title, html_file, code, path, url FROM pages").all() as PageRef[];

// Per-page metadata used to rank candidate pages for a command (see linkDir below).
// `segs` are the page's identity segments (link-ranking.pageIdentitySegs); `propCount`
// is how many property rows the page has — a tie-breaker favouring the page that
// actually documents the menu over one that merely mentions it in an example.
const propCounts = new Map<number, number>();
for (const r of db.prepare("SELECT page_id, COUNT(*) AS c FROM properties GROUP BY page_id").all() as Array<{
  page_id: number;
  c: number;
}>) {
  propCounts.set(r.page_id, r.c);
}

const pageMeta = new Map<number, { segs: string[]; propCount: number }>();
for (const p of pages) {
  pageMeta.set(p.id, { segs: pageIdentitySegs(p.url, p.path), propCount: propCounts.get(p.id) ?? 0 });
}

type DirCmd = { id: number; path: string };
const dirCommands = db
  .prepare("SELECT id, path FROM commands WHERE type = 'dir'")
  .all() as DirCmd[];

// Build lookup: command path -> command row id
const cmdPathToId = new Map<string, number>();
for (const c of dirCommands) {
  cmdPathToId.set(c.path, c.id);
}

// Strategy 1: Extract menu paths from first code block and page text
// RouterOS paths in code: /ip/firewall/filter, /system/clock, etc.
// Also handle old syntax: /ip firewall filter -> /ip/firewall/filter
// Extraction lives in menu-paths.ts so the B-0024 join census measures the same rules.
const dirPathSet = new Set(cmdPathToId.keys());
const isRouterOsPath = (p: string) => isRouterOsMenuPath(p, dirPathSet);

// Map: page_id -> set of command paths found in that page
const pageToCommandPaths = new Map<number, Set<string>>();

for (const page of pages) {
  const paths = new Set<string>();

  // Extract from code blocks
  for (const p of extractMenuPaths([page.code], dirPathSet)) {
    paths.add(p);
  }

  // Also look in the HTML for <strong>/path/syntax</strong> and code elements
  try {
    const html = readFileSync(resolve(HTML_DIR, page.html_file), "utf-8");
    const { document } = parseHTML(html);
    const mainContent = document.querySelector("#main-content");
    if (mainContent) {
      // Check <strong> tags containing paths (common pattern for "Sub-menu: /ip/firewall/filter")
      for (const strong of mainContent.querySelectorAll("strong")) {
        const text = strong.textContent?.trim() || "";
        if (text.startsWith("/") && text.length > 3) {
          const normalized = normalizeMenuPath(text);
          if (isRouterOsPath(normalized)) {
            paths.add(normalized);
          }
        }
      }
      // Check code elements too
      for (const codeEl of mainContent.querySelectorAll("code")) {
        const text = codeEl.textContent?.trim() || "";
        if (text.startsWith("/") && text.length > 3) {
          const normalized = normalizeMenuPath(text);
          if (isRouterOsPath(normalized)) {
            paths.add(normalized);
          }
        }
      }
    }
  } catch {
    // Skip if file can't be read
  }

  if (paths.size > 0) {
    pageToCommandPaths.set(page.id, paths);
  }
}

// Now link: for each page's paths, find the best matching dir command
// A page "owns" a dir if the dir path matches one found in the page.
// For each command dir, pick the most specific page (the one whose found path
// is the longest match for the command path).

const updateSingle = db.prepare("UPDATE commands SET page_id = ? WHERE path = ?");

// Build reverse map: command_path -> candidate page_ids
const cmdToCandidatePages = new Map<string, number[]>();

for (const [pageId, paths] of pageToCommandPaths) {
  for (const p of paths) {
    // Direct match
    if (cmdPathToId.has(p)) {
      const existing = cmdToCandidatePages.get(p) || [];
      existing.push(pageId);
      cmdToCandidatePages.set(p, existing);
    }
    // Also try parent paths (e.g., /ip/dhcp-client/add -> /ip/dhcp-client)
    const segments = p.split("/").filter(Boolean);
    for (let i = segments.length - 1; i >= 1; i--) {
      const parent = `/${segments.slice(0, i).join("/")}`;
      if (cmdPathToId.has(parent)) {
        const existing = cmdToCandidatePages.get(parent) || [];
        if (!existing.includes(pageId)) {
          existing.push(pageId);
          cmdToCandidatePages.set(parent, existing);
        }
        break; // Only link to the most specific parent
      }
    }
  }
}

// For each command dir, link the most authoritative mentioning page — the one whose
// own slug/breadcrumb trails the command path (link-ranking.pickBestPageId). A dir with
// no aligned candidate is left unlinked rather than asserting a wrong page, so
// lookupProperty falls back to an honest low-confidence global search instead of a
// high-confidence lie (BL-1/BL-2).
const linkDir = db.transaction(() => {
  for (const [cmdPath, candidatePageIds] of cmdToCandidatePages) {
    const candidates: PageCandidate[] = candidatePageIds.map((id) => ({
      id,
      segs: pageMeta.get(id)?.segs ?? [],
      propCount: pageMeta.get(id)?.propCount ?? 0,
    }));
    const pageId = pickBestPageId(cmdPath, candidates);
    if (pageId === null) continue;

    // Link the dir itself
    if (cmdPathToId.has(cmdPath)) {
      updateSingle.run(pageId, cmdPath);
    }

    // Also link child commands
    const children = db
      .prepare("SELECT path FROM commands WHERE parent_path = ? AND page_id IS NULL")
      .all(cmdPath) as Array<{ path: string }>;
    for (const child of children) {
      updateSingle.run(pageId, child.path);
    }
  }
});
linkDir();

// Stats
const totalDirs = (db.prepare("SELECT COUNT(*) as c FROM commands WHERE type='dir'").get() as { c: number }).c;
const linkedDirs = (db.prepare("SELECT COUNT(*) as c FROM commands WHERE type='dir' AND page_id IS NOT NULL").get() as { c: number }).c;
const totalCmds = (db.prepare("SELECT COUNT(*) as c FROM commands").get() as { c: number }).c;
const linkedCmds = (db.prepare("SELECT COUNT(*) as c FROM commands WHERE page_id IS NOT NULL").get() as { c: number }).c;

console.log("Linking complete:");
console.log(`  Total commands: ${totalCmds}`);
console.log(`  Linked commands: ${linkedCmds} (${((linkedCmds / totalCmds) * 100).toFixed(1)}%)`);
console.log(`  Linked dirs: ${linkedDirs}/${totalDirs} (${((linkedDirs / totalDirs) * 100).toFixed(1)}%)`);

// Sample linked commands
console.log("\nSample linked dirs:");
const samples = db
  .prepare(
    `SELECT c.path, p.title, p.url
     FROM commands c JOIN pages p ON c.page_id = p.id
     WHERE c.type = 'dir'
     ORDER BY c.path LIMIT 20`,
  )
  .all() as Array<{ path: string; title: string; url: string }>;
for (const s of samples) {
  console.log(`  ${s.path} -> ${s.title}`);
}

// Unlinked dirs
console.log("\nUnlinked dirs (sample):");
const unlinked = db
  .prepare("SELECT path FROM commands WHERE type='dir' AND page_id IS NULL ORDER BY path LIMIT 20")
  .all() as Array<{ path: string }>;
for (const u of unlinked) {
  console.log(`  ${u.path}`);
}
