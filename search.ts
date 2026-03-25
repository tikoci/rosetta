#!/usr/bin/env bun
/**
 * Quick CLI search over RouterOS help database.
 * Usage: bun run search.ts "firewall filter"
 */

import { Database } from "bun:sqlite";
import { resolve } from "path";

const query = process.argv.slice(2).join(" ");
if (!query) {
  console.error("Usage: bun run search.ts <query>");
  process.exit(1);
}

const db = new Database(resolve(import.meta.dir, "ros-help.db"), { readonly: true });

const results = db.query<{
  id: number;
  title: string;
  path: string;
  word_count: number;
  code_lines: number;
  excerpt: string;
}, [string]>(`
  SELECT s.id, s.title, s.path, s.word_count, s.code_lines,
         snippet(sections_fts, 2, '>>>', '<<<', '...', 30) as excerpt
  FROM sections_fts fts
  JOIN sections s ON s.id = fts.rowid
  WHERE sections_fts MATCH ?
  ORDER BY rank LIMIT 10
`).all(query);

if (results.length === 0) {
  console.log(`No results for "${query}"`);
  process.exit(0);
}

console.log(`\n${results.length} results for "${query}":\n`);
for (const r of results) {
  console.log(`  [${r.id}] ${r.path}`);
  console.log(`      ${r.word_count} words, ${r.code_lines} code lines`);
  console.log(`      ${r.excerpt}\n`);
}
