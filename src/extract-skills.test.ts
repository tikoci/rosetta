import { afterEach, describe, expect, test } from "bun:test";

process.env.DB_PATH = ":memory:";

const { githubApiHeaders } = await import("./extract-skills.ts");

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
});