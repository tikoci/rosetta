# Project Guidelines

## Overview

RouterOS documentation as SQLite FTS5 — an MCP server providing RAG search + command glossary over MikroTik's official docs. Built with **Bun** + **TypeScript**.

See [CLAUDE.md](../CLAUDE.md) for full architecture, schema, and source details.

## Project Documentation Convention

Three files, three jobs — use these, don't create new top-level `.md` files:

| File | What goes in it |
|------|----------------|
| [CLAUDE.md](../CLAUDE.md) | Architecture, schema, conventions — what the project **is** |
| [DESIGN.md](../DESIGN.md) | Decisions, data sources, constraints — **why** things are the way they are |
| [BACKLOG.md](../BACKLOG.md) | Ideas, considerations, future work — structured parking lot |

**Rule:** Decision or rationale → `DESIGN.md`. Idea, question, or future work → `BACKLOG.md`. How the project works → `CLAUDE.md`.

When deferring work or recording ideas, add them to `BACKLOG.md` under the appropriate heading.

### Capture everything that isn't done

**This is a hard rule, not a suggestion.** If your work surfaces any of the following, you must record it in the appropriate doc file *before finishing your response* — do not leave it as a verbal aside in conversation:

- **Known breakage or degradation** — something that's broken, will break, or works differently than expected. Include what failed, why, and what would fix it. → `BACKLOG.md` (Ready to Build) if actionable, or (To Investigate) if unclear.
- **Workarounds applied** — if you worked around a problem instead of fixing it, document both the workaround and the root cause. → `BACKLOG.md`
- **Deferred or incomplete work** — anything you explicitly chose not to do, or that's blocked on something external. Include the trigger condition ("do this when X happens"). → `BACKLOG.md` (Deferred)
- **Gotchas and footguns** — non-obvious constraints, compatibility issues, deprecation timelines, or things that will surprise the next person. → `DESIGN.md` if it's a project-level constraint; `BACKLOG.md` if it's a future risk to mitigate.
- **Schema or architecture changes** — if you changed how the project works, update `CLAUDE.md` to match.

**The test:** if you deleted the entire conversation history, would a new agent (or the maintainer) be able to discover this information from the project files alone? If not, you haven't captured it.

## Build and Test

```sh
bun install              # Install dependencies
make extract             # Full pipeline: HTML → properties → commands → link
make extract-full        # Full pipeline with all 46 RouterOS versions
make serve               # Start MCP server (stdio transport)
make search query="DHCP" # CLI search
bun test                 # Run tests (query + schema + release readiness + HTTP transport)
make typecheck           # Type checking (no emit)
make lint                # Biome linter
make preflight           # All checks: clean tree, DB, typecheck, test, lint
make clean               # Remove DB files
```

Individual extraction steps: `make extract-html`, `make extract-properties`, `make extract-commands`, `make extract-all-versions`, `make extract-devices`, `make extract-test-results`, `make extract-changelogs`, `make link`.

Release: `make release VERSION=v0.1.0` (new) or `make release VERSION=v0.1.0 FORCE=1` (update existing). See `make build-release` for build-only (no git/upload).

## Architecture

| Component | File | Purpose |
|-----------|------|---------|
| MCP Server | `src/mcp.ts` | 11 tools via stdio + Streamable HTTP transport using `@modelcontextprotocol/sdk` |
| Query Engine | `src/query.ts` | NL → FTS5 query planner, BM25 ranking, compound term recognition |
| Database | `src/db.ts` | Schema init, WAL mode, FTS5 triggers, singleton pattern |
| Extractors | `src/extract-*.ts` | HTML/JSON → SQLite (each drops and recreates its tables) |
| Linker | `src/link-commands.ts` | Command tree ↔ page matching (code paths + heuristics) |
| CLI Search | `src/search.ts` | Quick search from terminal |
| Tests | `src/query.test.ts`, `src/release.test.ts` | Bun tests — query planner + DB integration + schema; release readiness |

