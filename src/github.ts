/**
 * github.ts — Small helpers for authenticated GitHub HTTP calls.
 *
 * Release extraction runs from GitHub Actions shared runner IPs, so every
 * GitHub API request should use GITHUB_TOKEN/GH_TOKEN when available and retry
 * transient throttling responses.
 */

const DEFAULT_ACCEPT = "application/vnd.github.v3+json";
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export function githubApiHeaders(accept = DEFAULT_ACCEPT): Record<string, string> {
  const headers: Record<string, string> = { Accept: accept };
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function retryAfterMs(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

export function defaultRetryDelayMs(response: Response, attempt: number): number {
  const retryAfter = retryAfterMs(response.headers.get("retry-after"));
  if (retryAfter !== null) return retryAfter;

  const resetSeconds = Number(response.headers.get("x-ratelimit-reset") ?? NaN);
  const remaining = response.headers.get("x-ratelimit-remaining");
  if (remaining === "0" && Number.isFinite(resetSeconds)) {
    return Math.max(0, resetSeconds * 1000 - Date.now());
  }

  return 1000 * 2 ** attempt;
}

export function shouldRetry(response: Response): boolean {
  if (RETRYABLE_STATUSES.has(response.status)) return true;
  if (response.status !== 403) return false;
  // Primary rate limit (remaining=0) or secondary/abuse-detection limit
  // (Retry-After present even with quota remaining) are both retryable.
  return response.headers.get("x-ratelimit-remaining") === "0" || response.headers.get("retry-after") !== null;
}

export async function fetchGitHub(
  url: string,
  options: RequestInit = {},
  retries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const response = await fetch(url, options);
    if (!shouldRetry(response) || attempt === retries) return response;

    const delayMs = Math.min(defaultRetryDelayMs(response, attempt), 30_000);
    console.warn(`GitHub request throttled (HTTP ${response.status}); retrying in ${Math.round(delayMs / 1000)}s`);
    await Bun.sleep(delayMs);
  }

  // Unreachable in practice: every caller uses the default `retries`, and the
  // loop always returns on its `attempt === retries` iteration. `fetch` is
  // called once more here only so TypeScript sees every path return a Response.
  return fetch(url, options);
}
