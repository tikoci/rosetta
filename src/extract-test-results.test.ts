// Set BEFORE importing extract-test-results.ts (which transitively imports
// db.ts). Prevents this test file from pinning the DB singleton to a real
// ros-help.db path before query.test.ts can enforce its in-memory guard.
process.env.DB_PATH = ":memory:";

import { describe, expect, it } from "bun:test";
import { parseHTML } from "linkedom";

// Dynamic import so the DB_PATH assignment above is visible before db.ts loads.
const { parsePerformanceTable } = await import("./extract-test-results.ts");

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
