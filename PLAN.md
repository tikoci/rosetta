# Multi-Source RouterOS Knowledge Base — Plan & Status

## Overview

Expand mikrotik-docs from single-version doc search into a multi-source RouterOS knowledge base:
per-device hardware data (from MikroTik CSV), version-aware command tree (from 46 inspect.json versions),
callout extraction (warnings/notes from Confluence HTML), and knowledge boundary awareness.

## Phase Status

| Phase | Status | Description |
|-------|--------|-------------|
| Phase 1: Device data | **Not started** | CSV obtained, schema documented, extractor + MCP tools not yet built |
| Phase 2: Callouts | **Done** | 1,034 callouts extracted, FTS5 indexed, MCP tool + getPage enrichment |
| Phase 3: Multi-version | **Done** | 46 versions (7.9–7.23beta2), 1.67M command_versions, primary=7.22 |
| Phase 4: Doc versioning | **Deferred** | Simple — not needed until second HTML export exists |
| Phase 5: Knowledge boundaries | **Done** | Tool descriptions updated, stats enriched with version range + date |

## Phase 1: Device/Product Data (TODO)

**Source:** `matrix/2026-03-25/matrix.csv` — 144 products, 34 columns from Livewire export.
See `matrix/CLAUDE.md` for full column schema.

**Download method changed:** The old `curl -X POST -d "ax=matrix"` endpoint is dead.
Now requires manual browser export via the PowerGrid download button at mikrotik.com/products/matrix.

### Remaining work

1. **Add `devices` table to `src/db.ts`** — Map CSV columns. Include `devices_fts` over product name + architecture + CPU for text search.
2. **Create `src/extract-devices.ts`** — Idempotent: DELETE + INSERT from CSV. Handle BOM. Follow extractor pattern.
3. **Add MCP tools to `src/mcp.ts`** —
   - `routeros_device_lookup`: exact match by product name or product code
   - `routeros_device_search`: FTS query + optional structured filters (architecture, min ports, has_poe, etc.)
4. **Query functions in `src/query.ts`** — FTS for name search, SQL WHERE for structured specs.
5. **Makefile** — `extract-devices` target, include in pipeline.
6. **Potential enrichment** — Cross-reference device architecture → inspect.json architecture. Map "RouterOS v7" devices to version range.

### Why Phase 1 ordering didn't matter

Phase 1 was planned first because the CSV endpoint was a *blocker* — we didn't know if the data was obtainable. The actual implementation work (Phase 2 callouts, Phase 3 versions) was independent: no data dependency between device specs and doc extraction. Doing Phase 1 first would NOT have changed any subsequent phase:

- **Phase 2 (callouts):** Pure HTML extraction. No device data dependency.
- **Phase 3 (multi-version):** Pure inspect.json extraction. No device data dependency.
- **Phase 5 (knowledge boundaries):** Would have included device count in stats, but this is additive.

The only thing Phase 1 would have enabled earlier: the `routeros_device_lookup` tool, which is useful for MCP consumers but doesn't affect the extraction pipeline. The CSV investigation took ~5 minutes and unblocked the schema design; the actual extraction code is straightforward and can be done next.

## Phase 2: Callout Extraction (DONE)

**1,034 callouts** from 317 pages. Types: Note, Warning, Info.

### What was built
- `callouts` table + `callouts_fts` FTS5 index in `src/db.ts`
- Callout extraction from `div[role="region"]` with `aria-label` in `src/extract-html.ts`
- `searchCallouts(query, type?, limit)` in `src/query.ts`
- `getPage()` enriched to return callouts array
- `routeros_search_callouts` MCP tool with optional type filter

### Key decisions
- Callouts have FK to pages — must be deleted before pages in re-extraction
- FTS5 auto-populated via triggers (no manual FTS inserts)
- Type filter is optional — allows "all warnings about X" queries

## Phase 3: Multi-Version Command Tree (DONE)

**46 versions**, **1.67M** command_versions entries. Primary: 7.22 (latest stable).

### What was built
- `ros_versions` and `command_versions` tables in `src/db.ts`
- `ros_version` column on `commands` table (with migration for existing DBs)
- `src/extract-commands.ts` — accepts `--version`, `--channel`, `--extra`, `--accumulate` flags
- `src/extract-all-versions.ts` — iterates `~/restraml/docs/*/extra/inspect.json`, latest stable = primary
- `routeros_command_version_check` MCP tool
- `routeros_command_tree` accepts optional `version` parameter
- `browseCommandsAtVersion()` and `checkCommandVersions()` in `src/query.ts`
- Makefile: `extract-all-versions` target, `extract-full` pipeline

### Key decisions
- Junction table approach (`command_versions`) — not per-version rows in `commands`
- Latest stable (7.22) is primary — used for `commands` table and linking
- Development versions (betas, RCs) included but queryable via channel filter
- `--accumulate` mode only touches `command_versions`, doesn't replace `commands` table
- Version derived from file path if not explicit: `/docs/7.22/` → version "7.22"
- Channel derived from version string: "beta"/"rc" → development, else stable

### Version coverage
- Stable: 7.9, 7.9.2, 7.10.2, 7.11.3, ..., 7.21.3, 7.22 (35 versions)
- Development: 7.22beta1/3/5/6, 7.22rc1/2/4, 7.23beta2 (8 versions)
- Extra packages: all versions have `extra/inspect.json`
- Command tree growth: 28K entries (7.9) → 40K entries (7.22)

## Phase 4: Documentation Version Tracking (DEFERRED)

Not needed until a second HTML export is available. When it arrives:
- Add `doc_exports` metadata table
- Compare text hashes to detect changed pages
- Watched pages: Switch Chip Features, Peripherals, Marvell Prestera, Bridging and Switching

## Phase 5: Knowledge Boundaries (DONE)

### What was built
- Tool descriptions include: "Documentation from March 2026 Confluence export. Command tree covers RouterOS 7.9–7.23beta2 (v7 only, no v6)."
- `routeros_stats` returns: page count, property count, command count, callout count, version range, doc export date, link coverage
- Stats useful for LLM self-calibration on knowledge boundaries

## Decisions & Constraints

- **v6 is out of scope** — no inspect.json data for v6, document as unknown territory
- **`_completion` data deferred** — PR #35 in restraml adds deep-inspect.json with arg completions. Schema stub TBD when that ships.
- **CSV requires manual download** — Livewire/PowerGrid export, not automatable via curl
- **HTML doc versioning is simple** — no need to overengineer; just track export date
- **All 46 versions extracted** — prefer more data, filter at query time by channel
- **FTS5 for text search, SQL WHERE for structured queries** — devices need both

## Data Sources

| Source | Location | Format | Coverage |
|--------|----------|--------|----------|
| Confluence HTML | `box/documents-export-2026-3-25/ROS/` | 317 HTML files | March 2026 export |
| inspect.json | `~/restraml/docs/*/extra/inspect.json` | JSON tree per version | 46 versions (7.9–7.23beta2) |
| Product matrix | `matrix/2026-03-25/matrix.csv` | CSV, 34 columns | 144 products, March 2026 |
| Forum (future) | `~/Lab/mcp-discourse` | Separate project | Cross-reference TBD |

## Cross-References

| Project | Path | Relationship |
|---------|------|-------------|
| mcp-discourse | `~/Lab/mcp-discourse` | Same SQL-as-RAG pattern, forum data |
| restraml | `~/restraml` | Source of inspect.json + RAML schema |
| lsp-routeros-ts | `~/lsp-routeros-ts` | Consumer: hover help, property docs, command→URL |
| netinstall | `~/netinstall` | REST API gotchas (HTTP verb mapping) |
