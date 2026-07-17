---
name: pr-review-gate
description: "Close the loop on a rosetta PR's bot review threads (CodeRabbit + Copilot) before claiming it's mergeable. Green status checks and a clean reviewDecision do NOT mean mergeable here — main requires all conversation threads resolved, and that's a separate gate. Use when a PR is Ready for Review and you're about to say it's done, when `gh pr merge` is blocked despite green checks, or when the user asks to address/close review comments."
argument-hint: "PR number (optional). If omitted, resolves the PR for the current branch."
---

# PR Review Gate

Rosetta's branch protection on `main` requires **all conversation threads resolved**,
enforced independently of status checks. CodeRabbit and Copilot both submit `COMMENTED`
reviews (never `CHANGES_REQUESTED`), so `reviewDecision` stays clean and checks show green
while the PR is still `mergeStateStatus: BLOCKED` by an open bot thread. Full rationale:
`.github/instructions/pr-review-bots.instructions.md` — this skill is the runnable
procedure; read that file for the "why."

## When to use

- A PR just went Ready for Review, or you pushed a fix commit, and you're about to tell the
  user the PR is done/mergeable.
- `gh pr merge` refuses despite green checks.
- The user asks to address, triage, or close out review comments.

## When NOT to use

- Draft PRs — bots don't review drafts.
- As a substitute for requesting a fresh bot pass. Re-review costs money (Copilot) or burns
  a rate-limited slot (CodeRabbit: 1-3/hour) — only request one (`@coderabbitai review` PR
  comment, or re-request the Copilot reviewer) for fixes big/ambiguous enough to warrant a
  second look. A one-line string fix doesn't need it; resolve the thread and move on.

## Procedure

1. **Resolve the PR and repo.**

   ```sh
   gh pr view --json number,url,headRefName  # or: gh pr view <N> if given
   gh repo view --json owner,name --jq '.owner.login + "/" + .name'
   ```

2. **Read the real gate, not `reviewDecision`.**

   ```sh
   gh pr view <N> --json mergeStateStatus,reviewDecision,statusCheckRollup
   ```

   `mergeStateStatus: BLOCKED` with green `statusCheckRollup` and clean `reviewDecision`
   means unresolved threads — proceed to step 3. `CLEAN` means you're done; skip to step 6.

3. **List unresolved threads (GraphQL — the flat comment list hides resolution state).**

   ```sh
   gh api graphql -f query='query{repository(owner:"OWNER",name:"REPO"){pullRequest(number:N){reviewThreads(first:100){nodes{id isResolved isOutdated path line}}}}}' \
     --jq '.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved==false)|"\(.id)\t\(.path):\(.line)"'
   ```

   Page with `after:` cursors if a PR has more than 100 threads. The unresolved count is
   often smaller than the raw comment count — GitHub auto-resolves some threads when the
   anchored lines move; don't reconcile against `pulls/N/comments`, only against this list.

4. **Get comment bodies for the unresolved threads.**

   ```sh
   gh api --paginate repos/OWNER/REPO/pulls/N/comments \
     --jq '.[] | "\(.user.login) \(.path):\(.line // .original_line)\n\(.body)\n"'
   ```

5. **For each unresolved thread: fix it, or dismiss it with a grounded reason.**
   - Fix: make the code change locally.
   - Dismiss: only when the finding is wrong or out of scope — say why.
   - Don't resolve a thread opened by a *human* reviewer on their behalf; you own bot
     threads (Copilot/CodeRabbit) once handled.
   - Replying does not resolve — resolving is a separate mutation:

   ```sh
   gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=THREAD_ID
   ```

   Reply with the fixing commit SHA before resolving, for an audit trail.

6. **After pushing fixes, re-check — don't assume the push resolved anything.**
   - A fix push does **not** auto-resolve the thread it fixes; it may flip to `isOutdated`,
     which looks handled in the UI but is not `isResolved`.
   - The push also triggers a fresh CodeRabbit pass (and possibly Copilot) that can open
     **new** threads. Wait for that re-review to settle, then repeat step 3.
   - Loop steps 3-6 until the unresolved list is empty.

7. **Confirm the gate is actually clear.**

   ```sh
   gh pr view <N> --json mergeStateStatus
   ```

   Only report the PR as mergeable when this reads `CLEAN` (or `UNSTABLE`/etc. for reasons
   unrelated to review threads — say which).

## Output format

```text
PR #104 — mergeStateStatus: BLOCKED -> resolving 3 unresolved threads

1. src/query.ts:42 (coderabbitai) — fixed in a1b2c3d, resolved
2. src/mcp.ts:88 (copilot-pull-request-reviewer) — fixed in a1b2c3d, resolved
3. README.md:12 (coderabbitai) — dismissed (stale suggestion, already matches docs), resolved

Re-review settled, no new threads. mergeStateStatus: CLEAN. Mergeable.
```

## What this skill does NOT do

- Merge the PR — that's a separate explicit action.
- Request a fresh bot review automatically — ask the user first; it costs money or burns a
  rate-limited slot (see "When NOT to use").
- Resolve a human reviewer's thread on their behalf.
