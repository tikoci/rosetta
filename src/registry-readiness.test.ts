/**
 * registry-readiness.test.ts — exact-version abbreviated-manifest gate (#202).
 *
 * Fully offline: every integration case runs against a localhost Bun.serve
 * mock registry with temp-dir fixtures, and the bunx cases use an isolated
 * BUN_INSTALL_CACHE_DIR + HOME so they never touch the real cache, the real
 * registry, or Rosetta's DB.
 */
// cspell:words tgz czf
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ABBREVIATED_MANIFEST_ACCEPT,
  checkAbbreviatedManifest,
  checkTagManifest,
  isDistTag,
  isExactVersion,
  manifestUrl,
  waitForExactVersion,
  waitForTagVersion,
} from "./registry-readiness.ts";

describe("isExactVersion", () => {
  test("accepts bare and prerelease semver", () => {
    expect(isExactVersion("1.0.0")).toBe(true);
    expect(isExactVersion("0.12.0-next.123")).toBe(true);
    expect(isExactVersion("7.26.1")).toBe(true);
  });

  test("rejects dist-tags, ranges, and the v prefix", () => {
    for (const spec of ["latest", "next", "^1.2.3", ">=1.0.0", "*", "", "v1.2.3", "1.2", "1.2.3.4"]) {
      expect(isExactVersion(spec)).toBe(false);
    }
  });
});

describe("isDistTag", () => {
  test("accepts channel tags", () => {
    expect(isDistTag("latest")).toBe(true);
    expect(isDistTag("next")).toBe(true);
  });

  test("rejects exact versions, ranges, and empty/whitespace specs", () => {
    for (const spec of ["1.0.1", "0.12.0-next.123", "^1.2.3", "*", "", "a b", "v1.2.3"]) {
      expect(isDistTag(spec)).toBe(false);
    }
  });
});

describe("manifestUrl", () => {
  test("encodes the scoped-name slash like the npm CLI", () => {
    expect(manifestUrl("https://registry.npmjs.org/", "@tikoci/rosetta")).toBe(
      "https://registry.npmjs.org/@tikoci%2frosetta",
    );
  });

  test("tolerates a missing trailing slash", () => {
    expect(manifestUrl("http://127.0.0.1:1", "pkg")).toBe("http://127.0.0.1:1/pkg");
  });

  test("encodes every slash, not just the first", () => {
    expect(manifestUrl("https://r.example/", "@scope/a/b")).toBe("https://r.example/@scope%2fa%2fb");
  });
});

describe("checkAbbreviatedManifest", () => {
  const entry = (tarball: unknown) => ({ name: "pkg", version: "1.0.1", dist: { tarball } });

  test("ready when the exact version carries a usable tarball", () => {
    const check = checkAbbreviatedManifest(
      { name: "pkg", "dist-tags": { latest: "1.0.1" }, versions: { "1.0.0": entry("http://x/1.0.0.tgz"), "1.0.1": entry("http://x/1.0.1.tgz") } },
      "1.0.1",
    );
    expect(check.ready).toBe(true);
    expect(check.tarball).toBe("http://x/1.0.1.tgz");
  });

  test("not ready when the version is absent, even if a dist-tag names it", () => {
    // The 0.11.3 shape: full metadata / dist-tags know the version, the
    // abbreviated install manifest does not. A tag match is not readiness.
    const check = checkAbbreviatedManifest(
      { name: "pkg", "dist-tags": { latest: "1.0.1" }, versions: { "1.0.0": entry("http://x/1.0.0.tgz") } },
      "1.0.1",
    );
    expect(check.ready).toBe(false);
    expect(check.reason).toContain("1.0.1");
  });

  test("not ready without a usable dist.tarball reference", () => {
    for (const tarball of [undefined, "", 42, "not-a-url", "ftp://x/1.0.1.tgz"]) {
      const check = checkAbbreviatedManifest({ versions: { "1.0.1": entry(tarball) } }, "1.0.1");
      expect(check.ready).toBe(false);
      expect(check.reason).toContain("dist.tarball");
    }
  });

  test("not ready on malformed documents", () => {
    for (const doc of [null, [], "x", 42, {}, { versions: null }, { versions: [] }, { versions: { "1.0.1": null } }]) {
      expect(checkAbbreviatedManifest(doc, "1.0.1").ready).toBe(false);
    }
  });
});

