---
name: verify-task
description: "Verify a work item is actually done by running the V-* validation rows its acceptance criteria cite. Maps V-* IDs to the CI step / test command via VALIDATION.md, runs them, reports pass/fail per row."
argument-hint: "Issue number (e.g. #19), or T-0037 for the in-flight archived task. If omitted, lists open agent-ready issues and asks."
---

# Verify Task

Closes the loop between a work item's claimed acceptance and what's actually proven. Reads
the `V-*` rows cited in the issue's acceptance criteria, looks each up in `VALIDATION.md`,
runs the proof, reports green/red.

## When to use

- A PR is about to claim `Closes #N` and you want to confirm the cited validation rows are
  actually green.
- A user asks "is this issue really finished?"

## When NOT to use

- For an issue whose acceptance cites no `V-*` rows (pure-doc work). There's nothing to run.
- As a substitute for code review.

## Procedure

1. **Resolve the work item.** An issue number → `gh issue view <n>` and pull the `V-*` IDs
   from its acceptance section (also check any archived `tasks/done/T-*.md` file the issue
   names as its full spec). `T-0037` → read `tasks/T-0037-npm-prerelease-dist-tag-channel.md`
   frontmatter directly (the one still-in-flight file-based task).

2. **Look up each `V-*` in `VALIDATION.md`.** Pull the `Proven by`, `Status`, and
   `Tracked by` columns. This tells you whether the invariant is already enforced,
   non-blocking, CI-only, or still a declared gap.

3. **Run the proof.**

   Run `make verify` — it covers V-typecheck, V-lint, V-unit, V-tool-registry, V-tool-shapes, V-tool-budget, V-retrieval-floor in one command (requires a populated DB). For CI-only invariants (V-db-min-content, V-bunx-*) there is no local equivalent; those are only proven by a release run.

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
   | V-tui-mcp-parity       | `bun test src/browse-parity.test.ts` |
   | V-cli-flag-uniformity  | `bun test src/cli-help.test.ts` |
   | V-db-wipe-guard        | `bun test src/query.test.ts` |
   | V-release-structure    | `bun test src/release.test.ts` |

   For `V-bunx-*` and `V-db-min-content` rows, the proof lives in `release.yml` — these can't be cleanly run locally. Note that explicitly: "this V-* is verified by CI on the next release run."

   If a row is currently **`GAP`** in `VALIDATION.md`:
   - If the work item under review is the one named in `Tracked by`, verify that the PR adds the missing proof and updates the row away from `GAP`.
   - Otherwise report the row as an unresolved gap and do **not** recommend closing the issue.

4. **Report.** For each `V-*`:
   - ✓ pass — quote the relevant `Proven by` description so the user knows what just ran.
   - ✗ fail — surface the test output's failure summary.
   - ⊘ CI-only — explain that this row is verified on `workflow_dispatch` of release.yml; can't be checked locally.
   - ⚠ GAP — explain that the invariant is not yet proven, quote `Tracked by`, and only consider it satisfied if the current work item is the one closing that gap.

5. **Conclusion.** Recommend merging (and letting `Closes #N` fire) only if every row is
   green or legitimately CI-only. If any row is failing or still GAP, don't recommend it —
   point at the missing proof or failing acceptance criterion. If acceptance is only
   *partially* met, remind that follow-up issues must be opened before merge
   (`issue-pr-linking.instructions.md`).

## Output format

```text
Issue: #19 — extractor safe import pattern
Validation rows: V-db-wipe-guard

V-db-wipe-guard: ✓ pass
  Proven by: bun test src/query.test.ts (wipe-guard block)

Conclusion: rows green. PR may claim Closes #19 once acceptance bullets are all delivered.
```

## What this skill does NOT do

- Close issues or open/merge PRs.
- Run `release.yml` — the user has to dispatch that themselves.
