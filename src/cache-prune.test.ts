import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pruneCache } from "./cache-prune.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rosetta-cache-prune-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(...paths: string[]): void {
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), p);
  }
}

/** Every file under dir, as sorted `/`-separated relative paths. */
function listing(): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((p) => statSync(join(dir, p)).isFile())
    .sort();
}

describe("pruneCache (#160)", () => {
  test("leaves exactly the discovered pages plus the index files", () => {
    seed("_sitemap.txt", "_llms.txt", "ip__address.md", "ip__route.md", "gone__page.md");
    const removed = pruneCache(dir, ["ip__address.md", "ip__route.md"], ".md");
    expect(removed).toEqual(["gone__page.md"]);
    expect(listing()).toEqual(["_llms.txt", "_sitemap.txt", "ip__address.md", "ip__route.md"]);
  });

  test("recurses into nested page paths and removes the directories it empties", () => {
    seed("docs/a/kept.md", "docs/a/stale.md", "docs/b/only-stale.md");
    expect(pruneCache(dir, ["docs/a/kept.md"], ".md")).toEqual(["docs/a/stale.md", "docs/b/only-stale.md"]);
    expect(listing()).toEqual(["docs/a/kept.md"]);
    expect(existsSync(join(dir, "docs", "b"))).toBe(false);
  });

  test("never touches files of another extension, e.g. a sibling cache nested under the same root", () => {
    // manual/pages/ holds docusaurus *.md beside the hardware/ and www/ *.html caches.
    seed("docs/page.md", "hardware/rb5009.html", "www/RB5009UG.html", ".DS_Store");
    expect(pruneCache(dir, ["docs/page.md"], ".md")).toEqual([]);
    expect(listing()).toEqual([".DS_Store", "docs/page.md", "hardware/rb5009.html", "www/RB5009UG.html"]);
  });

  test("refuses an empty keep set rather than wiping the cache", () => {
    seed("page.html");
    expect(() => pruneCache(dir, [], ".html")).toThrow(/empty page set/);
    expect(listing()).toEqual(["page.html"]);
  });
});
