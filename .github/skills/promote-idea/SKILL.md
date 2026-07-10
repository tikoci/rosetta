---
name: promote-idea
description: "Promote an Inbox bullet from BACKLOG.md to either a GitHub issue (work commitment) or a briefing (briefings/B-NNNN-*.md, research/decision support). Asks which based on whether the work is committed or still needs thinking. Removes the original bullet."
argument-hint: "Optional: a substring matching the bullet to promote. If omitted, lists Inbox bullets and asks."
---

# Promote Idea

Move a one-line Inbox bullet from `BACKLOG.md` to a real, structured location: a GitHub
issue (codebase work) or a briefing (research/decision support).

## When to use

- An Inbox bullet has gained enough shape to either commit to or think through systematically.
- After a discussion that resolves what an idea actually means.

## When NOT to use

- The bullet is still vague — leave it in Inbox until it has shape.
- The bullet is one-shot ("merge this dependabot PR") — just do it; don't promote.
- It's a wait-on-trigger item — move it to the BACKLOG.md Triggers section instead.

## Procedure

1. **List Inbox bullets** if no argument supplied. Read `BACKLOG.md`, find the `## Inbox`
   section, present the bullets numbered.

2. **Pick the bullet.** Match the substring argument, or ask the user which number.

3. **Decide: issue or briefing?** Ask the user explicitly:
   - **issue** — "This is codebase work we intend to do." Discussion can continue on the
     issue; it only gets the `agent-ready` label once acceptance criteria are settled.
   - **briefing** — "I want to think this through, ground claims with code/data, possibly
     arrive at a decision. The conclusion might be 'no work needed' and that's fine."
   - **delete** — "This doesn't survive a re-read. Remove it."
   - **trigger** — "This is waiting on a specific external event." → move to the Triggers
     table instead.

4. **If issue:** create it with `gh issue create`, using the work-item template's sections
   (context/grounding, acceptance sketch, `V-*` validation rows from `VALIDATION.md`,
   related briefings/issues). Only add the `agent-ready` label if the spec is genuinely
   settled — the default is an unlabeled discussion issue. If it belongs to an `umbrella`
   theme, mention the umbrella in the body and add it to the umbrella's child checklist.

5. **If briefing:** find the next free `B-NNNN` ID across `briefings/B-*.md`, generate a
   kebab-case slug, ask for `topic` (one line) and an opening question for the body, and
   write `briefings/B-NNNN-<slug>.md` with `status: open`, `last_revisited` = today. Add it
   to the Briefings index in `BACKLOG.md`.

6. **Remove the bullet** from `BACKLOG.md` Inbox.

## Output format

Confirm to the user:

```text
Promoted "<bullet>" → issue #34 (discussion; not yet agent-ready)
Removed from BACKLOG.md Inbox.
```

## What this skill does NOT do

- Pick or work on the issue — that's `pick-next-task` and human/agent effort.
- Promote a Triggers row — Triggers stay until their condition fires; then the same flow
  opens an issue.
- Create `tasks/T-*.md` files — that queue is a frozen archive (see `tasks/README.md`).
