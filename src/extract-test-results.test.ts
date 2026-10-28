// Set BEFORE importing extract-test-results.ts (which transitively imports
// db.ts). Prevents this test file from pinning the DB singleton to a real
// ros-help.db path before query.test.ts can enforce its in-memory guard.
process.env.DB_PATH = ":memory:";

import sqlite from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHTML } from "linkedom";

// Dynamic import so the DB_PATH assignment above is visible before db.ts loads.
const {
  evaluateExtractionOutcome,
  fetchProductPage,
  fetchSitemap,
  MAX_HARD_ERROR_RATE,
  MAX_MISSING_RATE,
  parsePerformanceTable,
} = await import("./extract-test-results.ts");

// ── Fixture helpers ──────────────────────────────────────────────────────────

/** Build a minimal performance-table HTML matching the real MikroTik page structure. */
function makeEthernetTable(rows: string[]): Element {
  const html = `
<table class="performance-table">
  <thead>
    <tr>
      <td>RB1100Dx4</td>
      <td>AL21400 1G all port test</td>
    </tr>
    <tr>
      <td>Mode</td>
      <td>Configuration</td>
      <td>1518 byte</td>
      <td></td>
      <td>512 byte</td>
      <td></td>
      <td>64 byte</td>
      <td></td>
    </tr>
    <tr>
      <td></td><td></td>
      <td>kpps</td><td>Mbps</td>
      <td>kpps</td><td>Mbps</td>
      <td>kpps</td><td>Mbps</td>
    </tr>
  </thead>
  <tbody>
    ${rows.join("\n    ")}
  </tbody>
</table>`;
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const table = document.querySelector("table");
  if (!table) throw new Error("fixture build failed");
  return table;
}

