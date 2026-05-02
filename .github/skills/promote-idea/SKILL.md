---
name: promote-idea
description: "Promote an Inbox bullet from BACKLOG.md to either a task (tasks/T-NNNN-*.md) or a briefing (briefings/B-NNNN-*.md). Asks which based on whether the work is committed or still needs thinking. Removes the original bullet."
argument-hint: "Optional: a substring matching the bullet to promote. If omitted, lists Inbox bullets and asks."
---

# Promote Idea

Move a one-line Inbox bullet from `BACKLOG.md` to a real, structured location: a task file (codebase work commitment) or a briefing (research/decision support).

## When to use

- An Inbox bullet has gained enough shape to either commit to or think through systematically.
- After a discussion that resolves what an idea actually means.

## When NOT to use

- The bullet is still vague — leave it in Inbox until it has shape.
- The bullet is one-shot ("merge this dependabot PR") — just do it; don't promote.
- It's a wait-on-trigger item — move it to the BACKLOG.md Triggers section instead.

## Procedure

1. **List Inbox bullets** if no argument supplied. Read `BACKLOG.md`, find the `## Inbox` section, present the bullets to the user numbered.

2. **Pick the bullet.** Either match the substring argument, or ask the user which number.

3. **Decide: task or briefing?** Ask the user explicitly:
   - **task** — "I'm committing to do codebase work. There's clear acceptance criteria. Someone (or some agent) will pick this up."
   - **briefing** — "I want to think this through, ground claims with code/data, possibly arrive at a decision. The conclusion might be 'no work needed' and that's fine."
   - **delete** — "This doesn't survive a re-read. Remove it."
   - **trigger** — "This is waiting on a specific external event." → move to Triggers table instead.

4. **If task:**
   - Find the next free `T-NNNN` ID. Look at `tasks/T-*.md` and `tasks/done/T-*.md`, take `max(id) + 1`, pad to 4 digits.
   - Generate kebab-case slug from the bullet's gist.
   - Ask the user for required frontmatter:
     - `priority` (high/medium/low)
     - `area` (ci/qa/mcp/tui/extraction/release/install/docs)
     - `depends_on` (default `[]`; ask if other tasks must finish first)
     - `conflicts_with` (default `[]`; ask if any task touches the same surface)
     - `validation` (V-* IDs from `VALIDATION.md`; default `[]` only for pure-doc tasks)
     - `acceptance` (2–6 bullets)
   - Write `tasks/T-NNNN-<slug>.md` using the format in `tasks/README.md`.

5. **If briefing:**
   - Find the next free `B-NNNN` ID across `briefings/B-*.md`. Independent numbering from tasks.
   - Generate kebab-case slug from the topic.
   - Ask for `topic` (one-line) and an opening question for the body.
   - Write `briefings/B-NNNN-<slug>.md` with `status: open`, `last_revisited` = today.

6. **Remove the bullet** from `BACKLOG.md` Inbox.

7. **Update the index.** Add the new task or briefing to the appropriate index section in `BACKLOG.md`.

8. **Add a CHANGELOG entry** only if the promoted item is itself a user-visible change. Most promotions don't ship — they're internal queue management. Skip the entry by default.

## Output format

Confirm to the user:

```text
Promoted "<bullet>" → tasks/T-0030-<slug>.md (status: ready)
Removed from BACKLOG.md Inbox.
Added to BACKLOG.md task index under area: <area>.

Run: pick-next-task to confirm it surfaces.
```

## What this skill does NOT do

- Pick or work on the task — that's `pick-next-task` and human/agent effort.
- Promote a Triggers row — Triggers stay until their condition fires; then they get promoted to a task by the same flow.
- Create tasks from scratch — write the file directly if you already know what you're doing.
