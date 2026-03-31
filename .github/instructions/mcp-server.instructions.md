---
description: "Use when working on MCP server tools, query logic, or FTS5 search. Covers BM25 ranking, compound terms, stop words, and tool schema conventions."
applyTo: "src/mcp.ts, src/query.ts, src/query.test.ts, src/search.ts"
---
# MCP Server & Query Engine

## MCP Tool Conventions
- Server name: `"rosetta"` — never change
- Zod v4 installed, but import from `"zod/v3"` — MCP SDK requires Zod v3 API
- Transport: stdio (default) or Streamable HTTP (`--http` flag). HTTP uses `Bun.serve()` + `WebStandardStreamableHTTPServerTransport` in stateful mode.
- Tools return structured objects, not raw SQL rows
- Tool descriptions should include knowledge boundaries (doc export date, version range)

## 11 Tools
| Tool | Purpose |
|------|---------|  
| `routeros_search` | FTS5 across pages, BM25 ranked |
| `routeros_get_page` | Full page by ID or title, includes callouts |
| `routeros_lookup_property` | Exact property name, optional command path filter |
| `routeros_search_properties` | FTS across property names + descriptions |
| `routeros_command_tree` | Browse command hierarchy, optional version param |
| `routeros_search_callouts` | FTS across callout notes/warnings/info, optional type filter |
| `routeros_search_changelogs` | FTS across parsed changelog entries, version range + category + breaking-only filters |
| `routeros_command_version_check` | Which RouterOS versions include a command path |
| `routeros_device_lookup` | Hardware specs by name/code, FTS + structured filters |
| `routeros_stats` | DB health: counts, version range, link coverage |
| `routeros_current_versions` | Live-fetch current RouterOS versions from MikroTik |

## FTS5 Query Rules
- BM25 weights: title=3.0, path=2.0, text=1.0, code=0.5
- AND mode first, fallback to OR if zero results (all search tools: pages, properties, callouts, changelogs)
- Stop words list in `query.ts` (~72 words) — do not duplicate elsewhere
- Compound terms (~37 RouterOS pairs) → FTS5 NEAR expressions
- Porter unicode61 tokenizer for pages/properties/callouts/changelogs — stemming is automatic
- Device search uses unicode61 only (no porter) + LIKE substring fallback + FTS prefix matching

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