function makeIpsecTable(rows: string[]): Element {
  const html = `
<table class="performance-table">
  <thead>
    <tr>
      <td>RB1100Dx4</td>
      <td>IPsec AES hardware acceleration</td>
    </tr>
    <tr>
      <td>Mode</td>
      <td>Configuration</td>
      <td>1400 byte</td>
      <td></td>
      <td>512 byte</td>
      <td></td>
      <td>64 byte</td>
      <td></td>
    </tr>
    <tr>
      <td></td><td></td>
      <td>kpps</td><td>Mbps</td>
      <td>kpps</td><td>Mbps</td>
      <td>kpps</td><td>Mbps</td>
    </tr>
  </thead>
  <tbody>
    ${rows.join("\n    ")}
  </tbody>
</table>`;
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  const table = document.querySelector("table");
  if (!table) throw new Error("fixture build failed");
  return table;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("parsePerformanceTable", () => {
  describe("type detection", () => {
    it("detects ethernet type from header", () => {
      const table = makeEthernetTable([
        "<tr><td>Bridging</td><td>none (fast path)</td><td>606.5</td><td>7,365.3</td><td>1,736.4</td><td>7,112.3</td><td>5,509.7</td><td>2,821.0</td></tr>",
      ]);
      const { testType } = parsePerformanceTable(table);
      expect(testType).toBe("ethernet");
    });

    it("detects ipsec type from header", () => {
      const table = makeIpsecTable([
        "<tr><td>Single tunnel</td><td>AES-128-CBC + SHA1</td><td>92.1</td><td>1,031.5</td><td>93.1</td><td>381.3</td><td>92.3</td><td>47.3</td></tr>",
      ]);
      const { testType } = parsePerformanceTable(table);
      expect(testType).toBe("ipsec");
    });
  });

  describe("thousands-separator handling", () => {
    it("correctly parses values with comma thousands separators (regression: RB1100Dx4 512-byte row)", () => {
      // Website: Bridging, none (fast path), 512B → kpps=1,736.4, Mbps=7,112.3
      // Before fix: parseFloat("1,736.4") → 1, parseFloat("7,112.3") → 7
      const table = makeEthernetTable([
        "<tr><td>Bridging</td><td>none (fast path)</td><td>606.5</td><td>7,365.3</td><td>1,736.4</td><td>7,112.3</td><td>5,509.7</td><td>2,821.0</td></tr>",
      ]);
      const { rows } = parsePerformanceTable(table);

      const row512 = rows.find((r) => r.packet_size === 512);
      expect(row512).toBeDefined();
      expect(row512?.throughput_kpps).toBeCloseTo(1736.4);
      expect(row512?.throughput_mbps).toBeCloseTo(7112.3);
    });

    it("correctly parses 1518-byte row with large comma-formatted values", () => {
      const table = makeEthernetTable([
        "<tr><td>Bridging</td><td>none (fast path)</td><td>606.5</td><td>7,365.3</td><td>1,736.4</td><td>7,112.3</td><td>5,509.7</td><td>2,821.0</td></tr>",
      ]);
      const { rows } = parsePerformanceTable(table);

      const row1518 = rows.find((r) => r.packet_size === 1518);
      expect(row1518?.throughput_kpps).toBeCloseTo(606.5);
      expect(row1518?.throughput_mbps).toBeCloseTo(7365.3);
    });

    it("correctly parses 64-byte row with large comma-formatted kpps", () => {
      const table = makeEthernetTable([
        "<tr><td>Bridging</td><td>none (fast path)</td><td>606.5</td><td>7,365.3</td><td>1,736.4</td><td>7,112.3</td><td>5,509.7</td><td>2,821.0</td></tr>",
      ]);
      const { rows } = parsePerformanceTable(table);

      const row64 = rows.find((r) => r.packet_size === 64);
      expect(row64?.throughput_kpps).toBeCloseTo(5509.7);
      expect(row64?.throughput_mbps).toBeCloseTo(2821.0);
    });

    it("still handles values without thousands separators", () => {
      const table = makeEthernetTable([
        "<tr><td>Routing</td><td>25 simple queues</td><td>606.5</td><td>7365.3</td><td>933.6</td><td>3824.0</td><td>960.3</td><td>491.7</td></tr>",
      ]);
      const { rows } = parsePerformanceTable(table);

      const row512 = rows.find((r) => r.packet_size === 512);
      expect(row512?.throughput_kpps).toBeCloseTo(933.6);
      expect(row512?.throughput_mbps).toBeCloseTo(3824.0);
    });
  });

  describe("row structure", () => {
    it("emits one row per packet size", () => {
      const table = makeEthernetTable([
        "<tr><td>Bridging</td><td>none (fast path)</td><td>606.5</td><td>7,365.3</td><td>1,736.4</td><td>7,112.3</td><td>5,509.7</td><td>2,821.0</td></tr>",
      ]);
      const { rows } = parsePerformanceTable(table);
      expect(rows).toHaveLength(3); // 1518, 512, 64
    });

    it("preserves mode and configuration strings", () => {
      const table = makeEthernetTable([
        "<tr><td>Routing</td><td>25 ip filter rules</td><td>543.7</td><td>6,602.7</td><td>561.8</td><td>2,301.1</td><td>564.6</td><td>289.1</td></tr>",
      ]);
      const { rows } = parsePerformanceTable(table);
      expect(rows[0].mode).toBe("Routing");
      expect(rows[0].configuration).toBe("25 ip filter rules");
    });

    it("returns null for unparseable cell values", () => {
      const table = makeEthernetTable([
        "<tr><td>Bridging</td><td>none (fast path)</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td><td>-</td></tr>",
      ]);
      const { rows } = parsePerformanceTable(table);
      expect(rows[0].throughput_kpps).toBeNull();
      expect(rows[0].throughput_mbps).toBeNull();
    });

    it("parses ipsec rows with 1400/512/64 packet sizes", () => {
      const table = makeIpsecTable([
        "<tr><td>Single tunnel</td><td>AES-128-CBC + SHA1</td><td>92.1</td><td>1,031.5</td><td>93.1</td><td>381.3</td><td>92.3</td><td>47.3</td></tr>",
      ]);
      const { rows } = parsePerformanceTable(table);
      const sizes = rows.map((r) => r.packet_size);
      expect(sizes).toEqual([1400, 512, 64]);
      const row1400 = rows.find((r) => r.packet_size === 1400);
      expect(row1400?.throughput_mbps).toBeCloseTo(1031.5);
    });
  });
});

describe("evaluateExtractionOutcome (fail-loud verdict, #218)", () => {
  // Shape of a healthy run (2026-10-28 local extraction): thousands of rows,
  // zero transport errors, a handful of genuine 404s for discontinued products.
  const healthy = {
    deviceCount: 155,
    totalTests: 3177,
    hardErrors: 0,
    missing: 7,
    sitemapOk: true,
    timedOut: false,
  };

  it("passes a healthy run", () => {
    expect(evaluateExtractionOutcome(healthy)).toBeNull();
  });

  it("fails an empty run — the next.123 incident shape (0 rows, every fetch failed)", () => {
    const verdict = evaluateExtractionOutcome({
      deviceCount: 155,
      totalTests: 0,
      hardErrors: 155,
      missing: 0,
      sitemapOk: false,
      timedOut: false,
    });
    expect(verdict).toContain("0 test-result rows");
    expect(verdict).toContain("155 unreachable");
    expect(verdict).toContain("sitemap seed failed");
  });

  it("fails an empty run even when every page 404s (a wipe is never a legitimate outcome)", () => {
    const verdict = evaluateExtractionOutcome({ ...healthy, totalTests: 0, missing: 155 });
    expect(verdict).toContain("0 test-result rows");
  });

  it("fails when hard errors exceed the threshold even with rows extracted", () => {
    const over = Math.floor(healthy.deviceCount * MAX_HARD_ERROR_RATE) + 1;
    const verdict = evaluateExtractionOutcome({ ...healthy, hardErrors: over });
    expect(verdict).toContain(`${over}/${healthy.deviceCount}`);
  });

  it("passes at exactly the hard-error threshold (fails only when exceeding it)", () => {
    expect(
      evaluateExtractionOutcome({
        deviceCount: 100,
        totalTests: 2000,
        hardErrors: 10,
        missing: 0,
        sitemapOk: true,
        timedOut: false,
      }),
    ).toBeNull();
  });

  it("tolerates missing pages under the threshold (discontinued products are not an outage)", () => {
    // 20/155 ≈ 13%: nearly 3x the healthy 7-missing baseline, still passing.
    expect(evaluateExtractionOutcome({ ...healthy, missing: 20 })).toBeNull();
  });

  it("fails when missing pages exceed the threshold even with rows extracted", () => {
    // The mass-404 shape: a slug-scheme change or WAF 404s with survivors.
    const over = Math.floor(healthy.deviceCount * MAX_MISSING_RATE) + 1;
    const verdict = evaluateExtractionOutcome({ ...healthy, missing: over });
    expect(verdict).toContain(`${over}/${healthy.deviceCount}`);
    expect(verdict).toContain("404'd");
  });

  it("passes at exactly the missing threshold (fails only when exceeding it)", () => {
    expect(
      evaluateExtractionOutcome({
        deviceCount: 100,
        totalTests: 2000,
        hardErrors: 0,
        missing: 15,
        sitemapOk: true,
        timedOut: false,
      }),
    ).toBeNull();
  });

  it("passes when only the sitemap seed failed (heuristics still extracted rows)", () => {
    expect(evaluateExtractionOutcome({ ...healthy, sitemapOk: false })).toBeNull();
  });

  it("fails a timed-out run even with rows extracted (the fetch phase never finished)", () => {
    const verdict = evaluateExtractionOutcome({ ...healthy, timedOut: true });
    expect(verdict).toContain("deadline");
    expect(verdict).toContain("ROSETTA_EXTRACT_DEADLINE_MS");
  });
});

describe("fetchProductPage failure classification (#218)", () => {
  // No-retry-delay budget so stubbed-failure tests stay fast.
  const fast = { attempts: 2, baseDelayMs: 0, timeoutMs: 5000 };

  const PRODUCT_HTML = `<html><body>
<table class="table performance-table">
  <thead>
    <tr><td>hAP ax3</td><td>IPQ-6010 1G all port test</td></tr>
    <tr><td>Mode</td><td>Configuration</td><td>1518 byte</td><td></td><td>512 byte</td><td></td><td>64 byte</td><td></td></tr>
    <tr><td></td><td></td><td>kpps</td><td>Mbps</td><td>kpps</td><td>Mbps</td><td>kpps</td><td>Mbps</td></tr>
  </thead>
  <tbody>
    <tr><td>Bridging</td><td>none (fast path)</td><td>606.5</td><td>7,365.3</td><td>1,736.4</td><td>7,112.3</td><td>5,509.7</td><td>2,821.0</td></tr>
  </tbody>
</table>
<a href="/img/hap-ax3-block.png">Block Diagram</a>
</body></html>`;

  function stubFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
    return (async (url: unknown) => handler(String(url))) as typeof fetch;
  }

  it("parses the first variant that returns 200", async () => {
    const result = await fetchProductPage(
      ["hap_ax3", "spare_variant"],
      { ...fast, fetchImpl: stubFetch(() => new Response(PRODUCT_HTML, { status: 200 })) },
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.slug).toBe("hap_ax3");
      expect(result.data.ethernet_results).toHaveLength(3);
      expect(result.data.block_diagram_url).toContain("hap-ax3-block.png");
    }
  });

  it("tries the next variant on 404 (wrong slug guess, not a failure)", async () => {
    const seen: string[] = [];
    const result = await fetchProductPage(
      ["wrong_guess", "hap_ax3"],
      {
        ...fast,
        fetchImpl: stubFetch((url) => {
          seen.push(url);
          return url.endsWith("/hap_ax3")
            ? new Response(PRODUCT_HTML, { status: 200 })
            : new Response("nope", { status: 404 });
        }),
      },
    );
    expect(result.status).toBe("ok");
    expect(seen).toHaveLength(2);
  });

  it("reports missing when every variant 404s", async () => {
    const result = await fetchProductPage(
      ["gone_a", "gone_b", "gone_c"],
      { ...fast, fetchImpl: stubFetch(() => new Response("nope", { status: 404 })) },
    );
    expect(result).toEqual({ status: "missing", tried: 3 });
  });

  it("reports a hard error on a persistent 503 without trying further variants", async () => {
    const seen: string[] = [];
    const result = await fetchProductPage(
      ["hap_ax3", "spare_variant"],
      {
        ...fast,
        fetchImpl: stubFetch((url) => {
          seen.push(url);
          return new Response("unavailable", { status: 503 });
        }),
      },
    );
    expect(result).toEqual({ status: "error", detail: "HTTP 503" });
    // Attempts exhausted on the first variant only — a sick host won't answer
    // a different slug, so further variants are not attempted.
    expect(seen).toHaveLength(fast.attempts);
    expect(new Set(seen).size).toBe(1);
  });

  it("recovers when a retry succeeds after a transient 503", async () => {
    let calls = 0;
    const result = await fetchProductPage(
      ["hap_ax3"],
      {
        ...fast,
        fetchImpl: stubFetch(() => (++calls === 1
          ? new Response("unavailable", { status: 503 })
          : new Response(PRODUCT_HTML, { status: 200 }))),
      },
    );
    expect(result.status).toBe("ok");
    expect(calls).toBe(2);
  });

  it("reports a hard error when fetch throws persistently", async () => {
    const result = await fetchProductPage(
      ["hap_ax3"],
      {
        ...fast,
        fetchImpl: stubFetch(() => {
          throw new Error("connection reset");
        }),
      },
    );
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.detail).toContain("connection reset");
    }
  });

  it("reports a non-404 4xx (403) as an instant hard error without further variants", async () => {
    const seen: string[] = [];
    const result = await fetchProductPage(
      ["hap_ax3", "spare_variant"],
      {
        ...fast,
        fetchImpl: stubFetch((url) => {
          seen.push(url);
          return new Response("forbidden", { status: 403 });
        }),
      },
    );
    expect(result).toEqual({ status: "error", detail: "HTTP 403" });
    // 403 is fatal at once (blocking, not a throttle) — no retries, no
    // further variants.
    expect(seen).toHaveLength(1);
  });

  it("recovers when a retry succeeds after a transient 429", async () => {
    let calls = 0;
    const result = await fetchProductPage(
      ["hap_ax3"],
      {
        ...fast,
        fetchImpl: stubFetch(() =>
          ++calls === 1
            ? new Response("slow down", { status: 429 })
            : new Response(PRODUCT_HTML, { status: 200 })),
      },
    );
    expect(result.status).toBe("ok");
    expect(calls).toBe(2);
  });

  it("reports a 200 page with no tables and no diagram as unparseable, not ok", async () => {
    // A soft-404 / bot-wall / drifted-markup page: 200, but nothing we
    // recognize. Recording this `ok` with 0 rows let site-wide drift pass
    // with 0 hard errors behind only the QA row floor.
    const result = await fetchProductPage(
      ["hap_ax3"],
      { ...fast, fetchImpl: stubFetch(() => new Response("<html><body><p>Nothing here</p></body></html>", { status: 200 })) },
    );
    expect(result).toEqual({ status: "error", detail: "unparseable page at hap_ax3" });
  });

  it("keeps a diagram-only page ok (some products genuinely lack benchmark tables)", async () => {
    const result = await fetchProductPage(
      ["hap_ax3"],
      {
        ...fast,
        fetchImpl: stubFetch(
          () => new Response('<html><body><a href="/img/x.png">Block Diagram</a></body></html>', { status: 200 }),
        ),
      },
    );
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.data.ethernet_results).toHaveLength(0);
      expect(result.data.ipsec_results).toHaveLength(0);
      expect(result.data.block_diagram_url).toContain("x.png");
    }
  });

  function truncated(): Response {
    const broken = new Response("x", { status: 200 });
    broken.text = () => Promise.reject(new Error("truncated body"));
    return broken;
  }

  it("retries a transient body-read failure inside the retry budget", async () => {
    let n = 0;
    const result = await fetchProductPage(
      ["hap_ax3"],
      { ...fast, fetchImpl: stubFetch(() => (n++ === 0 ? truncated() : new Response(PRODUCT_HTML, { status: 200 }))) },
    );
    expect(result.status).toBe("ok");
    expect(n).toBe(2);
  });

  it("reports a persistent body-read failure as one product's hard error instead of rejecting", async () => {
    const result = await fetchProductPage(["hap_ax3"], { ...fast, fetchImpl: stubFetch(truncated) });
    expect(result).toEqual({ status: "error", detail: "fetch failed: truncated body" });
  });
});