describe("checkTagManifest", () => {
  const entry = (tarball: unknown) => ({ name: "pkg", version: "1.0.1", dist: { tarball } });
  const tagged = (tag: string, resolved: unknown, versions: Record<string, unknown>) => ({
    name: "pkg",
    "dist-tags": { [tag]: resolved },
    versions,
  });

  test("ready when the tag resolves to the expected version with a usable tarball", () => {
    const check = checkTagManifest(
      tagged("next", "1.0.1", { "1.0.0": entry("http://x/1.0.0.tgz"), "1.0.1": entry("http://x/1.0.1.tgz") }),
      "next",
      "1.0.1",
    );
    expect(check.ready).toBe(true);
    expect(check.tarball).toBe("http://x/1.0.1.tgz");
    expect(check.resolved).toBe("1.0.1");
  });

  test("not ready when the tag is missing or points at another version", () => {
    const missing = checkTagManifest(tagged("latest", "1.0.0", { "1.0.0": entry("http://x/1.0.0.tgz") }), "next", "1.0.1");
    expect(missing.ready).toBe(false);
    expect(missing.reason).toContain("next");

    const lagging = checkTagManifest(
      tagged("next", "1.0.0", { "1.0.0": entry("http://x/1.0.0.tgz"), "1.0.1": entry("http://x/1.0.1.tgz") }),
      "next",
      "1.0.1",
    );
    expect(lagging.ready).toBe(false);
    expect(lagging.reason).toContain("1.0.0");
    expect(lagging.reason).toContain("1.0.1");
    expect(lagging.resolved).toBe("1.0.0");
  });

  test("a tag match without a servable version body is NOT readiness", () => {
    // The tag moved but the version entry is missing or has no tarball —
    // bunx would still fail, so the gate must not pass.
    const noBody = checkTagManifest(tagged("next", "1.0.1", { "1.0.0": entry("http://x/1.0.0.tgz") }), "next", "1.0.1");
    expect(noBody.ready).toBe(false);

    const noTarball = checkTagManifest(tagged("next", "1.0.1", { "1.0.1": entry(undefined) }), "next", "1.0.1");
    expect(noTarball.ready).toBe(false);
    expect(noTarball.reason).toContain("dist.tarball");
  });

  test("not ready on malformed documents", () => {
    const noTags = { name: "pkg", versions: { "1.0.1": entry("http://x/1.0.1.tgz") } };
    expect(checkTagManifest(noTags, "next", "1.0.1").ready).toBe(false);
    for (const doc of [null, [], "x", 42, {}, { "dist-tags": null }, { "dist-tags": [] }]) {
      expect(checkTagManifest(doc, "next", "1.0.1").ready).toBe(false);
    }
  });
});

