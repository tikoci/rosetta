---
name: pick-next-task
description: "Pick the next ready task from tasks/. Filters status: ready with no unresolved depends_on, sorts by priority, surfaces conflicts_with hints. Use when starting fresh work or asking 'what should I do next?'"
argument-hint: "Optional: --area <ci|qa|mcp|tui|extraction|release|install|docs> to filter"
---

# Pick Next Task

The agent's `what now?` verb. Reads the file-based queue under `tasks/`, returns the next ready task with full body so you can start work without re-reading every other file.

## When to use

- Starting a new work session and asking "what's the next thing?"
- Picking up rosetta after a break
- Filtering by area ("show me a ready CI task")

## What "ready" means

A task file in `tasks/` is pickable when:

1. `status: ready` (not `in-progress`, `blocked`, or `done`).
2. Every `depends_on` entry is either empty (`[]`) or refers to a task file in `tasks/done/`.
3. No `conflicts_with` entry is currently `status: in-progress` in `tasks/` — surface as a warning, but don't auto-block; the user may have context.

## Procedure

1. **List candidate files.**
   ```sh
   ls tasks/T-*.md
   ```

2. **Parse frontmatter for each.** Pull `id`, `title`, `status`, `priority`, `area`, `depends_on`, `conflicts_with`. The frontmatter shape is documented in `tasks/README.md`.

3. **Filter:**
   - Drop anything where `status` is not `ready`.
   - Drop anything whose `depends_on` contains a task ID **not** present in `tasks/done/`.
   - If the `--area` argument was supplied, drop anything whose `area` doesn't match.

4. **Sort:**
   - Primary key: `priority` — `high` before `medium` before `low`.
   - Tie-break: lowest numeric `id` (older tasks surface first).

5. **Surface the top item.**
   - Read the full file body (`Read` tool).
   - Present to the user: ID, title, area, priority, acceptance criteria, validation rows, and the body's notes/sketch.

6. **Conflict warnings.** If the picked task's `conflicts_with` list contains any task currently `status: in-progress` in `tasks/`, mention it. The user decides whether to proceed.

7. **What if nothing matches?**
   - Empty queue → tell the user, suggest checking `BACKLOG.md` Inbox for un-promoted ideas or `briefings/` for open research that might spawn work.
   - All ready tasks blocked by `depends_on` chains → surface the chain so the user can pick the upstream task instead.

## Output format

Don't drown the user. Return:

```text
Next: T-0009-windows-bunx-smoke (high priority, area: ci)
Title: Add windows-latest to bunx-smoke matrix
Validation: V-bunx-windows
Conflicts with: T-0018 (not in-progress, OK to start)

Acceptance:
  - bunx-smoke job in .github/workflows/release.yml includes windows-latest
  - ...

[Body text follows]
```

## What this skill does NOT do

- Mark the task `in-progress` — that's a manual edit when the user actually starts.
- Move things to `done/` — that happens at PR merge.
- Create new tasks — that's `promote-idea`.
- Run validation checks — that's `verify-task`.
