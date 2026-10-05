/**
 * restraml.ts — Shared helpers for fetching data from tikoci/restraml.
 *
 * restraml publishes inspect.json files to GitHub Pages. Version discovery
 * uses the authenticated GitHub API when a token is available (1 call), but
 * all inspect.json fetches go through GitHub Pages (no rate limit).
 */

import { fetchGitHub, githubApiHeaders } from "./github.ts";

/** GitHub Pages base URL — inspect.json files served here (no rate limit) */
export const RESTRAML_PAGES_URL = "https://tikoci.github.io/restraml";

/** GitHub API endpoint for version directory listing. */
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
  const response = await fetchGitHub(RESTRAML_API_CONTENTS_URL, {
    headers: githubApiHeaders(),
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

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Per-attempt limit, covering the body read too. A stalled connection then retries. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Thrown from a `read` callback to stop retrying (e.g. a 404). */
class FatalFetchError extends Error {}

/**
 * One attempt loop for status, network and body failures: GitHub Pages serves routine
 * transient 503s, and one of those dropped 7.15 from a release (#178). A network error,
 * a timeout, a 5xx, or a failure inside `read` (a reset or truncated body) retries with
 * exponential backoff, up to `attempts` requests in total. A non-5xx response goes
 * straight to `read`, which throws FatalFetchError to fail at once. Each attempt gets
 * its own timeout, covering the body read, unless the caller passes a signal.
 */
async function withRetry<T>(
  url: string,
  init: RequestInit,
  { attempts = 4, baseDelayMs = 1000, timeoutMs = 120_000, fetchImpl = fetch }: RetryOptions,
  read: (response: Response) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts;
    try {
      const response = await fetchImpl(url, { ...init, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
      if (response.status < 500 || last) return await read(response);
      console.warn(`  ${url}: HTTP ${response.status}, retry ${attempt}/${attempts - 1}`);
    } catch (e) {
      if (last || e instanceof FatalFetchError) throw e;
      console.warn(`  ${url}: ${(e as Error).message}, retry ${attempt}/${attempts - 1}`);
    }
    await Bun.sleep(baseDelayMs * 2 ** (attempt - 1));
  }
}

/**
 * fetch() with the retry policy above. After the last attempt the final response is
 * returned (or the final network error thrown) for the caller to handle.
 */
export function fetchWithRetry(url: string, init: RequestInit = {}, retry: RetryOptions = {}): Promise<Response> {
  return withRetry(url, init, retry, async (response) => response);
}

/**
 * Load a JSON file from a URL or local path. A URL load retries 5xx, network and
 * body-read failures in one budget; any other error status fails at once.
 */
export async function loadJson<T = unknown>(source: string, retry: RetryOptions = {}): Promise<T> {
  if (isHttpUrl(source)) {
    return withRetry(source, {}, retry, async (response) => {
      if (!response.ok) throw new FatalFetchError(`Failed to fetch ${source}: HTTP ${response.status}`);
      return (await response.json()) as T;
    });
  }
  return (await Bun.file(source).json()) as T;
}
