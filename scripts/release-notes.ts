#!/usr/bin/env bun

/**
 * release-notes.ts — print the CHANGELOG.md part of a GitHub Release body (#22).
 *
 * Called from .github/workflows/release.yml, which appends the database stats and
 * build info underneath. A latest-channel release gets its own `## [X.Y.Z]` block
 * (the CHANGELOG gate already proved it exists). A `-next.N` prerelease has no
 * promoted heading by design, so it gets the `[Unreleased]` block, labelled as such,
 * which is what each -next is meant to contain.
 *
 * Usage:
 *   bun run scripts/release-notes.ts <version> [--changelog CHANGELOG.md]
 *
 * Pure function of the version and the CHANGELOG, so a republish_assets run that
 * rewrites the body from the same commit writes the same body.
 */

/**
 * The body of the `## [heading]` block: everything up to the next `## [` heading,
 * trimmed. Null when the heading is absent. `heading` is matched exactly, so
 * "0.11.3" does not match "## [0.11.30]".
 */
export function changelogBlock(changelog: string, heading: string): string | null {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${heading}]`));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith("## ["));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n").trim();
}

/** The first released (non-Unreleased) version heading, i.e. the last stable release. */
export function lastReleasedVersion(changelog: string): string | null {
  for (const m of changelog.matchAll(/^## \[([^\]]+)\]/gm)) {
    if (m[1] !== "Unreleased") return m[1] ?? null;
  }
  return null;
}

export function releaseChanges(changelog: string, version: string): string {
  const bare = version.replace(/^v/, "");
  if (bare.includes("-")) {
    const since = lastReleasedVersion(changelog);
    const title = since ? `## Changes since ${since} (unreleased)` : "## Unreleased changes";
    const block = changelogBlock(changelog, "Unreleased");
    // A missing heading is a broken CHANGELOG, not "nothing changed" — fail like the stable path.
    if (block === null) throw new Error('CHANGELOG.md has no "## [Unreleased]" heading');
    return `${title}\n\n${block || "_No unreleased changes are recorded in CHANGELOG.md._"}`;
  }
  const block = changelogBlock(changelog, bare);
  if (block === null) throw new Error(`CHANGELOG.md has no "## [${bare}]" heading`);
  return `## Changes in ${bare}\n\n${block || "_No changes are recorded in CHANGELOG.md for this version._"}`;
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version || version.startsWith("--")) {
    console.error("usage: bun run scripts/release-notes.ts <version> [--changelog CHANGELOG.md]");
    process.exit(2);
  }
  const idx = process.argv.indexOf("--changelog");
  const path = idx !== -1 ? (process.argv[idx + 1] ?? "CHANGELOG.md") : "CHANGELOG.md";
  console.log(releaseChanges(await Bun.file(path).text(), version));
}