describe("waitForExactVersion against a mock registry", () => {
  interface MockRegistry {
    url: string;
    requests: string[];
    stop: () => void;
  }

  function serve(fetchImpl: (req: Request) => Response | Promise<Response>): MockRegistry {
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        requests.push(`${req.method} ${path} accept=${req.headers.get("accept")}`);
        return fetchImpl(req);
      },
    });
    return { url: `http://127.0.0.1:${server.port}/`, requests, stop: () => server.stop(true) };
  }

  const doc = (versions: string[]) => {
    const map: Record<string, unknown> = {};
    for (const version of versions) {
      map[version] = { name: "pkg", version, dist: { tarball: `http://127.0.0.1/x/${version}.tgz` } };
    }
    return Response.json({ name: "pkg", "dist-tags": { latest: versions[versions.length - 1] }, versions: map });
  };

  test("ready immediately when the abbreviated manifest already serves the version", async () => {
    const mock = serve(() => doc(["1.0.0", "1.0.1"]));
    try {
      const outcome = await waitForExactVersion({ name: "pkg", version: "1.0.1", registry: mock.url, intervalMs: 10 });
      expect(outcome.ready).toBe(true);
      expect(outcome.attempts).toBe(1);
      expect(outcome.tarball).toContain("1.0.1.tgz");
      // The probe must read what Bun reads — the abbreviated install manifest.
      expect(mock.requests[0]).toContain(ABBREVIATED_MANIFEST_ACCEPT);
    } finally {
      mock.stop();
    }
  });

  test("full-available / abbreviated-missing is NOT readiness; later abbreviated availability is", async () => {
    // Models the 0.11.3 / next.123 incident: the full packument serves the
    // new version while the abbreviated install manifest still lags.
    let abbreviatedCaughtUp = false;
    const mock = serve((req) => {
      const accept = req.headers.get("accept") ?? "";
      if (!accept.includes(ABBREVIATED_MANIFEST_ACCEPT)) return doc(["1.0.0", "1.0.1"]);
      return abbreviatedCaughtUp ? doc(["1.0.0", "1.0.1"]) : doc(["1.0.0"]);
    });
    try {
      const lagging = await waitForExactVersion({
        name: "pkg",
        version: "1.0.1",
        registry: mock.url,
        timeoutMs: 120,
        intervalMs: 20,
      });
      expect(lagging.ready).toBe(false);
      expect(lagging.lastFailure).toContain("1.0.1");
      // …while a full-metadata read (what `npm view` sees) would have passed.
      const full = (await (await fetch(`${mock.url}pkg`)).json()) as { versions: Record<string, unknown> };
      expect(Object.keys(full.versions)).toContain("1.0.1");

      abbreviatedCaughtUp = true;
      const ready = await waitForExactVersion({ name: "pkg", version: "1.0.1", registry: mock.url, intervalMs: 10 });
      expect(ready.ready).toBe(true);
      expect(ready.tarball).toContain("1.0.1.tgz");
    } finally {
      mock.stop();
    }
  });

  test("recovers from malformed and error responses", async () => {
    let calls = 0;
    const mock = serve(() => {
      calls += 1;
      if (calls === 1) return new Response("{not json", { headers: { "content-type": "application/json" } });
      if (calls === 2) return new Response("boom", { status: 500 });
      return doc(["1.0.1"]);
    });
    try {
      const seen: string[] = [];
      const outcome = await waitForExactVersion({
        name: "pkg",
        version: "1.0.1",
        registry: mock.url,
        intervalMs: 10,
        onAttempt: (_attempt, ok, detail) => {
          if (!ok) seen.push(detail);
        },
      });
      expect(outcome.ready).toBe(true);
      expect(outcome.attempts).toBe(3);
      expect(seen[0]).toContain("invalid JSON");
      expect(seen[1]).toContain("HTTP 500");
    } finally {
      mock.stop();
    }
  });

  test("times out bounded with diagnostics naming the endpoint, version, and last failure", async () => {
    const mock = serve(() => new Response("nope", { status: 404 }));
    try {
      const started = Date.now();
      const outcome = await waitForExactVersion({
        name: "pkg",
        version: "9.9.9",
        registry: mock.url,
        timeoutMs: 150,
        intervalMs: 20,
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(outcome.ready).toBe(false);
      expect(outcome.attempts).toBeGreaterThan(1);
      expect(outcome.lastFailure).toContain("HTTP 404");
      expect(outcome.lastFailure).toContain(mock.url.replace(/\/+$/, ""));
    } finally {
      mock.stop();
    }
  });

  test("refuses dist-tags and ranges instead of waiting on them", async () => {
    await expect(waitForExactVersion({ name: "pkg", version: "latest" })).rejects.toThrow("exact-version-only");
    await expect(waitForExactVersion({ name: "pkg", version: "^1.0.0" })).rejects.toThrow("exact-version-only");
  });
});

