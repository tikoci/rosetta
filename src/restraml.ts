/**
 * restraml.ts — Shared helpers for fetching data from tikoci/restraml.
 *
 * restraml publishes inspect.json files to GitHub Pages. Version discovery
 * uses the GitHub API (1 call), but all inspect.json fetches go through
 * GitHub Pages (no rate limit).
 */

/** GitHub Pages base URL — inspect.json files served here (no rate limit) */
export const RESTRAML_PAGES_URL = "https://tikoci.github.io/restraml";

/** GitHub API endpoint for version directory listing (60 req/hr unauthenticated) */
const RESTRAML_API_CONTENTS_URL = "https://api.github.com/repos/tikoci/restraml/contents/docs";

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

interface GitHubContentEntry {
  name: string;
  type: "file" | "dir";
}

/**
 * Discover available RouterOS versions from the restraml GitHub repo.
 * Uses 1 GitHub API call to list the docs/ directory, returns version strings.
 */
export async function discoverRemoteVersions(): Promise<string[]> {
  const response = await fetch(RESTRAML_API_CONTENTS_URL, {
    headers: { Accept: "application/vnd.github.v3+json" },
  });

  if (!response.ok) {
    const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
    const detail = rateLimitRemaining === "0"
      ? " (GitHub API rate limit exceeded — try again later or pass a local docs path)"
      : "";
    throw new Error(
      `Failed to list restraml versions: HTTP ${response.status}${detail}`,
    );
  }

  const entries = (await response.json()) as GitHubContentEntry[];
  return entries
    .filter((e) => e.type === "dir" && /^\d+\.\d+/.test(e.name))
    .map((e) => e.name);
}

/**
 * Load a JSON file from a URL or local path.
 */
export async function loadJson<T = unknown>(source: string): Promise<T> {
  if (isHttpUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${source}: HTTP ${response.status}`);
    }
    return (await response.json()) as T;
  }
  return (await Bun.file(source).json()) as T;
}