describe("fetchSitemap", () => {
  const fast = { attempts: 2, baseDelayMs: 0, timeoutMs: 5000 };

  function stubFetch(handler: (url: string) => Response | Promise<Response>): typeof fetch {
    return (async (url: unknown) => handler(String(url))) as typeof fetch;
  }

  it("parses product slugs from the sitemap XML", async () => {
    const xml = `<urlset>
      <url><loc>https://mikrotik.com/product/hap_ax3</loc></url>
      <url><loc>https://mikrotik.com/product/rb5009</loc></url>
      <url><loc>https://mikrotik.com/about</loc></url>
    </urlset>`;
    const slugs = await fetchSitemap({ ...fast, fetchImpl: stubFetch(() => new Response(xml, { status: 200 })) });
    expect([...slugs].sort()).toEqual(["hap_ax3", "rb5009"]);
  });

  it("retries a transient 503 within the caller's retry budget, then succeeds", async () => {
    let calls = 0;
    const slugs = await fetchSitemap({
      ...fast,
      fetchImpl: stubFetch(() =>
        ++calls === 1
          ? new Response("unavailable", { status: 503 })
          : new Response("<urlset><url><loc>https://mikrotik.com/product/x</loc></url></urlset>", { status: 200 })),
    });
    expect([...slugs]).toEqual(["x"]);
    expect(calls).toBe(2);
  });

  it("returns an empty set on a persistent HTTP error (callers fall back to heuristics)", async () => {
    const slugs = await fetchSitemap({
      ...fast,
      fetchImpl: stubFetch(() => new Response("unavailable", { status: 503 })),
    });
    expect(slugs.size).toBe(0);
  });

  it("returns an empty set when fetch throws persistently", async () => {
    const slugs = await fetchSitemap({
      ...fast,
      fetchImpl: stubFetch(() => {
        throw new Error("connection reset");
      }),
    });
    expect(slugs.size).toBe(0);
  });
});

