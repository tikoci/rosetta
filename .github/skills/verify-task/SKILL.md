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

3. **Look up each `V-*` in `VALIDATION.md`.** Pull the `Proven by`, `Status`, and `Tracked by` columns. This tells you whether the invariant is already enforced, non-blocking, CI-only, or still a declared gap.

4. **Run the proof.**

   There is **not** a repo-wide `make verify` target yet — that is tracked by `T-0028`. Today, run the cheapest targeted proof for each non-GAP row. Once `T-0028` lands, prefer `make verify` for the rows it covers.

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
   | V-stdio-handshake      | `bun test src/mcp-stdio-client.test.ts` |
   | V-tui-mcp-parity       | `bun test src/browse-parity.test.ts` (after T-0011) |
   | V-cli-flag-uniformity  | `bun test src/cli-help.test.ts` (after T-0012) |
   | V-db-wipe-guard        | `bun test src/query.test.ts` |
   | V-release-structure    | `bun test src/release.test.ts` |

   For `V-bunx-*` and `V-db-min-content` rows, the proof lives in `release.yml` — these can't be cleanly run locally. Note that explicitly: "this V-* is verified by CI on the next release run."

   If a row is currently **`GAP`** in `VALIDATION.md`:
   - If the task under review is the one named in `Tracked by`, verify that the PR adds the missing proof and updates the row away from `GAP`.
   - Otherwise report the row as an unresolved gap and do **not** recommend marking the task `done`.

5. **Report.** For each `V-*`:
   - ✓ pass — quote the relevant `Proven by` description so the user knows what just ran.
   - ✗ fail — surface the test output's failure summary.
   - ⊘ CI-only — explain that this row is verified on `workflow_dispatch` of release.yml; can't be checked locally.
   - ⚠ GAP — explain that the invariant is not yet proven, quote `Tracked by`, and only consider it satisfied if the current task is the one closing that gap.

6. **Conclusion.** Recommend `done` only if every row is green or legitimately CI-only. If any row is failing or still GAP, do not recommend `done` — point at the missing proof or failing acceptance criterion.

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
