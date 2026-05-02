# Project Guidelines

## Overview

RouterOS documentation as SQLite FTS5 — an MCP server providing RAG search + command glossary over MikroTik's official docs. Built with **Bun** + **TypeScript**.

See [CLAUDE.md](../CLAUDE.md) for full architecture, schema, and source details.

## Project Documentation Convention

Each file has a single clear role — use these, don't create new top-level `.md` files:

| File / dir | What goes in it |
|------------|----------------|
| [CLAUDE.md](../CLAUDE.md) | Architecture, schema, conventions — what the project **is** and how it works |
| [DESIGN.md](../DESIGN.md) | Decisions, data sources, constraints, cross-references — **why** things are the way they are |
| [tasks/T-*.md](../tasks/) | **Active codebase work commitments** with frontmatter (status, deps, validation, acceptance). See `tasks/README.md` |
| [tasks/done/T-*.md](../tasks/done/) | Closed work, kept greppable for history |
| [briefings/B-*.md](../briefings/) | **Grounded research / decision notes.** May go nowhere. See `briefings/README.md` |
| [BACKLOG.md](../BACKLOG.md) | Lightweight inbox + watch list of triggered items + index of tasks/briefings |
| [VALIDATION.md](../VALIDATION.md) | **What's load-bearing and how it's proven.** Every CI-enforced invariant has a row |
| [CHANGELOG.md](../CHANGELOG.md) | User-visible changes per release — **what** shipped, in which version |
| [README.md](../README.md) | User-facing quick start — `/app` install, bunx setup, browse TUI, tool overview |
| [MANUAL.md](../MANUAL.md) | Extended reference — binary install, HTTP transport, CLI flags, data sources, troubleshooting, DB schema |

**Decision rule (where does this go?):**

- Codebase work I'm committing to → `tasks/T-*.md` with `status: ready` and a `validation:` row.
- Research or "should we do X?" thinking → `briefings/B-*.md`. May resolve to "no work needed."
- Loose thought, no shape yet → `BACKLOG.md` Inbox (one line).
- Waiting on a specific external event → `BACKLOG.md` Triggers (one line + condition).
- Decision or rationale (durable, project-wide) → `DESIGN.md`.
- How the project works → `CLAUDE.md`.
- Behaviour change that shipped → `CHANGELOG.md` `[Unreleased]`.
- Load-bearing invariant + how it's proven → `VALIDATION.md`.

**Avoid JIRA-style ticket sprawl.** A `T-*.md` file is a commitment. If you'd hesitate to predict anyone will pick it up, it's a briefing or an inbox bullet, not a task.

### Capture everything that isn't done

**This is a hard rule, not a suggestion.** If your work surfaces any of the following, you must record it in the appropriate place *before finishing your response* — do not leave it as a verbal aside:

- **Known breakage or degradation** — `tasks/T-*.md` if actionable now; `briefings/B-*.md` if needs investigation; `BACKLOG.md` Inbox if just a one-line heads-up.
- **Workarounds applied** — record both the workaround and the root cause. → `briefings/B-*.md` (root-cause discussion) plus a `tasks/T-*.md` if a real fix is committed.
- **Deferred or incomplete work** — if blocked on a specific external event, → `BACKLOG.md` Triggers with the trigger condition. If a decision is needed first, → `briefings/B-*.md`. Don't park it as a `T-*.md` if no one's picking it up.
- **Gotchas and footguns** — `DESIGN.md` if it's a project-level constraint; `briefings/B-*.md` if it's a risk worth thinking through.
- **Schema or architecture changes** — update `CLAUDE.md` to match.
- **Load-bearing invariants** — add or update a row in `VALIDATION.md` and reference its `V-*` ID from the relevant `T-*.md`.

**The test:** if you deleted the entire conversation history, would a new agent (or the maintainer) be able to discover this information from the project files alone? If not, you haven't captured it.

### Completion must include CI pickup verification

When marking a backlog item or implementation step as completed, explicitly verify and record how CI will pick it up:

- **Workflow coverage:** Identify the exact workflow/step that executes the changed behavior (for example, `.github/workflows/release.yml` extraction step, post-extraction DB guard/eval/stats gate, `.github/workflows/test.yml` quality gate).
- **Trigger path:** Confirm the change is exercised by normal CI triggers (`push`, `pull_request`, or `workflow_dispatch`) without requiring local-only commands.
- **No local build assumption:** Do not require the user to run `make`/build commands to validate completion unless they explicitly ask for a local verification run.
- **If CI will not pick it up:** treat as incomplete and either update CI in the same change or record a concrete deferred item — `BACKLOG.md` Triggers if it's waiting on something, `tasks/T-*.md` if it's committed work, or a row in `VALIDATION.md` if the gap is a missing invariant check.

