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
  isExactVersion,
  manifestUrl,
  waitForExactVersion,
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

describe("wait-for-registry.ts CLI", () => {
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
    } finally {
      server.stop(true);
    }
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
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname;
        requests.push(`${latest}: ${req.method} ${path} accept=${req.headers.get("accept")}`);
        if (path.endsWith(".tgz")) return new Response(Bun.file(join(root, path.split("/").pop() ?? "")));
        const versions: Record<string, unknown> = {};
        for (const version of latest === "1.0.0" ? ["1.0.0"] : ["1.0.0", "1.0.1"]) {
          versions[version] = {
            name,
            version,
            bin: { [name]: "cli.js" },
            dist: { tarball: `http://127.0.0.1:${server.port}/${version}.tgz` },
          };
        }
        return Response.json({ name, "dist-tags": { latest }, versions });
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

      // Boundary (NOT covered by the gate): a warm bare invocation still
      // executes the cached OLD version with zero registry requests. This
      // documents why the upgrade path needs its own contract decision.
      const bare = await fx.run(fx.name);
      expect(bare.exit).toBe(0);
      expect(bare.stdout).toBe("1.0.0");
      expect(bare.newRequests).toEqual([]);
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