describe("waitForTagVersion against a mock registry (#226)", () => {
  function serve(fetchImpl: (req: Request) => Response | Promise<Response>) {
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        requests.push(`${req.method} ${path} accept=${req.headers.get("accept")}`);
        return fetchImpl(req);
      },
    });
    return { url: `http://127.0.0.1:${server.port}/`, requests, stop: () => server.stop(true) };
  }

  const doc = (tag: string, resolved: string, versions: string[]) => {
    const map: Record<string, unknown> = {};
    for (const version of versions) {
      map[version] = { name: "pkg", version, dist: { tarball: `http://127.0.0.1/x/${version}.tgz` } };
    }
    return Response.json({ name: "pkg", "dist-tags": { [tag]: resolved }, versions: map });
  };

  test("ready immediately when the tag resolves to the expected version", async () => {
    const mock = serve(() => doc("next", "1.0.1", ["1.0.0", "1.0.1"]));
    try {
      const outcome = await waitForTagVersion({
        name: "pkg",
        tag: "next",
        version: "1.0.1",
        registry: mock.url,
        intervalMs: 10,
      });
      expect(outcome.ready).toBe(true);
      expect(outcome.attempts).toBe(1);
      expect(outcome.tarball).toContain("1.0.1.tgz");
      // The probe must read what Bun reads — the abbreviated install manifest.
      expect(mock.requests[0]).toContain(ABBREVIATED_MANIFEST_ACCEPT);
    } finally {
      mock.stop();
    }
  });

  test("a lagging tag is NOT readiness; the flip to the expected version is", async () => {
    let resolved = "1.0.0";
    const mock = serve(() => doc("next", resolved, ["1.0.0", "1.0.1"]));
    try {
      const lagging = await waitForTagVersion({
        name: "pkg",
        tag: "next",
        version: "1.0.1",
        registry: mock.url,
        timeoutMs: 120,
        intervalMs: 20,
      });
      expect(lagging.ready).toBe(false);
      expect(lagging.lastFailure).toContain("1.0.0");
      expect(lagging.lastFailure).toContain("1.0.1");

      resolved = "1.0.1";
      const ready = await waitForTagVersion({ name: "pkg", tag: "next", version: "1.0.1", registry: mock.url, intervalMs: 10 });
      expect(ready.ready).toBe(true);
      expect(ready.tarball).toContain("1.0.1.tgz");
    } finally {
      mock.stop();
    }
  });

  test("times out bounded with diagnostics naming the endpoint, tag, version, and last failure", async () => {
    const mock = serve(() => new Response("nope", { status: 404 }));
    try {
      const started = Date.now();
      const outcome = await waitForTagVersion({
        name: "pkg",
        tag: "next",
        version: "9.9.9",
        registry: mock.url,
        timeoutMs: 150,
        intervalMs: 20,
      });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(outcome.ready).toBe(false);
      expect(outcome.attempts).toBeGreaterThan(1);
      expect(outcome.lastFailure).toContain("HTTP 404");
      expect(outcome.lastFailure).toContain(mock.url.replace(/\/+$/, ""));
    } finally {
      mock.stop();
    }
  });

  test("refuses a non-tag or a non-exact version instead of waiting on it", async () => {
    await expect(waitForTagVersion({ name: "pkg", tag: "1.0.1", version: "1.0.1" })).rejects.toThrow(
      "expected a dist-tag",
    );
    await expect(waitForTagVersion({ name: "pkg", tag: "", version: "1.0.1" })).rejects.toThrow("expected a dist-tag");
    await expect(waitForTagVersion({ name: "pkg", tag: "next", version: "next" })).rejects.toThrow("exact-version-only");
  });
});

