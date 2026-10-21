import { describe, expect, test } from "bun:test";
import { manualVersionMismatch, parseManualVersion } from "./manual-version.ts";

// Header lines as manual.mikrotik.com served them on 2026-10-20.
const llms = (version: string) =>
  `# MikroTik RouterOS Manual\n\n> Official MikroTik RouterOS documentation.\n\nIndex of the RouterOS ${version} manual, in documentation menu order. Links open Markdown copies of the pages.\n\n## Overview\n`;

describe("parseManualVersion", () => {
  test("reads the version the default and versioned trees declare", () => {
    expect(parseManualVersion(llms("7.26"))).toBe("7.26");
    expect(parseManualVersion(llms("7.24"))).toBe("7.24");
  });

  test("accepts patch and prerelease spellings", () => {
    expect(parseManualVersion(llms("7.24.5"))).toBe("7.24.5");
    expect(parseManualVersion(llms("7.26beta3"))).toBe("7.26beta3");
    expect(parseManualVersion(llms("7.25rc2"))).toBe("7.25rc2");
  });

  test("throws when the header is missing rather than guessing a version", () => {
    expect(() => parseManualVersion("# MikroTik RouterOS Manual\n\n- [Introduction](https://manual.mikrotik.com/docs/introduction.md)\n")).toThrow(
      "manual tree's version is unknown",
    );
  });
});

describe("manualVersionMismatch", () => {
  const mine = { key: "cliref_manual_version", version: "7.26" };

  test("passes when the other store agrees or has not been stamped", () => {
    expect(manualVersionMismatch(mine, { key: "docs_manual_version", version: "7.26" })).toBeNull();
    expect(manualVersionMismatch(mine, { key: "docs_manual_version", version: null })).toBeNull();
  });

  test("names both keys when the stores came from different trees", () => {
    expect(manualVersionMismatch(mine, { key: "docs_manual_version", version: "7.24" })).toContain(
      "cliref_manual_version=7.26 but docs_manual_version=7.24",
    );
  });
});
