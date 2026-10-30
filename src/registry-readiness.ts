/**
 * registry-readiness.ts — wait for a package version to be visible through
 * the abbreviated install manifest Bun consumes (#202, #226).
 *
 * The release-smoke readiness loops used to poll `npm view`, which reads the
 * full packument. Bun resolves from the abbreviated install manifest
 * (`Accept: application/vnd.npm.install-v1+json`), and that can lag behind
 * the full packument — twice (0.11.3, 0.12.0-next.123) a wait loop passed
 * and the subsequent `bunx` failed with `No version matching`.
 *
 * Two gates, one per smoke path: `waitForExactVersion` for the fresh-install
 * path (`bunx pkg@<version>`), `waitForTagVersion` for the upgrade path
 * (`bunx pkg@<tag>`, decision B on #226). Neither gate covers a warm bare
 * `bunx` invocation, which serves the cache with zero registry requests —
 * the bare form is deliberately not gated; bare-form staleness is accepted,
 * documented behavior (MANUAL "How Updates Work").
 */

export const ABBREVIATED_MANIFEST_ACCEPT = "application/vnd.npm.install-v1+json";
export const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

/** Strict semver shape with an optional prerelease/build suffix — no tags, no ranges. */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * True for an exact installable version (`1.2.3`, `0.12.0-next.123`).
 * Rejects dist-tags (`latest`, `next`), ranges (`^1.2.3`), and the `v`
 * prefix (callers strip it first — npm versions are unprefixed).
 */
export function isExactVersion(spec: string): boolean {
  return EXACT_VERSION_RE.test(spec);
}

/** Dist-tag shape: a word, never an exact version, range, or empty string. */
const DIST_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * True for a dist-tag (`latest`, `next`). Rejects exact versions (with or
 * without the `v` prefix — a `v`-prefixed version is a caller that forgot
 * to strip it, not a tag), ranges, and empty/whitespace specs.
 */
export function isDistTag(spec: string): boolean {
  return DIST_TAG_RE.test(spec) && !isExactVersion(spec.replace(/^v/, ""));
}

/** Packument URL for a package, matching npm CLI's scoped-name encoding (`/` → `%2f`). */
export function manifestUrl(registry: string, name: string): string {
  return `${registry.replace(/\/+$/, "")}/${name.replaceAll("/", "%2f")}`;
}

export interface ManifestCheck {
  ready: boolean;
  /** Human-readable verdict: the tarball URL when ready, the gap when not. */
  reason: string;
  tarball?: string;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Pure readiness verdict over one abbreviated-manifest document: the exact
 * version must be present with a usable `dist.tarball` reference. For this
 * exact-version gate, a dist-tag or full-metadata-only match is NOT
 * readiness — the caller must pass the abbreviated document Bun would read.
 * (The tag form has its own gate, `checkTagManifest`, below.)
 *
 * Known limitation: the gate checks the tarball URL's shape but never HEADs
 * it, so a partial publish (metadata live, bytes missing) passes here and
 * fails at bunx. Accepted as negligible — npm publish is effectively atomic,
 * so that window does not occur in practice.
 */
export function checkAbbreviatedManifest(doc: unknown, version: string): ManifestCheck {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ready: false, reason: "abbreviated manifest is not a JSON object" };
  }
  const versions = (doc as { versions?: unknown }).versions;
  if (typeof versions !== "object" || versions === null || Array.isArray(versions)) {
    return { ready: false, reason: "abbreviated manifest has no versions map" };
  }
  const entry = (versions as Record<string, unknown>)[version];
  if (typeof entry !== "object" || entry === null) {
    const visible = Object.keys(versions as Record<string, unknown>).length;
    return {
      ready: false,
      reason: `version ${version} not in abbreviated manifest (${visible} version(s) visible)`,
    };
  }
  const dist = (entry as { dist?: unknown }).dist;
  const tarball = typeof dist === "object" && dist !== null ? (dist as { tarball?: unknown }).tarball : undefined;
  if (typeof tarball !== "string" || tarball.length === 0 || !isHttpUrl(tarball)) {
    return {
      ready: false,
      reason: `version ${version} has no usable dist.tarball reference`,
    };
  }
  return { ready: true, reason: tarball, tarball };
}

export interface TagCheck extends ManifestCheck {
  /** The version the tag currently resolves to, when the document names one. */
  resolved?: string;
}

/**
 * Pure readiness verdict for the upgrade path (#226): the channel tag must
 * resolve to the expected exact version, and that version must be present
 * with a usable `dist.tarball` reference. A tag match alone is NOT
 * readiness — a moved tag whose version body is missing or has no usable
 * tarball would still fail at `bunx pkg@<tag>`.
 */
export function checkTagManifest(doc: unknown, tag: string, version: string): TagCheck {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ready: false, reason: "abbreviated manifest is not a JSON object" };
  }
  const tags = (doc as { "dist-tags"?: unknown })["dist-tags"];
  if (typeof tags !== "object" || tags === null || Array.isArray(tags)) {
    return { ready: false, reason: "abbreviated manifest has no dist-tags map" };
  }
  const resolved = (tags as Record<string, unknown>)[tag];
  if (typeof resolved !== "string") {
    return { ready: false, reason: `dist-tag ${tag} not in abbreviated manifest` };
  }
  if (resolved !== version) {
    return { ready: false, reason: `dist-tag ${tag} resolves to ${resolved}, want ${version}`, resolved };
  }
  const check = checkAbbreviatedManifest(doc, version);
  return { ...check, resolved };
}

