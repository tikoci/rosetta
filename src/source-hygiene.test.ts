/**
 * source-hygiene.test.ts — structural guards over the source tree itself, not runtime behavior.
 *
 * Two cheap, DB-less scans that make two "passes every other check but silently breaks" hazards
 * enforced rather than remembered (issue #98):
 *
 *   1. db.ts import guard — no `*.test.ts` that sets `process.env.DB_PATH` may *statically* import
 *      a module that transitively reaches `db.ts`. A static ESM import is hoisted ABOVE the
 *      `process.env.DB_PATH = ":memory:"` assignment, so `db.ts`'s module-scope
 *      `new sqlite(DB_PATH)` opens the real on-disk ros-help.db instead of :memory:. That poisons
 *      the singleton for every later test file in the run; query.test.ts's V-db-wipe-guard then
 *      trips — but ONLY when the offending file happens to load db.ts first, so it presents as an
 *      order-dependent CI flake (bun's file order is not stable). This is the durable fix for that
 *      hazard: it blocks the violation at author time instead of catching it on unlucky ordering.
 *      `import type` is erased by the transpiler and stays allowed. See
 *      `.github/instructions/extractor-import-side-effects.instructions.md` (hazard 2) and
 *      VALIDATION.md V-test-db-import-static-guard.
 *
 *   2. Control characters in source — no source file may contain a NUL or other disallowed C0/DEL
 *      control byte. A stray NUL in a template literal makes `file` report the source as `data`
 *      and causes grep to silently match nothing in it, while tests/typecheck/biome all pass
 *      (the "Related" NUL-byte note on issue #98). Tab/newline/CR are allowed. See VALIDATION.md
 *      V-source-no-control-chars.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

const SRC_DIR = resolve(import.meta.dirname);

/** Every `*.ts` file under src/, recursively (absolute paths). */
function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Resolve a local relative import specifier to an absolute `.ts` path, or null if it is not a
 * local module (bare package or node: builtin). Adds `.ts`, and resolves a directory to its
 * `index.ts`, mirroring how bun resolves these files.
 */
function resolveLocal(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  if (extname(base) === ".ts") return base;
  const withTs = `${base}.ts`;
  try {
    if (statSync(withTs).isFile()) return withTs;
  } catch {}
  try {
    if (statSync(base).isDirectory()) return join(base, "index.ts");
  } catch {}
  return extname(base) ? base : withTs;
}

/**
 * Static VALUE imports of local modules in `source`. Statement-level `import type … from` is
 * erased by the transpiler and excluded; everything else that loads a module at runtime is
 * included (named/default/namespace and bare side-effect `import "./x"`). Dynamic `await import()`
 * is deliberately NOT matched — that is the safe form these tests are meant to steer authors to.
 */
function staticLocalValueImports(fromFile: string, source: string): string[] {
  const specs: string[] = [];
  // `import [type] <clause> from "<spec>"` — [\s\S]*? spans multi-line specifier lists up to `from`.
  const fromRe = /^import\s+(type\s+)?[\s\S]*?from\s*["']([^"']+)["']/gm;
  for (const m of source.matchAll(fromRe)) {
    if (m[1]) continue; // statement-level `import type` — erased, safe
    const local = resolveLocal(fromFile, m[2]);
    if (local) specs.push(local);
  }
  // Bare side-effect import: `import "./x"` (no clause, no `from`).
  const bareRe = /^import\s+["']([^"']+)["']/gm;
  for (const m of source.matchAll(bareRe)) {
    const local = resolveLocal(fromFile, m[1]);
    if (local) specs.push(local);
  }
  return specs;
}

const tsFiles = listTsFiles(SRC_DIR);
const sources = new Map<string, string>(tsFiles.map((f) => [f, readFileSync(f, "utf-8")]));
const valueImports = new Map<string, string[]>(
  tsFiles.map((f) => [f, staticLocalValueImports(f, sources.get(f) ?? "")]),
);

/** Closure of modules that statically (value-)reach db.ts, seeded with db.ts itself. */
function computeReachesDb(): Set<string> {
  const dbPath = join(SRC_DIR, "db.ts");
  const reaches = new Set<string>([dbPath]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [file, imports] of valueImports) {
      if (reaches.has(file)) continue;
      if (imports.some((i) => reaches.has(i))) {
        reaches.add(file);
        grew = true;
      }
    }
  }
  return reaches;
}

describe("db.ts import guard (issue #98, V-test-db-import-static-guard)", () => {
  const reachesDb = computeReachesDb();

  // Sanity: the closure must actually include a known db.ts-reaching module, else a broken
  // resolver would make every assertion below vacuously pass.
  test("closure includes query.ts (guards against a broken import resolver)", () => {
    expect(reachesDb.has(join(SRC_DIR, "query.ts"))).toBe(true);
  });

  const dbPathTests = tsFiles.filter(
    (f) => f.endsWith(".test.ts") && /process\.env\.DB_PATH\s*=/.test(sources.get(f) ?? ""),
  );

  test("found the DB_PATH-setting test files (guards against a broken scan)", () => {
    expect(dbPathTests.length).toBeGreaterThan(0);
  });

  for (const file of dbPathTests) {
    const rel = file.slice(SRC_DIR.length + 1);
    test(`${rel} has no static db.ts-reaching import`, () => {
      const offenders = (valueImports.get(file) ?? [])
        .filter((i) => reachesDb.has(i))
        .map((i) => i.slice(SRC_DIR.length + 1));
      expect(
        offenders,
        `${rel} sets process.env.DB_PATH but statically imports [${offenders.join(", ")}], which ` +
          `transitively loads db.ts. A static import is hoisted above the env assignment, so db.ts ` +
          `opens the real on-disk DB instead of :memory:. Use dynamic \`await import(...)\` (or ` +
          `\`import type\` if the binding is type-only). See extractor-import-side-effects.instructions.md.`,
      ).toEqual([]);
    });
  }
});

describe("control characters in source (issue #98 Related, V-source-no-control-chars)", () => {
  // Disallowed: C0 controls (0x00–0x1F) except tab (0x09) / newline (0x0A) / CR (0x0D), plus DEL
  // (0x7F). Scanned by char code rather than a regex literal, so this guard doesn't itself carry
  // the control characters it forbids (which biome's noControlCharactersInRegex would reject).
  const isDisallowed = (c: number) => (c <= 0x1f && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f;

  for (const file of tsFiles) {
    const rel = file.slice(SRC_DIR.length + 1);
    test(`${rel} contains no NUL or disallowed control character`, () => {
      const src = sources.get(file) ?? "";
      let idx = -1;
      for (let i = 0; i < src.length; i++) {
        if (isDisallowed(src.charCodeAt(i))) {
          idx = i;
          break;
        }
      }
      if (idx === -1) {
        expect(true).toBe(true);
        return;
      }
      // Report the first offender with line/col and codepoint for a one-read diagnosis.
      const code = src.charCodeAt(idx).toString(16).padStart(2, "0").toUpperCase();
      const before = src.slice(0, idx);
      const line = before.split("\n").length;
      const col = idx - before.lastIndexOf("\n");
      throw new Error(
        `${rel}:${line}:${col} contains a disallowed control character (U+00${code}). ` +
          `A stray NUL/control byte makes \`file\` report the source as data and causes grep to ` +
          `silently match nothing, while tests/typecheck/biome still pass. Remove it.`,
      );
    });
  }
});
