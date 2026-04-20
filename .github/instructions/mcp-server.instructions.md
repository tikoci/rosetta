---
description: "Use when working on MCP server tools, query logic, FTS5 search, or the browse TUI. Covers BM25 ranking, compound terms, stop words, tool schema conventions, and TUI-MCP alignment."
applyTo: "src/mcp.ts, src/query.ts, src/query.test.ts, src/search.ts, src/browse.ts, src/db.ts"
---
# MCP Server & Query Engine

## Core Principle — TUI and MCP are a pair

The browse TUI (`src/browse.ts`) is a first-class surface, not a test harness. Both the MCP tool layer and the TUI are thin adapters over query functions in `src/query.ts`. When adding a feature, default to putting the logic in core (`query.ts`) so both surfaces inherit it. PRs that grow TUI-only or MCP-only heuristics are a smell — flag and move the logic to core. See `BACKLOG.md` "Guiding Principles" and "North Star — unified `routeros_search`".

**Consolidation direction:** the current 15 tools are being compressed toward ~8–10 via a smarter `routeros_search` that classifies the input (command path, version, topic, device, property) and returns enriched results with cross-table `related` sections and `next_steps`. See the North Star in `BACKLOG.md` before adding a new tool — the right answer is usually "make `routeros_search` smarter, not more tools."

## MCP Tool Conventions
- Server name: `"rosetta"` — never change
- Zod v4 installed, but import from `"zod/v3"` — MCP SDK requires Zod v3 API
- Transport: stdio (default) or Streamable HTTP (`--http` flag). HTTP uses `Bun.serve()` + per-session `WebStandardStreamableHTTPServerTransport` routing — each client session gets its own transport + McpServer instance via `createServer()` factory.
- Tools return structured objects, not raw SQL rows
- Tool descriptions should include knowledge boundaries (doc export date, version range)
- **Before adding a new tool, ask:** can `routeros_search` (via classifier + `related` sections) or `routeros_get_page` (via smart prioritization) answer this instead? Usually yes.

## 15 Tools
| Tool | Purpose |
|------|---------|  
| `routeros_search` | FTS5 across pages, BM25 ranked |
| `routeros_get_page` | Full page by ID or title, includes callouts |
| `routeros_lookup_property` | Exact property name, optional command path filter |
| `routeros_command_tree` | Browse command hierarchy, optional version param |
| `routeros_search_callouts` | FTS across callout notes/warnings/info, optional type filter |
| `routeros_search_changelogs` | FTS across parsed changelog entries, version range + category + breaking-only filters |
| `routeros_search_videos` | FTS across YouTube video transcript segments — chapter-level results with timestamps and excerpts |
| `routeros_command_version_check` | Which RouterOS versions include a command path |
| `routeros_command_diff` | Diff two RouterOS versions — added/removed command paths, optional path_prefix to scope |
| `routeros_device_lookup` | Hardware specs by name/code, FTS + structured filters, auto-attaches test results |
| `routeros_search_tests` | Cross-device performance benchmarks — filter by test_type, mode, packet_size; one call replaces 125+ individual lookups |
| `routeros_dude_search` | FTS across archived Dude wiki docs — separate from main RouterOS search |
| `routeros_dude_get_page` | Full Dude wiki page by ID or title, with screenshot metadata |
| `routeros_stats` | DB health: counts, version range, link coverage |
| `routeros_current_versions` | Live-fetch current RouterOS versions from MikroTik |

## FTS5 Query Rules
- BM25 weights: title=3.0, path=2.0, text=1.0, code=0.5
- AND mode first, fallback to OR if zero results (all search tools: pages, properties, callouts, changelogs)
- Stop words list in `query.ts` (~50 words) — do not duplicate elsewhere
- Compound terms (~44 RouterOS pairs) → FTS5 NEAR expressions
- Porter unicode61 tokenizer for pages/properties/callouts/changelogs — stemming is automatic
- Device search uses unicode61 only (no porter) + LIKE substring fallback + FTS prefix matching
- Device exact matches and small result sets (≤5) auto-attach `test_results` (ethernet/IPSec benchmarks) and `product_url`/`block_diagram_url` from `device_test_results` table

## Tool Description Patterns
- **Workflow arrows**: each tool description lists `→ next_tool: when to use it` to guide agents through multi-step retrieval
- **Empty-result hints**: tool handlers return actionable next-step suggestions when results are empty (e.g., "Try routeros_search to find the page, then routeros_get_page")
- **Knowledge boundaries**: every tool description includes doc export date, version range, and v6 caveats
- `get_page` defaults `max_length` to 16000 — when exceeded and page has sections, returns a table of contents (heading, level, char_count, deep-link URL) instead of truncating. TOC responses replace full callouts with a compact `callout_summary` (count + type breakdown) to reduce response size. Agent re-calls with `section` param to get specific sections.
- `get_page` supports `section` param — pass heading text or anchor_id to get a specific section's content. Section content is also subject to `max_length`: if exceeded and sub-sections exist, returns sub-section TOC; otherwise truncates using the 80% text / 20% code budget. For pages without sections, `max_length` truncation still uses that same budget.
- `search_callouts` supports type-only browse (no query, just type filter)
- `command_version_check` returns boundary notes when command exists at earliest tracked version

## Version Sorting
- `compareVersions()` in `query.ts` sorts RouterOS versions numerically (e.g., 7.9 < 7.10 < 7.22)
- Beta/RC ordering: beta < rc < release for the same numeric version
- Use this instead of SQL `min()`/`max()` which sorts lexicographically

## Version Accuracy Guidance

Tool descriptions and agent responses should convey these version boundaries:

