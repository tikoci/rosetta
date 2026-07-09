import { describe, expect, test } from "bun:test";
import { defaultRetryDelayMs, shouldRetry } from "./github.ts";

function fakeResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

describe("shouldRetry", () => {
  test("retries plain transient statuses", () => {
    expect(shouldRetry(fakeResponse(429))).toBe(true);
    expect(shouldRetry(fakeResponse(500))).toBe(true);
    expect(shouldRetry(fakeResponse(502))).toBe(true);
    expect(shouldRetry(fakeResponse(503))).toBe(true);
    expect(shouldRetry(fakeResponse(504))).toBe(true);
  });

  test("retries 403 primary rate limit exhaustion", () => {
    expect(shouldRetry(fakeResponse(403, { "x-ratelimit-remaining": "0" }))).toBe(true);
  });

  test("retries 403 secondary/abuse-detection limit even when quota remains", () => {
    // GitHub secondary rate limits return 403 + Retry-After without touching
    // x-ratelimit-remaining, since they're not tied to the primary quota.
    expect(
      shouldRetry(fakeResponse(403, { "retry-after": "30", "x-ratelimit-remaining": "42" })),
    ).toBe(true);
  });

  test("does not retry plain permission-denied 403s", () => {
    expect(shouldRetry(fakeResponse(403))).toBe(false);
    expect(shouldRetry(fakeResponse(403, { "x-ratelimit-remaining": "42" }))).toBe(false);
  });

  test("does not retry success or not-found responses", () => {
    expect(shouldRetry(fakeResponse(200))).toBe(false);
    expect(shouldRetry(fakeResponse(404))).toBe(false);
  });
});

describe("defaultRetryDelayMs", () => {
  test("falls back to exponential backoff when x-ratelimit-reset header is missing", () => {
    // Regression: Number(null) is 0 (finite), which previously made the reset
    // branch return an immediate 0ms delay instead of falling through.
    const delay = defaultRetryDelayMs(fakeResponse(403, { "x-ratelimit-remaining": "0" }), 2);
    expect(delay).toBe(1000 * 2 ** 2);
  });

  test("uses x-ratelimit-reset when present and remaining is exhausted", () => {
    const resetAt = Math.floor(Date.now() / 1000) + 5;
    const delay = defaultRetryDelayMs(
      fakeResponse(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) }),
      0,
    );
    expect(delay).toBeGreaterThan(3000);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  test("prefers retry-after over rate-limit reset", () => {
    const delay = defaultRetryDelayMs(
      fakeResponse(403, { "retry-after": "10", "x-ratelimit-remaining": "0", "x-ratelimit-reset": "0" }),
      0,
    );
    expect(delay).toBe(10_000);
  });

  test("falls back to exponential backoff with no relevant headers", () => {
    expect(defaultRetryDelayMs(fakeResponse(500), 0)).toBe(1000);
    expect(defaultRetryDelayMs(fakeResponse(500), 3)).toBe(8000);
  });
});