export interface PollOptions {
  name: string;
  registry?: string;
  timeoutMs?: number;
  intervalMs?: number;
  /**
   * Per-attempt fetch bound. Defaults to `min(max(intervalMs, 1s), 30s)`: the
   * floor keeps a small poll interval from causing spurious timeouts, the cap
   * keeps one stalled connection from eating the whole budget.
   */
  attemptTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  onAttempt?: (attempt: number, ok: boolean, detail: string) => void;
}

export interface WaitOptions extends PollOptions {
  version: string;
}

export interface TagWaitOptions extends PollOptions {
  tag: string;
  version: string;
}

export interface WaitOutcome {
  ready: boolean;
  attempts: number;
  elapsedMs: number;
  /** Last observed failure — empty when ready on the first attempt. */
  lastFailure: string;
  tarball?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Read a response body as JSON without throwing — a truncated or non-JSON
 * error page from the registry is a retryable not-ready signal, not an
 * exception. Callers route failures through the shared loop tail.
 */
async function readJsonBody(res: Response): Promise<{ doc: unknown; error?: unknown }> {
  try {
    return { doc: await res.json() };
  } catch (error) {
    return { doc: undefined, error };
  }
}

/**
 * Poll the abbreviated install manifest until `check` passes or the budget
 * expires. Bounded: every attempt carries its own timeout, so a stalled
 * connection fails one attempt instead of hanging the wait, and the loop
 * returns once `timeoutMs` elapses. Registry-side failures are returned as
 * `{ ready: false, lastFailure }` for diagnostics; only caller errors throw,
 * and those are raised by the calling gate before delegating here.
 */
async function pollManifest(poll: PollOptions, check: (doc: unknown) => ManifestCheck): Promise<WaitOutcome> {
  const {
    name,
    registry = DEFAULT_REGISTRY,
    timeoutMs = 900_000,
    intervalMs = 5_000,
    attemptTimeoutMs = Math.min(Math.max(intervalMs, 1_000), 30_000),
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
    onAttempt,
  } = poll;
  const url = manifestUrl(registry, name);
  const started = Date.now();
  let attempts = 0;
  let lastFailure = "";
  for (;;) {
    attempts += 1;
    let detail: string;
    let tarball: string | undefined;
    try {
      // Bound the attempt twice over: the AbortSignal lets a well-behaved
      // fetch release its socket, and the race bounds even an implementation
      // that ignores the signal (including injected mocks).
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`attempt timed out after ${attemptTimeoutMs}ms`));
        }, attemptTimeoutMs);
      });
      try {
        const res = await Promise.race([
          fetchImpl(url, {
            headers: { Accept: ABBREVIATED_MANIFEST_ACCEPT },
            signal: controller.signal,
          }),
          timeout,
        ]);
        if (!res.ok) {
          detail = `HTTP ${res.status} ${res.statusText} from ${url}`;
        } else {
          const body = await readJsonBody(res);
          if (body.error !== undefined) {
            const e = body.error;
            detail = `invalid JSON in abbreviated manifest from ${url}: ${e instanceof Error ? e.message : e}`;
          } else {
            const verdict = check(body.doc);
            if (verdict.ready) {
              tarball = verdict.tarball;
              detail = verdict.reason;
              onAttempt?.(attempts, true, detail);
              return { ready: true, attempts, elapsedMs: Date.now() - started, lastFailure, tarball };
            }
            detail = `${verdict.reason} (via ${url})`;
          }
        }
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } catch (e) {
      // Network/transport failure — the registry endpoint itself is unreachable.
      detail = `request to ${url} failed: ${e instanceof Error ? e.message : e}`;
    }
    lastFailure = detail;
    onAttempt?.(attempts, false, detail);
    if (Date.now() - started >= timeoutMs) break;
    await sleepImpl(intervalMs);
  }
  return { ready: false, attempts, elapsedMs: Date.now() - started, lastFailure };
}

/**
 * Gate the exact-version fresh-install path: poll until the exact version is
 * servable through the abbreviated install manifest. Throws only for caller
 * errors (non-exact version).
 */
export async function waitForExactVersion(opts: WaitOptions): Promise<WaitOutcome> {
  const { version, ...poll } = opts;
  if (!isExactVersion(version)) {
    throw new Error(
      `refusing to wait on "${version}": this gate is exact-version-only, not a dist-tag or range probe`,
    );
  }
  return pollManifest(poll, (doc) => checkAbbreviatedManifest(doc, version));
}

/**
 * Gate the upgrade path (#226): poll until the channel tag resolves to the
 * expected exact version with a servable tarball. Throws only for caller
 * errors (non-tag, or a version that is not exact).
 */
export async function waitForTagVersion(opts: TagWaitOptions): Promise<WaitOutcome> {
  const { tag, version, ...poll } = opts;
  if (!isDistTag(tag)) {
    throw new Error(`refusing to wait on tag "${tag}": expected a dist-tag such as latest or next`);
  }
  if (!isExactVersion(version)) {
    throw new Error(
      `refusing to wait on "${version}": this gate is exact-version-only, not a dist-tag or range probe`,
    );
  }
  return pollManifest(poll, (doc) => checkTagManifest(doc, tag, version));
}