**Database:** `ros-help.db` (SQLite WAL mode). Main tables: `pages`, `sections`, `callouts`, `properties`, `commands`, `ros_versions`, `command_versions`, `devices`, `device_test_results`, `changelogs` with FTS5 indexes on pages, callouts, properties, devices, and changelogs.

**Data sources:**
- HTML export from Confluence in `box/latest/ROS/` (317 pages)
- `inspect.json` from [tikoci/restraml](https://github.com/tikoci/restraml) for the command tree (40K entries, 46 versions: 7.9–7.23beta2), fetched from `https://tikoci.github.io/restraml/` by default.
- Product matrix CSV in `matrix/` (144 products, 34 columns — hardware specs, license levels, pricing)
- Product test results + block diagrams from `https://mikrotik.com/product/<slug>` (125 devices with ethernet/IPSec benchmarks, 110 with block diagrams)
- Changelogs from `https://download.mikrotik.com/routeros/{version}/CHANGELOG` (parsed per-entry with category and breaking flag)

## Code Style

- **Runtime:** Bun (use `bun:sqlite` for DB, not better-sqlite3)
- **Modules:** ESM with `.ts` extensions in imports (`import { foo } from './bar.ts'`)
- **Validation:** Zod v4 installed; import from `"zod/v3"` for MCP SDK compatibility
- **DOM parsing:** linkedom (not jsdom)
- **Linter:** Biome (formatter disabled — only linting rules apply)
- **No emit:** TypeScript is type-checked only (`noEmit: true`), Bun runs `.ts` directly

## Conventions

- Extractors are idempotent — they `DELETE` existing data and rebuild
- FTS5 indexes use `porter unicode61` tokenizer with content-sync triggers (pages, callouts, properties); devices use `unicode61` only (no porter — model numbers shouldn't be stemmed)
- BM25 weights: title=3.0, path=2.0, text=1.0, code=0.5
- The MCP server name is `"rosetta"` — keep consistent across configs
- Stop words are hardcoded in `query.ts` (~72 words)
- Compound terms (~37 RouterOS pairs like firewall+filter) use FTS5 NEAR expressions

## Testing Requirements

**Hard rule: any behavioral change MUST have a corresponding test before shipping.** The HTTP transport was completely broken in a release because there were no transport-level tests — only manual curl checks that weren't captured as tests.

| Test file | What it covers |
|-----------|---------------|
| `src/query.test.ts` | Query planner (pure functions), DB integration (in-memory SQLite), schema health |
| `src/release.test.ts` | File consistency, build constants, structural pattern checks, container setup |
| `src/mcp-http.test.ts` | HTTP transport: session lifecycle, multi-client, errors (live server) |

**When to add tests:**
- New query function or tool → `query.test.ts`
- Transport or protocol changes → `mcp-http.test.ts`
- New CLI flag, build artifact, or file structure → `release.test.ts`
- Schema change → schema health section in `query.test.ts`

**Run `bun test` before any commit.** CI runs it too, but catching failures locally is faster.

## Version Accuracy

- Documentation covers **v7 only**, aligned with the long-term release (~7.22) at export time
- Docs are not versioned — they reflect the then-current long-term release, not a specific point release
- **Command data: 7.9–7.23beta2.** Below 7.9 there is no command tree data. Below 7.0 (v6) is a different world — syntax, routing/BGP, firewall, bridging all changed in v7
- For v6 questions, answers will be significantly less accurate — tool descriptions should flag this
- **Older than current long-term:** MikroTik does not patch versions older than the current long-term release. Recommend upgrading to at least long-term, both for security and to align with our data.
- Callouts sometimes document older-version differences, which is why we extract them
- **Extra-packages:** RouterOS has a base image (`routeros.npk`) plus extras (`container.npk`, `iot.npk`, etc.). Our inspect.json data uses the extra-packages build from CHR, but some packages (Wi-Fi drivers, zerotier) are missing from CHR. The HTML docs cover those.
- Current versions per channel: `https://upgrade.mikrotik.com/routeros/NEWESTa7.{stable,long-term,testing,development}`
