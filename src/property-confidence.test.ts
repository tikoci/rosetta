/**
 * property-confidence.test.ts — the B-0024 step-4 tier rules, as pure-function anchors.
 *
 * `gradeRows` (the DB-backed half) is covered by the `lookupProperty` integration tests in
 * query.test.ts, which own the fixture. This file pins the decision table itself.
 *
 * DB_PATH must be set BEFORE db.ts is first imported — property-confidence.ts reaches it — so
 * the import below is dynamic (see source-hygiene.test.ts guard 1).
 */
import { describe, expect, test } from "bun:test";

process.env.DB_PATH = ":memory:";

const { gradeRow, supportedPaths, tierRank } = await import("./property-confidence.ts");

const PORT = "/interface/bridge/port";
/** Section names `paths` and is judged to be about all of them, unless `supported` says otherwise. */
const evidence = (
  paths: string[],
  over: Partial<{ pageAligned: boolean; acceptsName: boolean | null; supported: string[] }> = {},
) => ({
  sectionPaths: new Set(paths),
  supportedPaths: new Set(over.supported ?? paths),
  pageAligned: over.pageAligned ?? false,
  acceptsName: over.acceptsName ?? null,
});

describe("gradeRow", () => {
  test("exact section↔menu alignment is the only route to high", () => {
    expect(gradeRow(PORT, evidence([PORT]))).toBe("high");
    // Page alignment alone never reaches high — that is the pre-B-0024 miscalibration.
    expect(gradeRow(PORT, evidence([], { pageAligned: true }))).toBe("medium");
  });

  test("acceptance may demote an aligned row but never promote an unaligned one", () => {
    // Rule 1: the command tree answers "is this a real field here" — a fact about the query.
    expect(gradeRow(PORT, evidence([PORT], { acceptsName: true }))).toBe("high");
    expect(gradeRow(PORT, evidence([PORT], { acceptsName: false }))).toBe("medium");
    expect(gradeRow(PORT, evidence([], { acceptsName: true }))).toBe("low");
    expect(gradeRow(PORT, evidence(["/ip/dhcp-server"], { acceptsName: true }))).toBe("low");
  });

  test("a name with no arg rows anywhere proves nothing, so it does not demote", () => {
    expect(gradeRow(PORT, evidence([PORT], { acceptsName: null }))).toBe("high");
  });

  test("a near-miss menu is medium: ancestor with depth, or any descendant", () => {
    expect(gradeRow(PORT, evidence(["/interface/bridge"]))).toBe("medium");
    expect(gradeRow("/interface/bridge", evidence([PORT]))).toBe("medium");
  });

  test("a bare top-level menu is not evidence — nearly every section mentions one", () => {
    expect(gradeRow(PORT, evidence(["/interface"]))).toBe("low");
    // …but it still counts when it IS the menu asked about.
    expect(gradeRow("/interface", evidence(["/interface"]))).toBe("high");
  });

  test("silence is low, not medium (rule 3)", () => {
    expect(gradeRow(PORT, evidence([]))).toBe("low");
    expect(gradeRow(PORT, evidence(["/ip/dhcp-server", "/ip/firewall/filter"]))).toBe("low");
  });

  test("a named-but-out-supported menu is a cross-reference, not the subject", () => {
    // The real case: the bridge-firewall section cites /ip/firewall/filter while documenting
    // /interface/bridge/filter. Naming alone used to be enough to call it `high`.
    expect(
      gradeRow(
        "/ip/firewall/filter",
        evidence(["/ip/firewall/filter", "/interface/bridge/filter"], {
          supported: ["/interface/bridge/filter"],
          acceptsName: true,
        }),
      ),
    ).toBe("medium");
  });
});

describe("supportedPaths", () => {
  const accepts = (m: Record<string, string[]>) =>
    new Map(Object.entries(m).map(([k, v]) => [k, new Set(v)]));

  test("picks the menu that owns most of the section's own properties", () => {
    const found = supportedPaths(
      new Set(["/ip/firewall/filter", "/interface/bridge/filter"]),
      ["chain", "action", "mac-protocol"],
      accepts({
        chain: ["/ip/firewall/filter", "/interface/bridge/filter"],
        action: ["/ip/firewall/filter", "/interface/bridge/filter"],
        "mac-protocol": ["/interface/bridge/filter"],
      }),
    );
    expect([...found]).toEqual(["/interface/bridge/filter"]);
  });

  test("a single named menu needs no support at all", () => {
    expect([...supportedPaths(new Set([PORT]), [], accepts({}))]).toEqual([PORT]);
  });

  test("keeps every menu when the command tree knows none of the names — silence cannot demote", () => {
    const paths = new Set([PORT, "/ip/dhcp-server"]);
    expect(supportedPaths(paths, ["undocumented-thing"], accepts({}))).toEqual(paths);
  });

  test("ties keep both — a menu and its submenu can be equally supported", () => {
    const found = supportedPaths(
      new Set(["/interface/bridge", PORT]),
      ["pvid"],
      accepts({ pvid: ["/interface/bridge", PORT] }),
    );
    expect([...found].sort()).toEqual(["/interface/bridge", PORT]);
  });
});

describe("tierRank", () => {
  test("orders high before medium before low", () => {
    expect([...["low", "high", "medium"] as const].sort((a, b) => tierRank(a) - tierRank(b))).toEqual([
      "high",
      "medium",
      "low",
    ]);
  });
});
