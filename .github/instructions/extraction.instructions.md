---
description: "Use when writing or modifying extraction scripts, property parsing, command tree loading, or callout extraction. Covers idempotent patterns, HTML parsing with linkedom, table detection, and version-aware command extraction."
applyTo: "src/extract-*.ts, src/link-commands.ts"
---
# Extraction Pipeline

## Idempotent Pattern
Every extractor follows the same structure:
1. DELETE existing data (respect FK order) or DROP+CREATE
2. Process input files (HTML, JSON, or CSV)
3. FTS5 indexes auto-populated via triggers defined in `src/db.ts`

## Pipeline Order

**Single version:** `extract-html` → `extract-properties` → `extract-commands` → `extract-devices` → `link-commands`
```sh
make extract
```

**All versions:** `extract-html` → `extract-properties` → `extract-all-versions` → `extract-devices` → `link-commands`
```sh
make extract-full
```

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
