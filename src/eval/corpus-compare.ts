/**
 * One-off cross-corpus retrieval comparator — 0.10.0 (Confluence) vs current (Docusaurus).
 *
 * NOT a durable CI gate (issue #53 maintainer note). It answers a single, time-boxed
 * question: did the Confluence→Docusaurus corpus swap regress what `routeros_search` finds
 * for the golden queries, measured against the last Confluence release (v0.10.0)?
 *
 * Why it can't reuse retrieval.ts's page-recall: the golden set keys on `pages.rosetta_id`,
 * which only Docusaurus-era DBs have — the v0.10.0 Confluence DB has no rosetta_id column at
 * all. So this matches on a CORPUS-AGNOSTIC topic token (see TOPICS below): does any top-5
 * page's title/url mention the query's topic? That is comparable across both corpora.
 *
 * Usage (spawns one child per DB so each gets its own db.ts singleton):
 *   bun run src/eval/corpus-compare.ts --old <v0.10.0.db> --new <current.db>
 * Internal (single DB, emits per-query JSON on stdout — you normally don't call this directly):
 *   DB_PATH=<db> bun run src/eval/corpus-compare.ts --emit
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// Corpus-agnostic topic token per SEARCH query id. Chosen by hand (this is a one-off) so the
// match is precise on both a Docusaurus rosetta_id/url and a Confluence page title/url. Only
// prose-retrieval queries are compared; device/version/command-path queries test the (corpus-
// independent) classifier, and the direct surfaces are Docusaurus-only, so both are excluded.
const TOPICS: Record<string, string[]> = {
  "nl-dhcp-server": ["dhcp"],
  "nl-firewall-filter": ["firewall", "filter", "address-list", "address list"],
  "nl-bridge-vlan": ["vlan"],
  "nl-wireguard": ["wireguard"],
  "nl-container": ["container"],
  "nl-bgp": ["bgp"],
  "nl-ospf": ["ospf"],
  "nl-scheduler": ["scheduler"],
  "nl-routerboot": ["routerboot"],
  "nl-capsman": ["capsman"],
  "nl-ipsec": ["ipsec"],
  "nl-vlan": ["vlan"],
  "nl-pppoe": ["pppoe"],
  "nl-dns": ["dns"],
  "prop-search-mtu": ["mtu"],
  "topic-firewall-classify": ["firewall", "mangle"],
};

type EmitRow = { id: string; query: string; topics: string[]; hit: boolean; top5: string[] };

function emit(): void {
  // Lazy imports so the child only touches db.ts (via DB_PATH) in --emit mode.
  const { searchAll } = require("../query.ts") as typeof import("../query.ts");
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dir, "../../fixtures/eval/queries.json"), "utf-8"),
  ) as { queries: { id: string; query: string; surface?: string; shape?: string }[] };

  // Mirror retrieval.ts's effectiveSurface(): a property/changelog/video SHAPE is a direct
  // surface even if `surface` is unset, so a fixture that sets shape but forgets surface can't
  // sneak into the search comparison here.
  const directShapes = new Set(["property", "changelog", "video"]);
  const effectiveSurface = (q: { surface?: string; shape?: string }): string =>
    (q.shape && directShapes.has(q.shape) ? q.shape : q.surface) ?? "search";

  const out: EmitRow[] = [];
  for (const q of fixture.queries) {
    if (effectiveSurface(q) !== "search") continue;
    const topics = TOPICS[q.id];
    if (!topics) continue;
    const resp = searchAll(q.query, 5);
    const top5 = resp.pages.slice(0, 5).map((p) => `${p.title} :: ${p.url}`);
    const hay = top5.join(" | ").toLowerCase();
    const hit = topics.some((t) => hay.includes(t.toLowerCase()));
    out.push({ id: q.id, query: q.query, topics, hit, top5 });
  }
  process.stdout.write(JSON.stringify(out));
}

function runChild(dbPath: string): EmitRow[] {
  const proc = Bun.spawnSync(["bun", "run", join(import.meta.dir, "corpus-compare.ts"), "--emit"], {
    env: { ...process.env, DB_PATH: dbPath },
    stdout: "pipe",
    stderr: "inherit",
  });
  if (!proc.success) throw new Error(`child failed for DB_PATH=${dbPath}`);
  return JSON.parse(proc.stdout.toString()) as EmitRow[];
}

function compare(oldDb: string, newDb: string): void {
  const oldRows = new Map(runChild(oldDb).map((r) => [r.id, r]));
  const newRows = runChild(newDb);

  let oldHits = 0;
  let newHits = 0;
  const regressions: EmitRow[] = [];
  const recoveries: string[] = [];

  console.log(`\n0.10.0 (Confluence)  vs  current (Docusaurus) — topic-token hit@5\n`);
  console.log(`  ${"query id".padEnd(24)} 0.10.0  current`);
  console.log(`  ${"-".repeat(24)} ------  -------`);
  for (const nw of newRows) {
    const od = oldRows.get(nw.id);
    const o = od?.hit ?? false;
    if (o) oldHits++;
    if (nw.hit) newHits++;
    const mark = o === nw.hit ? "  " : nw.hit ? "↑ recovered" : "↓ REGRESSED";
    console.log(`  ${nw.id.padEnd(24)} ${(o ? "hit" : "MISS").padEnd(6)}  ${(nw.hit ? "hit" : "MISS").padEnd(6)}  ${mark}`);
    if (o && !nw.hit) regressions.push(nw);
    if (!o && nw.hit) recoveries.push(nw.id);
  }
  const n = newRows.length;
  console.log(`\n  Aggregate: 0.10.0 ${oldHits}/${n} (${((oldHits / n) * 100).toFixed(0)}%)  →  current ${newHits}/${n} (${((newHits / n) * 100).toFixed(0)}%)`);
  if (recoveries.length) console.log(`  Recovered on current: ${recoveries.join(", ")}`);
  if (regressions.length === 0) {
    console.log(`  ✅ No topic-level regression vs 0.10.0 on the compared queries.`);
  } else {
    console.log(`  ⚠️  ${regressions.length} topic-level regression(s) vs 0.10.0 — investigate:`);
    for (const r of regressions) {
      console.log(`     [${r.id}] "${r.query}" (want any of: ${r.topics.join(", ")})`);
      for (const t of r.top5) console.log(`         ${t}`);
    }
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--emit")) {
    emit();
  } else {
    const oldIdx = args.indexOf("--old");
    const newIdx = args.indexOf("--new");
    if (oldIdx < 0 || newIdx < 0) {
      console.error("usage: bun run src/eval/corpus-compare.ts --old <v0.10.0.db> --new <current.db>");
      process.exit(2);
    }
    compare(args[oldIdx + 1] as string, args[newIdx + 1] as string);
  }
}
