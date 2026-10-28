---
name: re-extract
description: "Re-extract the legacy Confluence RouterOS documentation export into SQLite. Use only for rebuilding historical pre-migration DBs; the default pipeline (make extract-full) fetches the live manual.mikrotik.com Docusaurus docs instead."
argument-hint: "Path to legacy HTML export directory (optional)"
---
# Re-extract Legacy Documentation Pipeline

## When to Use
- A legacy Confluence HTML export is available
- Database needs rebuilding from scratch
- Schema changes require fresh extraction
- New RouterOS versions available in restraml GitHub Pages

Do **not** use this skill as the migration path for <https://manual.mikrotik.com>. MikroTik's new Docusaurus manual and CLI Reference require extractor and MCP/TUI result-shape redesign; read `DESIGN.md` and `briefings/B-0012-docusaurus-manual-migration.md` first.

## Procedure

1. **Verify prerequisites**
   - Bun is installed: `bun --version`
   - Dependencies installed: `bun install`
   - Legacy HTML export exists in `box/documents-export-*/ROS/`
   - For commands: internet access to `https://tikoci.github.io/restraml/` (or provide a local docs path explicitly)

2. **Clean existing database**
   ```sh
   make clean
   ```

3. **Run the legacy pipeline**

   `make extract` / `make extract-full` are the Docusaurus pipeline and never read
   `box/` — the legacy path is its own sequence:
   ```sh
   make extract-legacy-confluence   # extract-html + extract-properties from box/latest/ROS
   make extract-commands            # single version (fast), or:
   make extract-all-versions        # all tracked RouterOS versions (slower)
   make link
   ```

   Pipeline order:
   - `extract-html` — HTML → pages + callouts tables
   - `extract-properties` — Property tables from HTML → properties table
   - `extract-commands` or `extract-all-versions` — inspect.json → commands + ros_versions + command_versions
   - `link` — command ↔ page mapping

   Do not run this against a DB built by `extract-docusaurus` — pick one prose source per build.

4. **Verify results**
   ```sh
   make search query="firewall filter"
   ```
   Expected counts (March 2026 export, all versions):
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
