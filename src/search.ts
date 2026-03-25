#!/usr/bin/env bun
/**
 * CLI search over RouterOS documentation database.
 * Usage: bun run src/search.ts "firewall filter"
 */

import { db, initDb } from "./db.ts";

const query = process.argv.slice(2).join(" ");
if (!query) {
  console.error("Usage: bun run src/search.ts <query>");
  process.exit(1);
}

initDb();

type SearchResult = {
  id: number;
  title: string;
  path: string;
  url: string;
  word_count: number;
  code_lines: number;
  excerpt: string;
};

const results = db
  .query<SearchResult, [string]>(
    `SELECT s.id, s.title, s.path, s.url, s.word_count, s.code_lines,
            snippet(pages_fts, 2, '>>>', '<<<', '...', 30) as excerpt
     FROM pages_fts fts
     JOIN pages s ON s.id = fts.rowid
     WHERE pages_fts MATCH ?
     ORDER BY bm25(pages_fts, 3.0, 2.0, 1.0, 0.5) LIMIT 10`,
  )
  .all(query);

if (results.length === 0) {
  console.log(`No results for "${query}"`);
  process.exit(0);
}

console.log(`\n${results.length} results for "${query}":\n`);
for (const r of results) {
  console.log(`  [${r.id}] ${r.path}`);
  console.log(`      ${r.word_count} words, ${r.code_lines} code lines`);
  console.log(`      ${r.url}`);
  console.log(`      ${r.excerpt}\n`);
}