## Build and Test

```sh
bun install              # Install dependencies
make extract             # HTML → properties → commands → devices → tests → changelogs → Dude cache → skills → link
make extract-full        # Same, but command data uses all 46 RouterOS versions
make serve               # Start MCP server (stdio transport)
make search query="DHCP" # CLI search
bun test                 # Run tests (query + schema + release readiness + HTTP transport)
make typecheck           # Type checking (no emit)
make lint                # Biome linter
make preflight           # All checks: clean tree, DB, typecheck, test, lint
make clean               # Remove DB files
```

Individual extraction steps: `make extract-html`, `make extract-properties`, `make extract-commands`, `make extract-schema`, `make extract-all-versions`, `make extract-devices`, `make extract-test-results`, `make extract-changelogs`, `make extract-videos-from-cache`, `make extract-dude-from-cache`, `make extract-skills`, `make link`, `make gc-versions`.

Release: prefer the GitHub Actions `Release` workflow for published artifacts. Use `republish_assets` only to reupload GitHub Release assets / OCI tags; it does not re-publish npm. Local compatibility path: `make release VERSION=v0.1.0` (new) or `make release VERSION=v0.1.0 FORCE=1` (update existing assets only). See `make build-release` for build-only (no git/upload).

## Architecture

| Component | File | Purpose |
|-----------|------|---------|
| MCP Server | `src/mcp.ts` | 14 tools plus MCP resources via stdio + Streamable HTTP transport using `@modelcontextprotocol/sdk` |
| Query Engine | `src/query.ts` | NL → FTS5 query planner, BM25 ranking, compound term recognition. Owns the DB-backed `isVerb` resolver wired into `classify.ts` |
| Classifier | `src/classify.ts` | Pre-search regex classifier (command path, version, topic, device, property, fragment). Pure — no DB. Accepts a `ClassifyOptions { isVerb? }` pass-through |
| Canonicalizer | `src/canonicalize.ts`, `src/canonicalize-resolver.ts` | RouterOS CLI path → `{ path, verb, args, confidence }`. Pure module + DB-backed adapter. Vendored for parity with `lsp-routeros-ts`; see DESIGN.md |
| Database | `src/db.ts` | Schema init, WAL mode, FTS5 triggers, singleton pattern |
| Extractors | `src/extract-*.ts` | HTML/JSON → SQLite (each drops and recreates its tables) |
| Linker | `src/link-commands.ts` | Command tree ↔ page matching (code paths + heuristics) |
| CLI Search | `src/search.ts` | Quick search from terminal |
| Tests | `src/query.test.ts`, `src/classify.test.ts`, `src/canonicalize.test.ts`, `src/canonicalize.fuzz.test.ts`, `src/release.test.ts` | Bun tests — query planner + DB integration + schema; classifier detectors; CLI path canonicalization (incl. fuzz/anchor tests for issue #5 hardenings); release readiness |

**Database:** `ros-help.db` (SQLite WAL mode). Main tables: `pages`, `sections`, `callouts`, `properties`, `commands`, `ros_versions`, `command_versions`, `devices`, `device_test_results`, `changelogs`, `videos`, `video_segments` with FTS5 indexes on pages, callouts, properties, devices, changelogs, videos, and video_segments.

**Data sources:**
- HTML export from Confluence in `box/latest/ROS/` (317 pages)
- `inspect.json` from [tikoci/restraml](https://github.com/tikoci/restraml) for the command tree (40K entries, 46 versions: 7.9–7.23beta2), fetched from `https://tikoci.github.io/restraml/` by default.
- Product matrix CSV in `matrix/` (144 products, 34 columns — hardware specs, license levels, pricing)
- Product test results + block diagrams from `https://mikrotik.com/product/<slug>` (125 devices with ethernet/IPSec benchmarks, 110 with block diagrams)
- Changelogs from `https://download.mikrotik.com/routeros/{version}/CHANGELOG` (parsed per-entry with category and breaking flag)
- YouTube transcripts from the official MikroTik YouTube channel via yt-dlp (518 videos, ~1,890 chapter-level segments; release CI imports committed NDJSON from `transcripts/`)
- Archived Dude wiki pages from cached Wayback HTML in `dude/pages/`
- Agent skills from `tikoci/routeros-skills` (CI fetches GitHub; cached `skills/` supports offline extraction)

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
- Stop words are hardcoded in `query.ts` (~50 words)
- Compound terms (~44 RouterOS pairs like firewall+filter) use FTS5 NEAR expressions
- Device/product name matching is heuristic and evolving, not a solved canonical mapping problem. Do not assume a false-empty lookup means device absence.
- When a new mismatch appears (rename/AKA/slug/model-number variant), capture it in `briefings/B-0006-device-aliases.md` with the user query, expected product, and source evidence. Once enough misses accumulate, the briefing graduates to a `tasks/T-*.md`.
- Product Naming (`ROS/pages/17498146`) is useful for future model-number decoding and alias generation, but real products include rule exceptions.

## Testing Requirements

**Hard rule: any behavioral change MUST have a corresponding test before shipping.** The HTTP transport was completely broken in a release because there were no transport-level tests — only manual curl checks that weren't captured as tests.

| Test file | What it covers |
|-----------|---------------|
| `src/query.test.ts` | Query planner (pure functions), DB integration (in-memory SQLite), schema health |
| `src/classify.test.ts` | Classifier detectors (command path, version, topic, device, property, fragment) — pure module, no DB |
| `src/canonicalize.test.ts` | CLI path canonicalization — path forms, subshells, blocks, navigation, `CanonicalizeOptions` resolver, `extractMentions` |
| `src/canonicalize.fuzz.test.ts` | Torture inputs (prose, markdown, malformed scripts) + anchor tests for issue #5 hardenings (H1–H8) |
| `src/release.test.ts` | File consistency, build constants, structural pattern checks, container setup |
| `src/mcp-http.test.ts` | HTTP transport: session lifecycle, multi-client, errors (live server) |
| `src/mcp-contract.test.ts` | MCP tool registry, workflow-arrow convention, token-budget guardrails, response-shape invariants |
| `src/schema-roundtrip.test.ts` | Schema importer round-trip: fixture merge, arch diffs, desc parsing, completion metadata |
| `src/extract-*.test.ts` | Extractor-specific parsing/cache behavior without touching the real DB |
| `src/gc-versions.test.ts` | `schema_node_presence` release-retention pruning behavior |

**When to add tests:**
- New query function or tool → `query.test.ts`
- New classifier detector or signal → `classify.test.ts`
- Canonicalizer change (parser, options, resolver, mentions, confidence) → `canonicalize.test.ts`; if it lands a hardening from issue #5 (H1–H8) also flip the matching `test.todo` in `canonicalize.fuzz.test.ts` to a real test
- Transport or protocol changes → `mcp-http.test.ts`
- Tool registry / token budget / response-shape change → `mcp-contract.test.ts`
- New CLI flag, build artifact, or file structure → `release.test.ts`
- Schema change → schema health section in `query.test.ts`

**Run `bun test` and `bun run lint` before any commit when feasible.** CI runs both, but catching failures locally is faster. Do not ask the user to run local `make` checks unless they explicitly want a manual local verification.

**Hard rule for agents:** `bun run lint` must exit with **zero errors** before any commit — this means the entire repo, not just touched files. CI has no "pre-existing" exception; any error anywhere fails the build. If lint reports errors in files you did not touch, fix them anyway (or, if a fix is non-trivial, open a `tasks/T-*.md` and link it from the PR). Lint **warnings** are acceptable and do not block commits.

## Version Accuracy

- Documentation covers **v7 only**, aligned with the long-term release (~7.22) at export time
- Docs are not versioned — they reflect the then-current long-term release, not a specific point release
- **Command data: 7.9–7.23beta2.** Below 7.9 there is no command tree data. Below 7.0 (v6) is a different world — syntax, routing/BGP, firewall, bridging all changed in v7
- For v6 questions, answers will be significantly less accurate — tool descriptions should flag this
- **Older than current long-term:** MikroTik does not patch versions older than the current long-term release. Recommend upgrading to at least long-term, both for security and to align with our data.
- Callouts sometimes document older-version differences, which is why we extract them
- **Extra-packages:** RouterOS has a base image (`routeros.npk`) plus extras (`container.npk`, `iot.npk`, etc.). Our inspect.json data uses the extra-packages build from CHR, but some packages (Wi-Fi drivers, zerotier) are missing from CHR. The HTML docs cover those.
- Current versions per channel: `https://upgrade.mikrotik.com/routeros/NEWESTa7.{stable,long-term,testing,development}`