describe("main() verdict-to-exit wiring (hermetic subprocess pin)", () => {
  // Same --preload mock-fetch pattern as extract-cliref.test.ts: the
  // subprocess never touches the network — global fetch is stubbed before
  // the extractor loads. A route value is a 200 body string, null for 404,
  // or { status, body } for any other status.
  const ROOT = join(import.meta.dirname, "..");
  const SITEMAP = "https://mikrotik.com/sitemap.xml";
  const productUrl = (slug: string) => `https://mikrotik.com/product/${slug}`;

  const MOCK_FETCH = `const routes = await Bun.file(process.env.MOCK_FETCH_ROUTES).json();
const sleepMs = Number(process.env.MOCK_FETCH_SLEEP_MS ?? "0");
globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!(url in routes)) console.error("mock fetch: no route for " + url);
  if (sleepMs > 0) await Bun.sleep(sleepMs);
  const route = routes[url];
  if (route === null || route === undefined) return new Response("not found", { status: 404 });
  if (typeof route === "string") return new Response(route);
  return new Response(route.body ?? "", { status: route.status ?? 200 });
};
`;

  const pageFor = (code: string) => `<html><body>
<table class="table performance-table">
  <thead>
    <tr><td>${code}</td><td>AL21400 1G all port test</td></tr>
    <tr><td>Mode</td><td>Configuration</td><td>1518 byte</td><td></td><td>512 byte</td><td></td><td>64 byte</td><td></td></tr>
    <tr><td></td><td></td><td>kpps</td><td>Mbps</td><td>kpps</td><td>Mbps</td><td>kpps</td><td>Mbps</td></tr>
  </thead>
  <tbody>
    <tr><td>Bridging</td><td>none (fast path)</td><td>606.5</td><td>7,365.3</td><td>1,736.4</td><td>7,112.3</td><td>5,509.7</td><td>2,821.0</td></tr>
  </tbody>
</table>
<a href="/img/${code}-block.png">Block Diagram</a>
</body></html>`;

  // Single-slug devices (code null → one generated slug each).
  const DEVICES = [
    { name: "hAP ax3", slug: "hap_ax3" },
    { name: "hAP ax2", slug: "hap_ax2" },
    { name: "RB5009", slug: "rb5009" },
  ];

  const sitemapXml = (slugs: string[]) =>
    `<urlset>${slugs.map((s) => `<url><loc>https://mikrotik.com/product/${s}</loc></url>`).join("")}</urlset>`;

  function setup(
    routes: Record<string, string | null | { status: number; body: string }>,
    stale: { testMode: string; productUrl: string } = { testMode: "STALE", productUrl: "https://stale.example/old" },
  ): { dir: string; dbPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "rosetta-extract-tests-"));
    writeFileSync(join(dir, "mock-fetch.js"), MOCK_FETCH);
    writeFileSync(join(dir, "routes.json"), JSON.stringify(routes));
    const dbPath = join(dir, "fixture.db");
    const setupDb = new sqlite(dbPath);
    try {
      // Minimal devices shape: the columns main() reads/writes plus the
      // architecture/cpu columns initDb's devices_fts triggers reference.
      setupDb.run(
        "CREATE TABLE devices (id INTEGER PRIMARY KEY, product_name TEXT NOT NULL, product_code TEXT, architecture TEXT, cpu TEXT, product_url TEXT, block_diagram_url TEXT)",
      );
      setupDb.run(
        `CREATE TABLE device_test_results (id INTEGER PRIMARY KEY AUTOINCREMENT, device_id INTEGER NOT NULL,
          test_type TEXT NOT NULL, mode TEXT NOT NULL, configuration TEXT NOT NULL, packet_size INTEGER NOT NULL,
          throughput_kpps REAL, throughput_mbps REAL)`,
      );
      const insertDevice = setupDb.prepare("INSERT INTO devices (product_name, product_code) VALUES (?, NULL)");
      for (const d of DEVICES) insertDevice.run(d.name);
      // Mirror production, where devices_ai indexes each row at insert time:
      // initDb's devices_au trigger issues an FTS `delete` for the old row,
      // and FTS5 answers SQLITE_CORRUPT_VTAB when that rowid was never
      // indexed (as fixture rows inserted before devices_fts existed are).
      setupDb.run(`CREATE VIRTUAL TABLE devices_fts USING fts5(
        product_name, product_code, architecture, cpu,
        content=devices, content_rowid=id, tokenize='unicode61')`);
      setupDb.run(`INSERT INTO devices_fts (rowid, product_name, product_code, architecture, cpu)
        SELECT id, product_name, product_code, architecture, cpu FROM devices`);
      // One stale row from a previous run: a passing run replaces it, a
      // failing run must leave it untouched.
      setupDb.run(
        "INSERT INTO device_test_results (device_id, test_type, mode, configuration, packet_size) VALUES (1, 'ethernet', ?, 'old', 64)",
        [stale.testMode],
      );
      setupDb.run("UPDATE devices SET product_url = ? WHERE id = 1", [stale.productUrl]);
    } finally {
      setupDb.close();
    }
    return { dir, dbPath };
  }

  function runExtractor(
    dir: string,
    dbPath: string,
    extraEnv: Record<string, string> = {},
    ...flags: string[]
  ): { exitCode: number | null; output: string } {
    const result = Bun.spawnSync(
      [
        process.execPath,
        `--preload=${join(dir, "mock-fetch.js")}`,
        "run",
        join(ROOT, "src/extract-test-results.ts"),
        "--delay",
        "0",
        ...flags,
      ],
      {
        cwd: ROOT,
        env: { ...process.env, DB_PATH: dbPath, MOCK_FETCH_ROUTES: join(dir, "routes.json"), ...extraEnv },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60_000,
      },
    );
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(output, "mock fetch covered every request (no live network)").not.toContain("no route for");
    return { exitCode: result.exitCode, output };
  }

  function queryDb<T>(dbPath: string, sql: string): T[] {
    const db = new sqlite(dbPath, { readonly: true });
    try {
      return db.query(sql).all() as T[];
    } finally {
      db.close();
    }
  }

  it("exits 1 with the verdict when every page 404s, leaving the old table untouched", () => {
    const slugs = DEVICES.map((d) => d.slug);
    const routes: Record<string, string | null> = { [SITEMAP]: sitemapXml(slugs) };
    for (const s of slugs) routes[productUrl(s)] = null;
    const { dir, dbPath } = setup(routes);
    try {
      const { exitCode, output } = runExtractor(dir, dbPath);
      expect(exitCode).toBe(1);
      expect(output).toContain("0 test-result rows");
      // Failed run: the stale row and URL survive (no wipe-before-verdict).
      expect(queryDb<{ c: number }>(dbPath, "SELECT COUNT(*) AS c FROM device_test_results")[0].c).toBe(1);
      expect(queryDb<{ mode: string }>(dbPath, "SELECT mode FROM device_test_results")[0].mode).toBe("STALE");
      expect(queryDb<{ product_url: string }>(dbPath, "SELECT product_url FROM devices WHERE id = 1")[0].product_url)
        .toBe("https://stale.example/old");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 0 on a passing run and atomically replaces the old table", () => {
    const slugs = DEVICES.map((d) => d.slug);
    const routes: Record<string, string> = { [SITEMAP]: sitemapXml(slugs) };
    for (const d of DEVICES) routes[productUrl(d.slug)] = pageFor(d.slug);
    const { dir, dbPath } = setup(routes);
    try {
      const { exitCode, output } = runExtractor(dir, dbPath);
      expect(exitCode, output).toBe(0);
      expect(output).toContain("Test results: 9 rows");
      // One table row per packet size (1518/512/64) per device; stale gone.
      expect(queryDb<{ c: number }>(dbPath, "SELECT COUNT(*) AS c FROM device_test_results")[0].c).toBe(9);
      expect(queryDb<{ c: number }>(dbPath, "SELECT COUNT(*) AS c FROM device_test_results WHERE mode = 'STALE'")[0].c)
        .toBe(0);
      expect(queryDb<{ c: number }>(dbPath, "SELECT COUNT(*) AS c FROM devices WHERE product_url LIKE 'https://mikrotik.com/product/%'")[0].c)
        .toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exits 1 with the table untouched when the global deadline trips", () => {
    const slugs = DEVICES.map((d) => d.slug);
    const routes: Record<string, string> = { [SITEMAP]: sitemapXml(slugs) };
    for (const d of DEVICES) routes[productUrl(d.slug)] = pageFor(d.slug);
    const { dir, dbPath } = setup(routes);
    try {
      // Each fetch sleeps 100ms; the 50ms deadline trips at the second batch.
      const { exitCode, output } = runExtractor(
        dir,
        dbPath,
        { MOCK_FETCH_SLEEP_MS: "100", ROSETTA_EXTRACT_DEADLINE_MS: "50" },
        "--concurrency",
        "1",
      );
      expect(exitCode, output).toBe(1);
      expect(output).toContain("[deadline]");
      expect(output).toContain("deadline");
      expect(queryDb<{ c: number }>(dbPath, "SELECT COUNT(*) AS c FROM device_test_results")[0].c).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
