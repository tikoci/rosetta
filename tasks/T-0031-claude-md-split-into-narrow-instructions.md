---
id: T-0031-claude-md-split-into-narrow-instructions
title: Split CLAUDE.md into many narrow .github/instructions/*.md files
status: ready
priority: medium
area: docs
depends_on: []
conflicts_with: []
validation: []
acceptance:
  - "CLAUDE.md is < 200 lines and is mostly a routing index + cross-cutting rules"
  - "Each new instruction file covers one topic and has a descriptive prose filename (style: ~/Lab/centrs/.github/instructions/)"
  - "Schema SQL block, file manifest, and Current State counts are removed from CLAUDE.md (canonical sources: MANUAL.md, DESIGN.md, or routeros_stats)"
  - "Source Details (HTML archive, inspect.json, product matrix, skills provenance) moved to DESIGN.md"
  - "Distribution / CLI flags / HTTP transport sections deduped against MANUAL.md and README.md"
  - "Each cross-cutting rule formerly in CLAUDE.md (changelog discipline, decision rule, tool-surface ritual, TUI-MCP parity, etc.) lives in exactly one normative file; other locations are pointers"
  - "No content lost — every fact is reachable from the new structure (verified by grep against the pre-split CLAUDE.md backup)"
  - "Existing instruction files (database / extraction / mcp-server) are preserved or refactored into narrower files in the same pass"
  - "VALIDATION.md, BACKLOG.md, tasks/, briefings/ references to CLAUDE.md sections still resolve (search for 'CLAUDE.md#' anchors and update)"
trigger: ""
created: 2026-05-02
---

# Body

## Why

CLAUDE.md is ~693 lines. Most of it is reference material (schema SQL, file
manifest, data source details, distribution mechanics, current row counts) that
belongs in `MANUAL.md` / `DESIGN.md` / live tools — not in an instruction file
that sits at the top of every Claude conversation. Symptoms:

- Hard to spot duplication or conflict between sections.
- Copilot ignores most of it because Copilot only reliably loads
  `.github/copilot-instructions.md` + `.github/instructions/*.md` (with
  `applyTo` matching). Claude reads CLAUDE.md as a whole; Copilot effectively
  doesn't. The two assistants end up with **different views of the project**,
  which is the opposite of what `tikoci-crossref` and the other shared
  conventions exist to prevent.
- The file's size is itself a signal that it's mixing roles: instructions,
  spec, reference, status, history.

The fix is to lean into the model already used in `~/Lab/centrs` and
`~/Lab/winrun`: many narrow, single-topic `*.instructions.md` files with
descriptive prose filenames. CLAUDE.md becomes a thin routing index plus the
handful of cross-cutting rules that must always bind.

## Style anchors

- Filenames are sentences-as-slugs: `changelog-discipline.instructions.md`,
  `tool-surface-change.instructions.md`, `tui-mcp-parity.instructions.md` —
  not `mcp.md` or `tools.md`. The filename should let a human (or an LLM
  scanning a directory listing) infer the rule without opening the file.
- One rule per file. If a file grows two unrelated rules, split it.
- `applyTo:` may be broad when the rule legitimately applies broadly
  (e.g. `bun-not-node` covers `src/**` + `test/**` + `package.json`). Don't
  contort scoping just to look narrow — the *file* is narrow, that's the
  point.
- Lead each file with a one-line `description:` (used by Copilot's
  description-based instruction selection) and `applyTo:` glob list.

Reference: `~/Lab/centrs/.github/instructions/` — 20 files, each one rule,
filenames like `actionable-errors`, `git-hooks`, `instruction-scopes`,
`scratch-directory`, `descriptive-prose-file-names`.

## Proposed instruction files (initial cut — refine during execution)

This is a starting list, not a contract. Drop, merge, or split as the rewrite
makes the actual rules surface.

**Cross-cutting (apply broadly):**

- `changelog-discipline.instructions.md` — every user-visible change adds a
  bullet under `[Unreleased]`. Pure refactors / test churn excluded. Section
  taxonomy (`Added` / `Changed` / `Fixed` / …) lives here.
- `where-does-this-go.instructions.md` — the decision rule (task vs briefing
  vs backlog vs DESIGN.md vs CLAUDE.md vs CHANGELOG.md vs VALIDATION.md).
  Currently the most useful chunk of CLAUDE.md.
- `bun-not-node.instructions.md` — Bun, `bun:sqlite`, `Bun.serve`, `Bun.$`,
  no Node std lib equivalents. (Mirrors centrs `use-bun`.)
- `instruction-scopes.instructions.md` — meta: how to write a new
  `*.instructions.md` (narrowest applicable `applyTo`, one canonical source,
  pointers elsewhere). Mirrors centrs.
- `descriptive-prose-file-names.instructions.md` — naming convention for
  this directory + `tasks/` + `briefings/`. Mirrors centrs.

**MCP / query / TUI:**

- `tool-surface-change.instructions.md` — registry frozen in two places
  (`src/mcp.ts` + `EXPECTED_TOOLS` in `mcp-contract.test.ts`); add/remove/
  rename touches both + `[Unreleased]`. Description-only edits don't.
- `tui-mcp-parity.instructions.md` — every MCP tool has a TUI dot-command;
  TUI is a superset, never a subset.
- `query-core-not-adapter.instructions.md` — heuristics belong in
  `src/query.ts` so MCP and TUI inherit them. PRs that grow MCP-only or
  TUI-only logic are a smell.
- `mcp-tool-descriptions.instructions.md` — workflow arrows (`→ next tool`),
  empty-result hints, the `relatedCaps(limit)` "hunger knob" pattern.
- `canonicalize-vendored.instructions.md` — pure module +
  DB-backed `isVerb` resolver split; vendoring contract with
  `lsp-routeros-ts`. (Currently inside `mcp-server.instructions.md` —
  promote to its own file.)

**Extraction / data:**

- `extractor-idempotent.instructions.md` — drop+recreate, never mutate in
  place. (Refactor from existing `extraction.instructions.md`.)
- `extractor-import-side-effects.instructions.md` — see T-0017; rule
  belongs here once that task lands.
- `command-versions-vs-presence.instructions.md` — `command_versions` keeps
  full history; `schema_node_presence` pruned to active channel heads.
- `schema-roundtrip-compat.instructions.md` — `extract-schema.ts` regenerates
  `commands` + `command_versions` for legacy callers.
- `data-source-naming-product-matrix.instructions.md` — product names vary
  across matrix CSV / product code / URL slug / docs; FTS + slug fallbacks
  are intentional, alias coverage is iterative.
- `skill-attribution-boundary.instructions.md` — community-created, not
  official MikroTik docs; provenance header on every `rosetta://skills/{name}`
  response.

**Release / CI:**

- `release-via-ci.instructions.md` — releases happen via the `Release`
  workflow_dispatch only. `make release` is gone (T-0013).
- `republish-assets-not-npm.instructions.md` — `republish_assets` reuploads
  GitHub Release assets + OCI tags; npm versions are immutable, bump
  `package.json` for a new npm publish.
- `db-meta-stamping.instructions.md` — provenance keys stamped by
  `scripts/stamp-db-meta.ts` in CI; read by `mcp.ts` banner + bunx
  freshness check.

**Markdown / docs:**

- `markdownlint-fenced-code.instructions.md` — language tag required;
  `routeros` for RouterOS CLI, `text` for plain output.
- `llm-instruction-files-excluded-from-mdlint.instructions.md` — CLAUDE.md /
  AGENTS.md / `.github/instructions/**` are excluded via
  `.markdownlintignore`. Different audience, different rules.

**Tasks / briefings / validation:**

- `tasks-vs-briefings.instructions.md` — task is a commitment with a
  validation row; briefing is grounded research that may go nowhere.
  (Currently in `tasks/README.md` + `briefings/README.md`. Decide whether
  the directory READMEs stay normative and this file is a thin pointer, or
  vice versa. Default: directory READMEs stay, this file is a pointer
  loaded broadly so any work that touches `tasks/` or `briefings/` sees it.)

## What leaves CLAUDE.md (relocations, not deletions)

| Currently in CLAUDE.md | Goes to |
| --- | --- |
| Schema SQL block (~200 lines) | `MANUAL.md` "DB schema" section (expand) |
| `## Files` (file-by-file manifest) | Delete. Filenames are self-describing; `ls src/` is authoritative |
| `## Current State` (row counts, page counts) | `DESIGN.md` (or delete; `routeros_stats` is the live source) |
| `## Source Details` (HTML, inspect.json, matrix, skills) | `DESIGN.md` |
| `## Distribution` / `## Tester Workflow` / `## CLI Flags` / `## HTTP Transport` | Already largely in `MANUAL.md` + `README.md` — dedupe |
| `## CI Release Workflow` | Split: ops detail → `MANUAL.md`; rules → `release-via-ci.instructions.md` |
| `## Re-extraction` | `MANUAL.md` ops section + `extractor-idempotent.instructions.md` for the rule |
| `## Related Projects` | `DESIGN.md` (already has a similar section — merge) |

## What stays in CLAUDE.md

After the split, CLAUDE.md should be roughly:

1. One-paragraph project orientation (what rosetta is — three surfaces,
   one core).
2. The Project Documentation table (file-role index — the routing map).
3. The decision rule ("where does this go?") — or a one-line pointer to
   `where-does-this-go.instructions.md` if we move it.
4. A pointer list: "These instruction files always apply — read them when
   editing X" mapped to globs.
5. Nothing else.

Target: < 200 lines.

## Plan

1. **Snapshot.** `cp CLAUDE.md CLAUDE.md.bak` (gitignored or just a temp
   file) — used at the end to grep for "did anything get lost?"
2. **Land DESIGN.md / MANUAL.md additions first.** Move schema, source
   details, related projects. Verify cross-references still work.
3. **Refactor existing three instruction files.** `database`, `extraction`,
   `mcp-server` are too broad by the new standard. Split into narrower
   files (e.g. `mcp-server` → `tool-surface-change` +
   `mcp-tool-descriptions` + `query-core-not-adapter` +
   `canonicalize-vendored`).
4. **Write new instruction files** from the proposed list, one rule each.
5. **Rewrite CLAUDE.md** to the < 200-line shape above.
6. **Sweep references.** `grep -r 'CLAUDE.md#' .` and update anchors.
   Update `tasks/README.md` if it points into CLAUDE.md sections.
7. **Verify.** `diff` the bak file's grep-able terms against the new tree
   to catch dropped facts. Run `make verify`. Run `bun test` for any
   instruction files referenced from tests (the contract test reads
   `EXPECTED_TOOLS` literals, not CLAUDE.md, so that's safe).
8. **Changelog.** One bullet under `[Unreleased]` → `Changed`:
   "Split CLAUDE.md into narrow `.github/instructions/*.md` files; canonical
   docs moved to MANUAL.md / DESIGN.md."

## Notes

- Single PR is fine — interleaving relocations and pointer rewrites in
  separate PRs would create a window where CLAUDE.md and the new files both
  claim to be normative for the same rule. Land it in one go.
- This is a docs-only change; no code, no tests change. CI should be green
  modulo `make verify`'s lint pass.
- After this lands, future "should this be in CLAUDE.md?" arguments have a
  clear answer: probably not — it's either a scoped instruction, a MANUAL
  ops detail, or a DESIGN rationale.
