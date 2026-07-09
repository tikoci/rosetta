import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.DB_PATH = ":memory:";

const { githubApiHeaders } = await import("./github.ts");
const ROOT = join(import.meta.dirname, "..");

function readText(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf-8");
}

describe("extract-skills GitHub API headers", () => {
  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });

  test("keeps unauthenticated headers when no token is configured", () => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;

    expect(githubApiHeaders()).toEqual({
      Accept: "application/vnd.github.v3+json",
    });
  });

  test("uses GITHUB_TOKEN for authenticated API requests", () => {
    process.env.GITHUB_TOKEN = "test-token";

    expect(githubApiHeaders()).toEqual({
      Accept: "application/vnd.github.v3+json",
      Authorization: "Bearer test-token",
    });
  });

  test("falls back to GH_TOKEN for local authenticated runs", () => {
    process.env.GH_TOKEN = "gh-token";

    expect(githubApiHeaders()).toEqual({
      Accept: "application/vnd.github.v3+json",
      Authorization: "Bearer gh-token",
    });
  });

  test("supports GitHub raw content API accept header while preserving auth", () => {
    process.env.GITHUB_TOKEN = "raw-token";

    expect(githubApiHeaders("application/vnd.github.v3.raw")).toEqual({
      Accept: "application/vnd.github.v3.raw",
      Authorization: "Bearer raw-token",
    });
  });
});

describe("extract-skills GitHub fetch shape", () => {
  test("fetches skill files through the authenticated Contents API, not raw.githubusercontent.com", () => {
    const src = readText("src/extract-skills.ts");

    expect(src).not.toContain("raw.githubusercontent.com");
    expect(src).toContain("/contents/");
    expect(src).toContain('githubApiHeaders("application/vnd.github.v3.raw")');
    expect(src).toContain("fetchGitHub");
  });

  test("release.yml passes GITHUB_TOKEN to the skills extraction step", () => {
    const yml = readText(".github/workflows/release.yml");
    const skillsIdx = yml.indexOf("Extract agent skills from GitHub");
    const linkIdx = yml.indexOf("Link commands to pages");
    expect(skillsIdx).toBeGreaterThanOrEqual(0);
    expect(linkIdx).toBeGreaterThan(skillsIdx);

    const block = yml.slice(skillsIdx, linkIdx);
    expect(block).toContain("GITHUB_TOKEN: $" + "{{ github.token }}");
    expect(block).toContain("bun run src/extract-skills.ts");
  });
});
