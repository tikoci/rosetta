---
name: re-extract
description: "Re-extract RouterOS documentation from HTML export into SQLite. Use when: updating docs from new Confluence export, rebuilding database, running extraction pipeline, refreshing documentation data."
argument-hint: "Path to new HTML export directory (optional)"
---
# Re-extract Documentation Pipeline

## When to Use
- A new Confluence HTML export is available
- Database needs rebuilding from scratch
- Schema changes require fresh extraction
- New RouterOS versions available in restraml GitHub Pages

## Procedure

1. **Verify prerequisites**
   - Bun is installed: `bun --version`
   - Dependencies installed: `bun install`
   - HTML export exists in `box/documents-export-*/ROS/`
   - For commands: internet access to `https://tikoci.github.io/restraml/` (or provide a local docs path explicitly)

2. **Clean existing database**
   ```sh
   make clean
   ```

3. **Run full pipeline** (choose one)

   Single version (fast, latest stable only):
   ```sh
   make extract
   ```

   All versions (slower, all 46 RouterOS versions):
   ```sh
   make extract-full
   ```

   Pipeline order:
   - `extract-html` — HTML → pages + callouts tables
   - `extract-properties` — Property tables from HTML → properties table
   - `extract-commands` or `extract-all-versions` — inspect.json → commands + ros_versions + command_versions
   - `link` — command ↔ page mapping

4. **Verify results**
   ```sh
   make search query="firewall filter"
   ```
   Expected counts (full pipeline):
   - ~317 pages, ~4860 properties, ~1034 callouts
   - ~40K commands (primary version), ~1.67M command_versions
   - 46 ros_versions, ~92% dir link coverage

5. **Validate with type check and lint**
   ```sh
   bun run typecheck && make lint
   ```

## Troubleshooting
- If HTML directory changed, update `HTML_DIR` in the root Makefile
- If using offline/local data, pass explicit source paths to `extract-commands.ts` or `extract-all-versions.ts`
- Each extractor is idempotent — safe to re-run individually
- FK deletion order matters: callouts → properties → pages
