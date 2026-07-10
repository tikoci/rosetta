---
name: pick-next-task
description: "Pick the next actionable work item from GitHub Issues. Filters open issues labeled agent-ready (spec settled, not blocked), surfaces umbrella/blocked context. Use when starting fresh work or asking 'what should I do next?'"
argument-hint: "Optional: a label or keyword to filter (e.g. extraction, mcp)"
---

# Pick Next Task

The agent's `what now?` verb. Reads the GitHub Issues queue and returns the next pickable
issue with enough context to start work. (Named for the retired `tasks/` file queue — the
verb survives, the backend is now issues; see `tasks/README.md`.)

## When to use

- Starting a new work session and asking "what's the next thing?"
- Picking up rosetta after a break

## What "pickable" means

An issue is pickable when:

1. It is open and labeled `agent-ready` — acceptance criteria are settled.
2. It is **not** labeled `blocked` and its body names no unresolved "blocked on" issue.
3. It is **not** labeled `umbrella` — umbrellas track themes; work happens in child issues.

## Procedure

1. **List candidates.**

   ```sh
   gh issue list --state open --label agent-ready --json number,title,labels,updatedAt
   ```

   If a filter argument was supplied, match it against titles and labels.

2. **If none are agent-ready**, widen with
   `gh issue list --state open --json number,title,labels,body` (the `body` field is what
   holds "blocked on" references and umbrella checklists) and report what exists instead:
   discussion-stage issues (unlabeled — could be settled into readiness), `blocked` issues
   (say what each waits on), and `umbrella` issues (their child checklists show what could
   be spawned next). Also point at `BACKLOG.md` Inbox and open `briefings/`.

3. **Surface the top pick.** `gh issue view <n> --comments`, then present: number, title,
   acceptance criteria, `V-*` validation rows, and linked briefings or archived
   `tasks/done/T-*.md` files — some issues keep their full spec in the archived task file
   (e.g. #26 → `T-0038`), so read those too.

4. **Remind the close discipline.** The eventual PR must say `Closes #<n>` in its body;
   partial landings spawn follow-up issues before merge (`issue-pr-linking.instructions.md`).

## What this skill does NOT do

- Assign the issue or open PRs — that happens when work actually starts.
- Create new issues — that's `promote-idea`.
- Run validation checks — that's `verify-task`.
