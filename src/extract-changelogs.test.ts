// Set BEFORE imports that can transitively load db.ts
process.env.DB_PATH = ":memory:";

import { describe, expect, test } from "bun:test";

const { buildChangelogVersionSet, LEGACY_FORMATTED_V7_BASE_VERSIONS } = await import("./extract-changelogs.ts");

describe("buildChangelogVersionSet", () => {
  test("always includes legacy v7 baseline versions", () => {
    const versions = buildChangelogVersionSet(["7.22.1", "7.23beta2"]);

    for (const legacy of LEGACY_FORMATTED_V7_BASE_VERSIONS) {
      expect(versions).toContain(legacy);
    }
  });

  test("keeps existing known versions and de-duplicates overlaps", () => {
    const versions = buildChangelogVersionSet(["7.22.1", "7.2", "7.8"]);

    expect(versions).toContain("7.22.1");
    expect(versions.filter((v) => v === "7.2")).toHaveLength(1);
    expect(versions.filter((v) => v === "7.8")).toHaveLength(1);
  });

  test("includes live channel head versions so latest long-term patch is not missed", () => {
    const versions = buildChangelogVersionSet(["7.21.3", "7.22.1"], ["7.21.4", "7.22.1", "7.23rc1"]);

    expect(versions).toContain("7.21.4");
    expect(versions.filter((v) => v === "7.22.1")).toHaveLength(1);
    expect(versions).toContain("7.23rc1");
  });
});
