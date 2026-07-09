import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

function readText(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf-8");
}

describe("restraml GitHub version discovery", () => {
  test("uses authenticated GitHub helper for API version discovery", () => {
    const src = readText("src/restraml.ts");

    expect(src).toContain('from "./github.ts"');
    expect(src).toContain("fetchGitHub(RESTRAML_API_CONTENTS_URL");
    expect(src).toContain("headers: githubApiHeaders()");
  });

  test("release.yml passes GITHUB_TOKEN to extract-all-versions", () => {
    const yml = readText(".github/workflows/release.yml");
    const commandIdx = yml.indexOf("Extract command tree");
    const devicesIdx = yml.indexOf("Extract devices");
    expect(commandIdx).toBeGreaterThanOrEqual(0);
    expect(devicesIdx).toBeGreaterThan(commandIdx);

    const block = yml.slice(commandIdx, devicesIdx);
    expect(block).toContain("GITHUB_TOKEN: $" + "{{ github.token }}");
    expect(block).toContain("bun run src/extract-all-versions.ts");
  });
});
