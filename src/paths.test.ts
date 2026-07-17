/**
 * paths.test.ts — grounding verdict classifier (#94).
 *
 * classifyDbGrounding is pure (no DB), so it is tested directly with the exact
 * provenance shapes the three surfaces (routeros_stats, MCP startup, db-doctor)
 * feed it. The load-bearing case is `internal_inconsistent`: the real-world
 * "Frankenstein" DB whose PRAGMA user_version was bumped in place over a stale
 * corpus, which every other check misses.
 */

import { describe, expect, test } from "bun:test";
import { classifyDbGrounding } from "./paths.ts";

const base = {
  codeSchema: 10,
  codeVersion: "0.11.0-rc.0",
  mode: "dev" as const,
};

describe("classifyDbGrounding", () => {
  test("coherent CI artifact on the same base version → ok (rc counter ignored)", () => {
    // Dev package.json reads rc.0 while the published DB is rc.102 — same base,
    // must NOT be flagged behind.
    const v = classifyDbGrounding({
      ...base,
      pragmaSchema: 10,
      metaSchema: 10,
      releaseTag: "v0.11.0-rc.102",
      sourceCommit: "abc123",
      builtAt: "2026-07-17T00:00:00.000Z",
    });
    expect(v.status).toBe("ok");
    expect(v.ok).toBe(true);
  });

  test("Frankenstein: db_meta.schema_version disagrees with pragma → internal_inconsistent", () => {
    const v = classifyDbGrounding({
      ...base,
      pragmaSchema: 10, // bumped in place → matches code, so NOT schema_mismatch
      metaSchema: 5, // stamped provenance still describes the old corpus
      releaseTag: "v0.10.0",
      sourceCommit: "65fc229",
      builtAt: "2026-07-08T00:00:00.000Z",
    });
    expect(v.status).toBe("internal_inconsistent");
    expect(v.ok).toBe(false);
  });

  test("pragma below code schema → schema_mismatch (takes precedence over everything)", () => {
    const v = classifyDbGrounding({
      ...base,
      pragmaSchema: 8,
      metaSchema: 8,
      releaseTag: "v0.11.0-rc.50",
      sourceCommit: "abc123",
      builtAt: "2026-07-01T00:00:00.000Z",
    });
    expect(v.status).toBe("schema_mismatch");
  });

  test("no release_tag / source_commit → unstamped (a local extraction build)", () => {
    const v = classifyDbGrounding({
      ...base,
      pragmaSchema: 10,
      metaSchema: 10,
      releaseTag: null,
      sourceCommit: null,
      builtAt: null,
    });
    expect(v.status).toBe("unstamped");
    expect(v.ok).toBe(false);
  });

  test("release base behind the running code → tag_behind", () => {
    const v = classifyDbGrounding({
      ...base,
      codeVersion: "0.12.0-rc.0",
      pragmaSchema: 10,
      metaSchema: 10,
      releaseTag: "v0.11.0-rc.102",
      sourceCommit: "abc123",
      builtAt: "2026-07-17T00:00:00.000Z",
    });
    expect(v.status).toBe("tag_behind");
  });

  test("release base ahead of the running code → ok (not flagged)", () => {
    const v = classifyDbGrounding({
      ...base,
      codeVersion: "0.11.0-rc.0",
      pragmaSchema: 10,
      metaSchema: 10,
      releaseTag: "v0.12.0-rc.1",
      sourceCommit: "abc123",
      builtAt: "2026-07-20T00:00:00.000Z",
    });
    expect(v.status).toBe("ok");
  });

  test("partial provenance (missing built_at) fails closed as provenance_incomplete", () => {
    // A real CI release stamps all four; release_tag + source_commit but no
    // built_at is a malformed artifact and must not reach ok.
    const v = classifyDbGrounding({
      ...base,
      pragmaSchema: 10,
      metaSchema: 10,
      releaseTag: "v0.11.0-rc.102",
      sourceCommit: "abc123",
      builtAt: null,
    });
    expect(v.status).toBe("provenance_incomplete");
    expect(v.ok).toBe(false);
  });

  test("release_tag present but schema_version stamp missing → provenance_incomplete", () => {
    const v = classifyDbGrounding({
      ...base,
      pragmaSchema: 10,
      metaSchema: null, // no db_meta.schema_version stamp
      releaseTag: "v0.11.0-rc.102",
      sourceCommit: "abc123",
      builtAt: "2026-07-17T00:00:00.000Z",
    });
    expect(v.status).toBe("provenance_incomplete");
    expect(v.ok).toBe(false);
  });

  test("unparseable release_tag is never classified ok — freshness is unverified", () => {
    const v = classifyDbGrounding({
      ...base,
      pragmaSchema: 10,
      metaSchema: 10,
      releaseTag: "nightly", // no MAJOR.MINOR.PATCH → compareBaseVersion returns null
      sourceCommit: "abc123",
      builtAt: "2026-07-17T00:00:00.000Z",
    });
    expect(v.status).toBe("provenance_incomplete");
    expect(v.ok).toBe(false);
  });

  test("unknown code version is never classified ok", () => {
    const v = classifyDbGrounding({
      ...base,
      codeVersion: "unknown",
      pragmaSchema: 10,
      metaSchema: 10,
      releaseTag: "v0.11.0-rc.102",
      sourceCommit: "abc123",
      builtAt: "2026-07-17T00:00:00.000Z",
    });
    expect(v.ok).toBe(false);
  });

  test("internal_inconsistent outranks tag_behind", () => {
    const v = classifyDbGrounding({
      ...base,
      codeVersion: "0.12.0-rc.0",
      pragmaSchema: 10,
      metaSchema: 5,
      releaseTag: "v0.10.0",
      sourceCommit: "65fc229",
      builtAt: "2026-07-08T00:00:00.000Z",
    });
    expect(v.status).toBe("internal_inconsistent");
  });
});