- **Documentation covers v7 only.** The HTML export doesn't distinguish versions — it reflects the then-current long-term release (~7.22). Callouts sometimes mention older-version differences, which is why we extract them.
- **v6 is a different world.** Syntax, commands, and major subsystems (routing/BGP, firewall, bridging) all changed in v7. If someone is using v6, answers from this DB are significantly less reliable. Tool descriptions should make this explicit.
- **Command data: 7.9–7.23beta2.** Below 7.9 we have no `inspect.json` data at all. Above 7.23beta2 may exist but isn't extracted yet.
- **Older than current long-term is unpatched.** MikroTik only backports fixes to the current long-term branch. Anything older doesn't get security patches. Recommend upgrading to at least the current long-term — both for security and to align with our documentation.
- **The long-term channel is our northstar.** The docs align best with the current long-term release. Below that version, information may be lossy. The actual long-term version at extraction time was ~7.22 (7.22.1 specifically), but the docs aren't version-pinned.
- **Extra-packages:** inspect.json is extracted from CHR with extra-packages enabled, but CHR misses some packages (Wi-Fi drivers, zerotier). The HTML docs cover all packages. See DESIGN.md for details.

RouterOS version channels can be checked programmatically:
```
https://upgrade.mikrotik.com/routeros/NEWESTa7.stable
https://upgrade.mikrotik.com/routeros/NEWESTa7.long-term
https://upgrade.mikrotik.com/routeros/NEWESTa7.testing
https://upgrade.mikrotik.com/routeros/NEWESTa7.development
```
Returns a plain-text version string (e.g., `7.22.1`).

## Adding a New Tool
1. Add query function in `src/query.ts`
2. Register via `server.registerTool()` in `src/mcp.ts` with Zod input schema
3. Update tool descriptions to include knowledge boundaries and help LLM agents pick the right tool
4. Add tests in `src/query.test.ts` — pure-function tests + DB integration against in-memory SQLite

## Test Requirements

**This is a hard rule.** Any change to transport, protocol, or tool behavior MUST have corresponding tests before shipping. The bug where HTTP transport was completely broken in v0.3.0 shipped because there were no integration tests for it — only manual curl checks.

### Test files and what they cover

| File | Scope | Runs against |
|------|-------|-------------|
| `src/query.test.ts` | Query planner, FTS5, DB integration, schema health | In-memory SQLite |
| `src/release.test.ts` | File consistency, build constants, structural checks | File reads only |
| `src/mcp-http.test.ts` | HTTP transport: session lifecycle, multi-client, errors | Live server process |

### When to add tests

- **New tool** → unit test in `query.test.ts` (pure function + DB)
- **Transport changes** → integration test in `mcp-http.test.ts` (real HTTP requests)
- **New CLI flag or build artifact** → structural test in `release.test.ts`
- **Schema changes** → schema health tests in `query.test.ts`

### HTTP transport test pattern

Tests in `mcp-http.test.ts` start an actual server process and make real HTTP requests. Key patterns:
- `mcpInitialize()` → POST initialize, returns `{ sessionId, body }`
- `mcpNotification()` → send `notifications/initialized` (required before other calls)
- `mcpRequest()` → POST with session ID, returns parsed SSE messages
- Server processes are started per `describe()` block and cleaned up in `afterAll()`

### Structural tests as guardrails

`release.test.ts` includes pattern-matching tests that verify code structure without running it. These catch regressions like "someone replaced per-session routing with a single shared transport" at `bun test` time, before the code ever ships. Add structural tests for any architectural invariant.

## Browse TUI — MCP Alignment

`src/browse.ts` is the interactive terminal browser. It is the **TUI mirror** of the MCP server — every MCP tool has a corresponding TUI command, and they share the same query functions from `src/query.ts`. Changes to one side should be reflected in the other.

### Alignment rule

> If a new data source, filter, or tool is added to MCP, check browse.ts. The exact fidelity is not required (e.g. the TUI can be simpler), but the **shape of tools should match the shape of the TUI**: same filters available, same default behaviors, same result structure.

| TUI command | MCP tool | Notes |
|-------------|----------|-------|
| `search` / bare text | `routeros_search` | — |
| `page` | `routeros_get_page` | — |
| `prop` / `props` | `routeros_lookup_property` | `prop` is context-scoped to current page; `props` uses `searchProperties()` (internal, no MCP tool) |
| `cmd` | `routeros_command_tree` | `cmd edit` resolves relative to current commands context |
| `device` / `dev` | `routeros_device_lookup` | — |
| `tests` | `routeros_search_tests` | Default `packet_size=512` when no filters given |
| `callouts` / `cal` | `routeros_search_callouts` | `cal` with no args shows callouts for current page |
| `changelog` / `cl` | `routeros_search_changelogs` | — |
| `videos` / `vid` /  `video` | `routeros_search_videos` | `video` is an alias |
| `dude` | `routeros_dude_search` | Number selection → `routeros_dude_get_page` |
| `diff` | `routeros_command_diff` | — |
| `vcheck` / `vc` | `routeros_command_version_check` | — |
| `versions` / `ver` | `routeros_current_versions` | — |
| `stats` | `routeros_stats` | — |

### Browse TUI conventions

- Number selection (`#N`) works in any result context: search, devices, callouts, videos, properties, changelogs
- `b` / `back` re-renders the previous context (not just prints "back to X")
- Context-aware commands (`p`, `cal`, `cmd`) use the current context (page/sections/commands) automatically when no args are given
- `cmd edit` resolves as `/current/path/edit` when in a commands context
- `page` with no args navigates to the linked page when in a commands context
- Pager: Q to quit, SPACE for next page, ENTER for next line — keys don't leak to the readline prompt
