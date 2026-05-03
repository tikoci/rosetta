# rosetta

RouterOS documentation as SQLite FTS5 — one core data model exposed through three surfaces: an MCP server for agents, a browse TUI for humans, and a command-tree/glossary layer for downstream RouterOS tooling. This file is intentionally a thin routing index. Detailed rationale lives in `DESIGN.md`; install and operator reference live in `MANUAL.md`; narrow coding rules live in `.github/instructions/*.instructions.md`.

## Project Documentation

Each file has one job. Prefer the canonical home instead of inventing a new top-level `.md`.

| File / dir | Canonical role |
|------------|----------------|
| `CLAUDE.md` | Project orientation + routing index for agents |
| `DESIGN.md` | Durable rationale, data-source provenance, architecture tradeoffs |
| `MANUAL.md` | Install, operations, release/re-extraction steps, schema reference |
| `README.md` | User-facing quick start |
| `CHANGELOG.md` | User-visible shipped changes under `[Unreleased]` / releases |
| `VALIDATION.md` | Load-bearing invariants and how CI proves them |
| `BACKLOG.md` | Lightweight inbox, triggers, and task/briefing indexes |
| `tasks/T-*.md` | Active committed work items |
| `tasks/done/T-*.md` | Closed work kept for grep-able history |
| `briefings/B-*.md` | Research notes and decision support |
| `.github/copilot-instructions.md` | Short Copilot-specific routing note |
| `.github/instructions/*.instructions.md` | Narrow normative rules matched by `applyTo` |

## Where does this go?

The canonical routing rule lives in `.github/instructions/where-does-this-go.instructions.md`. Short version:

- **Committed codebase work** → `tasks/T-*.md`
- **Grounded research / decision support** → `briefings/B-*.md`
- **Loose thought with no shape yet** → `BACKLOG.md` Inbox
- **Waiting on a named external event** → `BACKLOG.md` Triggers
- **Durable project rationale** → `DESIGN.md`
- **Operator or release procedure** → `MANUAL.md`
- **User-visible shipped behavior** → `CHANGELOG.md`
- **Load-bearing invariant + proof** → `VALIDATION.md`

Avoid JIRA-style ticket sprawl: a task file is a real commitment, not a maybe.

## Instruction Routing

Start with `.github/copilot-instructions.md`, then read the narrow files that match the surface you are touching.

| Area | Read these files |
|------|------------------|
| Cross-cutting rules | `changelog-discipline.instructions.md`, `where-does-this-go.instructions.md`, `instruction-scopes.instructions.md`, `descriptive-prose-file-names.instructions.md` |
| Bun / runtime conventions | `bun-not-node.instructions.md`, `database.instructions.md` when touching `src/db.ts` |
| MCP, query, classifier, browse, canonicalizer | `mcp-server.instructions.md` plus `query-core-not-adapter.instructions.md`, `tui-mcp-parity.instructions.md`, `mcp-tool-descriptions.instructions.md`, `tool-surface-change.instructions.md`, `canonicalize-vendored.instructions.md` |
| Extraction and data-shape work | `extraction.instructions.md` plus `extractor-idempotent.instructions.md`, `extractor-import-side-effects.instructions.md`, `command-versions-vs-presence.instructions.md`, `schema-roundtrip-compat.instructions.md`, `data-source-naming-product-matrix.instructions.md`, `skill-attribution-boundary.instructions.md` |
| Release / install / provenance | `release-via-ci.instructions.md`, `republish-assets-not-npm.instructions.md`, `db-meta-stamping.instructions.md` |
| Markdown / doc-authoring rules | `markdownlint-fenced-code.instructions.md`, `llm-instruction-files-excluded-from-mdlint.instructions.md` |
| Task / briefing workflow | `tasks-vs-briefings.instructions.md`, `tasks/README.md`, `briefings/README.md` |

## Fast pointers

- Need **why** something works this way? Read `DESIGN.md`.
- Need **how to run, release, or rebuild** it? Read `MANUAL.md`.
- Need **current corpus counts**? Use `routeros_stats` rather than hard-coded numbers here.
- Need **task status or open ideas**? Use `tasks/`, `briefings/`, and `BACKLOG.md`.

Nothing else should be duplicated here. If this file starts growing operational detail, schema blocks, or long rule lists again, move that content back into its canonical home instead.
