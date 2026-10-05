import { describe, expect, test } from "bun:test";
import { changelogBlock, lastReleasedVersion, releaseChanges } from "./release-notes.ts";

const CHANGELOG = `# Changelog

Preamble.

## [Unreleased]

### Fixed

- Unreleased fix.

## [0.11.30] — 2026-10-01

- Not 0.11.3.

## [0.11.3] — 2026-09-30

### Added

- Stable feature.

## [0.11.2] — 2026-09-06

- Older.
`;

describe("changelogBlock", () => {
  test("returns a block up to the next ## [ heading", () => {
    expect(changelogBlock(CHANGELOG, "Unreleased")).toBe("### Fixed\n\n- Unreleased fix.");
    expect(changelogBlock(CHANGELOG, "0.11.3")).toBe("### Added\n\n- Stable feature.");
  });

  test("matches the version exactly and runs to end of file for the last block", () => {
    expect(changelogBlock(CHANGELOG, "0.11.30")).toBe("- Not 0.11.3.");
    expect(changelogBlock(CHANGELOG, "0.11.2")).toBe("- Older.");
  });

  test("returns null for an absent heading and an empty string for an empty block", () => {
    expect(changelogBlock(CHANGELOG, "9.9.9")).toBeNull();
    expect(changelogBlock("## [Unreleased]\n\n## [1.0.0]\n- x\n", "Unreleased")).toBe("");
  });
});

describe("releaseChanges", () => {
  test("a latest release gets its own block", () => {
    expect(releaseChanges(CHANGELOG, "v0.11.3")).toBe("## Changes in 0.11.3\n\n### Added\n\n- Stable feature.");
  });

  test("a -next prerelease gets [Unreleased], labelled since the last release", () => {
    expect(lastReleasedVersion(CHANGELOG)).toBe("0.11.30");
    expect(releaseChanges(CHANGELOG, "v0.12.0-next.120")).toBe(
      "## Changes since 0.11.30 (unreleased)\n\n### Fixed\n\n- Unreleased fix.",
    );
  });

  test("an empty [Unreleased] says so instead of disappearing", () => {
    const body = releaseChanges("## [Unreleased]\n\n## [1.0.0]\n- x\n", "1.0.1-next.5");
    expect(body).toBe("## Changes since 1.0.0 (unreleased)\n\n_No unreleased changes are recorded in CHANGELOG.md._");
  });

  test("a latest release without a heading fails loudly", () => {
    expect(() => releaseChanges(CHANGELOG, "1.2.3")).toThrow('no "## [1.2.3]" heading');
  });

  test("works on the real CHANGELOG.md", async () => {
    const real = await Bun.file(`${import.meta.dir}/../CHANGELOG.md`).text();
    expect(releaseChanges(real, "0.0.0-next.1")).toStartWith("## Changes since ");
  });
});