describe("waitForExactVersion with an injected fetch", () => {
  test("a stalled connection fails the attempt instead of hanging the wait", async () => {
    // A fetch that never settles and ignores its signal: without a
    // per-attempt timeout this test would hang until the runner kills it.
    let sawSignal = false;
    const started = Date.now();
    const outcome = await waitForExactVersion({
      name: "pkg",
      version: "1.0.1",
      registry: "http://127.0.0.1:9/",
      timeoutMs: 300,
      intervalMs: 20,
      attemptTimeoutMs: 40,
      fetchImpl: ((_url, init) => {
        sawSignal = init?.signal instanceof AbortSignal;
        return new Promise<Response>(() => {});
      }) as typeof fetch,
      sleepImpl: () => Promise.resolve(),
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(outcome.ready).toBe(false);
    expect(outcome.attempts).toBeGreaterThan(1);
    expect(outcome.lastFailure).toContain("attempt timed out after 40ms");
    // The injected seam still receives an abort signal, so a well-behaved
    // fetch can release its socket even though the race bounds the wait.
    expect(sawSignal).toBe(true);
  });

  test("transport failures fail closed with endpoint diagnostics", async () => {
    const outcome = await waitForExactVersion({
      name: "pkg",
      version: "1.0.1",
      registry: "http://127.0.0.1:9/",
      timeoutMs: 100,
      intervalMs: 20,
      fetchImpl: (() => Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch,
      sleepImpl: () => Promise.resolve(),
    });
    expect(outcome.ready).toBe(false);
    expect(outcome.attempts).toBeGreaterThan(1);
    expect(outcome.lastFailure).toBe("request to http://127.0.0.1:9/pkg failed: socket hang up");
  });
});

describe("wait-for-registry.ts CLI", () => {
  // Async spawn: a spawnSync would block this process's event loop, and the
  // mock registry living in it could never answer the child (deadlock).
  const runCli = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dirname, "..", "scripts", "wait-for-registry.ts"), ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stdout, stderr, exit };
  };

  test("exit 0 with a ✓ line when ready; exit 1 with ::error:: diagnostics on timeout", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({
          name: "pkg",
          "dist-tags": { latest: "1.0.1" },
          versions: { "1.0.1": { version: "1.0.1", dist: { tarball: "http://127.0.0.1/x/1.0.1.tgz" } } },
        }),
    });
    const registry = `http://127.0.0.1:${server.port}/`;
    try {
      const ok = await runCli(["pkg", "v1.0.1", "--registry", registry]);
      expect(ok.exit).toBe(0);
      expect(ok.stdout).toContain("✓ pkg@1.0.1 servable");

      const miss = await runCli(["pkg", "9.9.9", "--registry", registry, "--timeout-s", "0.3", "--interval-s", "0.1"]);
      expect(miss.exit).toBe(1);
      expect(miss.stderr).toContain("::error::");
      expect(miss.stderr).toContain(registry);
      expect(miss.stderr).toContain("pkg@9.9.9");
      expect(miss.stderr).toContain("Last failure");
      // Per-attempt progress is a diagnostic: stderr, never stdout.
      expect(miss.stderr).toContain("[attempt 1] not ready");
      expect(miss.stdout).not.toContain("[attempt");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("--tag waits for the tag to resolve to the version (#226)", async () => {
    let resolved = "1.0.0";
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () =>
        Response.json({
          name: "pkg",
          "dist-tags": { next: resolved },
          versions: {
            "1.0.0": { version: "1.0.0", dist: { tarball: "http://127.0.0.1/x/1.0.0.tgz" } },
            "1.0.1": { version: "1.0.1", dist: { tarball: "http://127.0.0.1/x/1.0.1.tgz" } },
          },
        }),
    });
    const registry = `http://127.0.0.1:${server.port}/`;
    try {
      const lagging = await runCli(["pkg", "1.0.1", "--tag", "next", "--registry", registry, "--timeout-s", "0.3", "--interval-s", "0.1"]);
      expect(lagging.exit).toBe(1);
      expect(lagging.stderr).toContain("::error::");
      expect(lagging.stderr).toContain("pkg@next");
      expect(lagging.stderr).toContain("1.0.1");

      resolved = "1.0.1";
      const ok = await runCli(["pkg", "v1.0.1", "--tag", "next", "--registry", registry]);
      expect(ok.exit).toBe(0);
      expect(ok.stdout).toContain("✓ pkg@next resolves to 1.0.1");
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("fail-closed branches exit 1 with usage; --help exits 0", async () => {
    const failures: Array<{ args: string[]; stderr: string }> = [
      { args: ["pkg", "1.0.1", "--registry"], stderr: "--registry needs a value" },
      { args: ["pkg", "1.0.1", "--timeout-s", "--registry", "http://x/"], stderr: "--timeout-s needs a value" },
      { args: ["pkg", "1.0.1", "--tag"], stderr: "--tag needs a value" },
      { args: ["pkg", "1.0.1", "--bogus"], stderr: "Unknown flag --bogus" },
      { args: [], stderr: "Missing <package>" },
      { args: ["pkg"], stderr: "Missing <package>" },
      { args: ["pkg", "1.0.1", "--timeout-s", "abc"], stderr: "must be positive numbers" },
      { args: ["pkg", "1.0.1", "--timeout-s", "0"], stderr: "must be positive numbers" },
      { args: ["pkg", "1.0.1", "--interval-s", "-1"], stderr: "must be positive numbers" },
      { args: ["pkg", "latest"], stderr: "exact-version-only" },
      { args: ["pkg", "1.0.1", "--tag", "1.0.1"], stderr: "expected a dist-tag" },
    ];
    for (const { args, stderr } of failures) {
      const r = await runCli(args);
      expect(r.exit).toBe(1);
      expect(r.stderr).toContain(stderr);
    }

    const help = await runCli(["--help"]);
    expect(help.exit).toBe(0);
    expect(help.stdout).toContain("Usage:");
  }, 30_000);
});

/**
 * Adapted from the #202 self-contained reproducer: a mock registry plus an
 * isolated bunx cache proves the settled exact-version path and documents
 * the bare-invocation boundary it deliberately does not cover.
 */
describe("bunx cache behavior against a mock registry (#202 probe)", () => {
  interface BunxRun {
    stdout: string;
    stderr: string;
    exit: number;
    newRequests: string[];
  }

  interface Fixture {
    root: string;
    name: string;
    registry: string;
    requests: string[];
    setLatest: (version: "1.0.0" | "1.0.1") => void;
    setNext: (version: "1.0.0" | "1.0.1" | null) => void;
    run: (spec: string) => Promise<BunxRun>;
    stop: () => void;
  }

  async function setup(): Promise<Fixture> {
    const root = mkdtempSync(join(tmpdir(), "rosetta-registry-readiness-"));
    const name = `rosetta-registry-readiness-probe-${process.pid}`;
    for (const version of ["1.0.0", "1.0.1"]) {
      const dir = join(root, version, "package");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, bin: { [name]: "cli.js" } }));
      writeFileSync(join(dir, "cli.js"), `#!/usr/bin/env bun\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o755 });
      const archive = Bun.spawn(["tar", "-czf", join(root, `${version}.tgz`), "-C", join(root, version), "package"]);
      if (await archive.exited) throw new Error("tar failed");
    }
    let latest: "1.0.0" | "1.0.1" = "1.0.0";
    let nextTag: "1.0.0" | "1.0.1" | null = null;
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        requests.push(`${latest}: ${req.method} ${path} accept=${req.headers.get("accept")}`);
        if (path.endsWith(".tgz")) return new Response(Bun.file(join(root, path.split("/").pop() ?? "")));
        const served = ["1.0.0"];
        if (latest === "1.0.1" || nextTag === "1.0.1") served.push("1.0.1");
        const versions: Record<string, unknown> = {};
        for (const version of served) {
          versions[version] = {
            name,
            version,
            bin: { [name]: "cli.js" },
            dist: { tarball: `http://127.0.0.1:${server.port}/${version}.tgz` },
          };
        }
        const distTags: Record<string, string> = { latest };
        if (nextTag !== null) distTags.next = nextTag;
        return Response.json({ name, "dist-tags": distTags, versions });
      },
    });
    const client = join(root, "client");
    mkdirSync(client, { recursive: true });
    // Point ONLY this fixture's child processes at the mock registry, with an
    // isolated cache + HOME — the ambient user/bun state is never touched.
    const registry = `http://127.0.0.1:${server.port}/`;
    const run = async (spec: string) => {
      const before = requests.length;
      const child = Bun.spawn([process.execPath, "x", "--registry", registry, spec], {
        cwd: client,
        env: {
          ...process.env,
          BUN_INSTALL_CACHE_DIR: join(root, "cache"),
          HOME: join(root, "home"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout: stdout.trim(), stderr: stderr.trim(), exit, newRequests: requests.slice(before) };
    };
    return {
      root,
      name,
      registry,
      requests,
      setLatest: (version) => {
        latest = version;
      },
      setNext: (version) => {
        nextTag = version;
      },
      run,
      stop: () => {
        server.stop(true);
        try {
          rmSync(root, { recursive: true, force: true });
        } catch {
          // Best-effort temp cleanup — never fail the test on it.
        }
      },
    };
  }

  test("exact pins run the new version on a warm cache; bare re-runs the cached old one with zero requests", async () => {
    const fx = await setup();
    try {
      // Seed a warm cache the way a real user gets one: a bare invocation.
      const seed = await fx.run(fx.name);
      expect(seed.exit).toBe(0);
      expect(seed.stdout).toBe("1.0.0");
      expect(seed.newRequests.length).toBeGreaterThan(0);

      // Publish 1.0.1, then gate on it exactly like release-smoke.yml does.
      fx.setLatest("1.0.1");
      const gate = await waitForExactVersion({ name: fx.name, version: "1.0.1", registry: fx.registry, intervalMs: 10 });
      expect(gate.ready).toBe(true);

      // Settled path: the exact pin executes the NEW version despite the warm cache.
      const exact = await fx.run(`${fx.name}@1.0.1`);
      expect(exact.exit).toBe(0);
      expect(exact.stdout).toBe("1.0.1");
      expect(exact.newRequests.length).toBeGreaterThan(0);

      // Boundary (deliberately NOT covered by any gate, #226 decision B): a
      // warm bare invocation still executes the cached OLD version with zero
      // registry requests. The upgrade smoke uses the explicit-tag form below
      // instead; bare-form staleness is accepted, documented behavior.
      const bare = await fx.run(fx.name);
      expect(bare.exit).toBe(0);
      expect(bare.stdout).toBe("1.0.0");
      expect(bare.newRequests).toEqual([]);
    } finally {
      fx.stop();
    }
  }, 120_000);

  test("explicit @latest fetches the new version past a warm cache once the tag gate passes (#226)", async () => {
    const fx = await setup();
    try {
      // Seed a warm cache the way a real user gets one: a bare invocation.
      const seed = await fx.run(fx.name);
      expect(seed.exit).toBe(0);
      expect(seed.stdout).toBe("1.0.0");

      // Publish 1.0.1 on latest, then gate on it exactly like
      // release-smoke.yml's bunx-upgrade-smoke does for stable releases.
      fx.setLatest("1.0.1");
      const gate = await waitForTagVersion({
        name: fx.name,
        tag: "latest",
        version: "1.0.1",
        registry: fx.registry,
        intervalMs: 10,
      });
      expect(gate.ready).toBe(true);

      const tagged = await fx.run(`${fx.name}@latest`);
      expect(tagged.exit).toBe(0);
      expect(tagged.stdout).toBe("1.0.1");
      expect(tagged.newRequests.length).toBeGreaterThan(0);
    } finally {
      fx.stop();
    }
  }, 120_000);

  test("explicit @next fetches the new version past a warm cache once the tag gate passes (#226)", async () => {
    const fx = await setup();
    try {
      // Seed a warm cache the way a real user gets one: a bare invocation.
      const seed = await fx.run(fx.name);
      expect(seed.exit).toBe(0);
      expect(seed.stdout).toBe("1.0.0");

      // Publish 1.0.1 on the next channel only, then gate on it exactly
      // like release-smoke.yml's bunx-upgrade-smoke does for prereleases.
      fx.setNext("1.0.1");
      const gate = await waitForTagVersion({
        name: fx.name,
        tag: "next",
        version: "1.0.1",
        registry: fx.registry,
        intervalMs: 10,
      });
      expect(gate.ready).toBe(true);

      const tagged = await fx.run(`${fx.name}@next`);
      expect(tagged.exit).toBe(0);
      expect(tagged.stdout).toBe("1.0.1");
      expect(tagged.newRequests.length).toBeGreaterThan(0);
    } finally {
      fx.stop();
    }
  }, 120_000);

  test("an exact pin for a version the registry lacks fails — the failure the gate prevents", async () => {
    const fx = await setup();
    try {
      const missing = await fx.run(`${fx.name}@9.9.9`);
      expect(missing.exit).not.toBe(0);
      expect(missing.stdout).not.toContain("9.9.9");
    } finally {
      fx.stop();
    }
  }, 120_000);
});
