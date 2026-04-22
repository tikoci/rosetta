---
description: "Use when writing or modifying extraction scripts, property parsing, command tree loading, or callout extraction. Covers idempotent patterns, HTML parsing with linkedom, table detection, version-aware command extraction, and test isolation for extractor modules."
applyTo: "src/extract-*.ts, src/extract-*.test.ts, src/link-commands.ts"
---
# Extraction Pipeline

## Idempotent Pattern
Every extractor follows the same structure:
1. DELETE existing data (respect FK order) or DROP+CREATE
2. Process input files (HTML, JSON, or CSV)
3. FTS5 indexes auto-populated via triggers defined in `src/db.ts`

## Pipeline Order

**Single version:** `extract-html` → `extract-properties` → `extract-commands` → `extract-devices` → `extract-test-results` → `extract-changelogs` → `link-commands`
```sh
make extract
```

**All versions:** `extract-html` → `extract-properties` → `extract-all-versions` → `extract-devices` → `extract-test-results` → `extract-changelogs` → `link-commands`
```sh
make extract-full
```

**Note:** `extract-videos` is NOT in either chain — it requires `yt-dlp` installed and takes 30–60 min. Run separately with `make extract-videos` (full fetch) or `make extract-videos-from-cache` (from committed NDJSON, used in CI).

## CI Pickup Checklist (Required)

When an extraction/backfill item is marked complete, verify CI behavior explicitly:

1. Confirm the release workflow step in `.github/workflows/release.yml` runs the extractor with the required flags/defaults.
2. If extraction defaults changed, confirm CI uses that default path (not a local-only Make target).
3. If a new Make target was added for convenience, do not rely on it for CI unless the workflow actually calls it.
4. If CI does not yet execute the new behavior, update the workflow in the same PR or keep the backlog item open/deferred with a specific CI follow-up.

Do not assume maintainers will run local `make` commands to compensate for missing CI wiring.

## HTML Parsing (extract-html.ts)
- Use `linkedom` (not jsdom) — `import { parseHTML } from 'linkedom'`
- Confluence HTML class patterns:
  - Property tables: `.confluenceTable` with "Property" header
  - Code blocks: `pre.syntaxhighlighter-pre` with `brush: ros`
  - Breadcrumbs: `#breadcrumbs`
  - Main content: `#main-content`
  - Callouts: `div[role="region"].confluence-information-macro` with `aria-label`
  - Headings with IDs: `h1[id], h2[id], h3[id]` — used for section extraction
- Callouts extracted in Pass 3, sections in Pass 4, after pages and properties

## Version-Aware Commands (extract-commands.ts)
- CLI flags: `--version`, `--channel`, `--extra`, `--accumulate`
- Default mode: replaces `commands` table (primary version)
- `--accumulate` mode: only adds to `command_versions`, preserves `commands`
- Primary version = latest stable (currently 7.22)

## Batch Version Extraction (extract-all-versions.ts)
- Discovers versions from restraml GitHub Pages index (`https://tikoci.github.io/restraml/`) by default; accepts explicit local `docs/` path override when passed as CLI arg
- Prefers `extra/inspect.json` (all extra-packages on CHR) over base `inspect.json`
- Classifies channel: "beta"/"rc" → development, else stable
- Runs primary extraction for latest stable, accumulate for all others
- 46 versions: 7.9 through 7.23beta2
- **Coverage gap:** CHR misses some extra-packages (Wi-Fi drivers, zerotier) — HTML docs cover those

## Heuristics in link-commands.ts
- Extracts `/path/like/this` patterns from code blocks and `<strong>`/`<code>` tags
- Filters non-RouterOS paths (e.g., `/bin/bash`, `/etc/config`)
- Links dir + all children to matching page
- Current coverage: ~92% of dirs

## Test Isolation — Extractor Imports

**Problem:** `db.ts` opens a SQLite connection at module-evaluation time. Bun's module cache means the first importer wins the singleton. If an extractor test statically imports a module that has a top-level `import { db } from "./db.ts"`, it will lock the singleton to the real `ros-help.db` path before `query.test.ts` can enforce its `:memory:` guard — causing a hard throw in CI.

**Which extractors are still at risk (top-level `import { db }`)**:
`extract-changelogs.ts`, `extract-commands.ts`, `extract-devices.ts`, `extract-properties.ts`, `extract-skills.ts`

**Which are already safe (import inside `main()`)**: `extract-html.ts`, `extract-dude.ts`, `extract-schema.ts`, `extract-test-results.ts`, `extract-videos.ts`

**Required pattern for any new extractor test file:**

```ts
// MUST be the first statement — before any import — so db.ts sees it
process.env.DB_PATH = ":memory:";

import { describe, expect, it } from "bun:test";
// ... other safe imports (linkedom, node:fs, etc.) ...

// Dynamic import ensures DB_PATH is set before db.ts module is evaluated
const { myPureFunction } = await import("./extract-something.ts");
```

**Why dynamic import:** Bun hoists static `import` declarations before any statements in the file, so `process.env.DB_PATH = ":memory:"` must use a dynamic `await import(...)` for the extractor — otherwise the assignment runs after `db.ts` has already opened the real DB.

**Only needed for extractors still in the "at risk" list above.** For safe extractors (those with `import.meta.main` guards), a static import is fine because importing them never touches the DB.
