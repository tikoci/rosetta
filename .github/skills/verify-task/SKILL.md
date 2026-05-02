---
name: verify-task
description: "Verify a task is actually done by running the validation rows from its frontmatter. Maps V-* IDs to the CI step / test command via VALIDATION.md, runs them, reports pass/fail per row."
argument-hint: "Task ID (e.g. T-0009) or task file path. If omitted, lists in-progress tasks and asks."
---

# Verify Task

Closes the loop between a task's claimed acceptance and what's actually proven. Reads the task file's `validation:` list, looks up each `V-*` in `VALIDATION.md`, runs the proof, reports green/red.

## When to use

- About to mark a task `done` and want to confirm the validation rows are actually green.
- A PR is ready and you want to know which `V-*` invariants it touches.
- A user asks "is this task really finished?"

## When NOT to use

- For a task with `validation: []` (rare; only pure-doc tasks). There's nothing to verify.
- As a substitute for code review.

## Procedure

1. **Resolve the task.** If an ID was supplied, find the file. If not, list `tasks/T-*.md` files with `status: in-progress` and ask the user which.

2. **Read the task's `validation:` frontmatter list.** A list of `V-*` IDs.

3. **Look up each `V-*` in `VALIDATION.md`.** Pull the `Proven by` column. This describes the test file or CI step (e.g. `src/mcp-contract.test.ts Block A in test.yml`).

4. **Run the proof.**

   The cheapest way is `make verify` (T-0028) — runs typecheck, lint, unit tests, contract test, retrieval eval. If it passes, all V-* rows it covers are green.

   For more targeted checks, map common `V-*` IDs to commands:

   | V-* ID                 | Command |
   |------------------------|---------|
   | V-typecheck            | `bun run typecheck` |
   | V-lint                 | `bun run lint` |
   | V-unit                 | `bun test` |
   | V-tool-registry        | `bun test src/mcp-contract.test.ts` |
   | V-tool-shapes          | `bun test src/mcp-contract.test.ts` (Block C) |
   | V-tool-budget          | `bun test src/mcp-contract.test.ts` (Block B) |
   | V-retrieval-floor      | `bun run src/eval/retrieval.ts` |
   | V-retrieval-self       | `bun run src/eval/self-supervised.ts` |
   | V-canonicalize         | `bun test src/canonicalize.test.ts src/canonicalize.fuzz.test.ts` |
   | V-classifier           | `bun test src/classify.test.ts` |
   | V-schema-roundtrip     | `bun test src/schema-roundtrip.test.ts` |
   | V-extract-videos       | `bun test src/extract-videos.test.ts` |
   | V-http-handshake       | `bun test src/mcp-http.test.ts` |
   | V-stdio-handshake      | `bun test src/mcp-stdio-client.test.ts` (after T-0010) |
   | V-tui-mcp-parity       | `bun test src/browse-parity.test.ts` (after T-0011) |
   | V-cli-flag-uniformity  | `bun test src/cli-help.test.ts` (after T-0012) |
   | V-db-wipe-guard        | `bun test src/query.test.ts` |
   | V-release-structure    | `bun test src/release.test.ts` |

   For `V-bunx-*` and `V-db-min-content` rows, the proof lives in `release.yml` — these can't be cleanly run locally. Note that explicitly: "this V-* is verified by CI on the next release run."

5. **Report.** For each `V-*`:
   - ✓ pass — quote the relevant `Proven by` description so the user knows what just ran.
   - ✗ fail — surface the test output's failure summary.
   - ⊘ CI-only — explain that this row is verified on `workflow_dispatch` of release.yml; can't be checked locally.

6. **Conclusion.** If every row green or CI-only, recommend the user can mark the task `done` and proceed with merge. If any row failing, do not recommend `done` — point at the failing acceptance criterion.

## Output format

```text
Task: T-0009-windows-bunx-smoke
Validation rows: V-bunx-windows

V-bunx-windows: ⊘ CI-only
  Proven by: new windows-latest row in bunx-smoke matrix (release.yml)
  → Verified on next workflow_dispatch of release.yml after merge.

Conclusion: ready to mark done and merge. CI on the next release will exercise the new matrix entry.
```

## What this skill does NOT do

- Modify the task file's `status` — that's a manual edit when the user is satisfied.
- Move the file to `tasks/done/` — that's a `git mv` at merge time.
- Open or close PRs.
- Run `release.yml` — the user has to dispatch that themselves.
