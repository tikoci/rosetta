# tasks/

Active and ready work items for rosetta. One Markdown file per task. Files are the queue.

This directory replaces the prior single-file `BACKLOG.md` workflow. `BACKLOG.md` is now a lightweight inbox + index; once an idea has enough shape to be picked up, it is *promoted* to a task file here.

## Why files-with-frontmatter, not GitHub Issues

- Agents can read the queue with no auth.
- Tasks diff in PRs alongside the code that closes them.
- Conflicts surface as normal merge conflicts in `tasks/T-NNNN-*.md`.
- GitHub Issues stay useful for **external** reports; task files are the **internal** working set.

## What goes here vs elsewhere

A `T-*.md` file means **real work is committed to the codebase** — there is acceptance criteria and a validation row that flips green when it lands. Aspirational, "maybe someday," or "we should think about this" items are **not** tasks:

- Loose ideas with no shape → `BACKLOG.md` Inbox (one-line bullet).
- Waiting on an external event with no firm date → `BACKLOG.md` Triggers (one-line bullet with the trigger condition).
- Research, design notes, or decision support → `briefings/B-*.md` (see `briefings/README.md`). A briefing might inform a future task, or it might go nowhere. That's fine — briefings are not tracked as work.

The point is to **avoid JIRA-style ticket sprawl**. A task file is a commitment. If you find yourself writing one without confidence anyone will pick it up, it's a briefing or an inbox bullet instead.

## Lifecycle

```text
ready  ──pick──▶  in-progress  ──merge──▶  done   →  moved to tasks/done/
                                  │
                                  └─ if blocked on external event:
                                       status: blocked + trigger: "..."
```

Four statuses, no more: `ready | in-progress | blocked | done`.

- **ready** — an agent or maintainer can sit down and start now. All `depends_on` are `done`. Acceptance criteria are clear.
- **in-progress** — actively being worked. Set when a PR opens.
- **blocked** — paused waiting on a specific external event named in `trigger:`. Use sparingly; if the wait is indeterminate ("someday"), it's an inbox bullet, not a task.
- **done** — merged. File moves to `tasks/done/` (not deleted) so we can grep history and reopen if a regression surfaces.

Status moves are file edits — there is no separate state store.

## Frontmatter spec

Every task file starts with YAML frontmatter. All fields are required unless marked optional.

```yaml
---
id: T-0042-tui-flag-parsing       # stable ID. T-NNNN-<slug>. Never reused, never renumbered.
title: Pass-through flag parsing for TUI commands
status: ready                      # ready | in-progress | blocked | done
priority: medium                   # high | medium | low
area: tui                          # tui | mcp | extraction | ci | release | docs | qa | install
depends_on: []                     # list of task IDs that must reach `done` first
conflicts_with: []                 # list of task IDs that touch the same code/surface; pick one at a time
validation:                        # VALIDATION.md row IDs that must pass when the task is `done`
  - V-tui-mcp-parity
  - V-cli-flag-uniformity
acceptance:                        # short bulleted contract — "done means this"
  - "TUI accepts --limit, --version, --breaking on non-dot commands"
  - "browse.test.ts covers each new flag"
  - "MANUAL.md CLI table updated"
trigger: ""                        # optional. for status: blocked. external event that unblocks the task.
created: 2026-05-02
---

# Body (free-form)

Rationale, sketch of approach, links to code paths, prior discussion. Anything that helps an agent (or future-you) pick up the task without re-reading every related file.

If a task accumulates a lot of design discussion, distill the decision into `DESIGN.md` and link from here — keep this body actionable.
```

### Field rules

- **id** — `T-NNNN-<slug>`. Pad to 4 digits. Pick the next free integer. Never renumber, never reuse. The ID is the stable handle in `depends_on`/`conflicts_with`/PR titles.
- **status** — exactly one of the four values. `ready` means "an agent can sit down and start now"; `blocked` is for tasks paused on a specific named trigger.
- **priority** — `high` for core value or release-risk; `medium` for meaningful improvement with no blocker; `low` for nice-to-have or waiting on a trigger. Used as the tiebreaker after `status: ready`.
- **area** — coarse bucket. Used for filtering ("show me ready `qa` tasks"). Add new values sparingly.
- **depends_on** / **conflicts_with** — lists of task IDs. Empty list `[]` is fine and common. `depends_on` blocks pickup until all listed tasks are `done`. `conflicts_with` is a *don't pick both at once* hint — same Makefile region, same MCP tool, same DB table.
- **validation** — list of `V-*` IDs from `VALIDATION.md`. Closing the task means those rows pass on the same commit. Empty list is allowed for pure-doc tasks but should be rare.
- **acceptance** — 2–6 bullets. The contract for "done." Should be specific enough that an agent can self-check before opening a PR.
- **trigger** — optional. Only meaningful for `status: blocked`. One sentence describing the external event.
- **created** — ISO date. Set once, never updated.

## Picking the next task

Manually:

```sh
# All ready tasks, highest priority first
ls tasks/T-*.md | xargs grep -l '^status: ready$' \
  | xargs grep -l '^depends_on: \[\]$'
```

Or use the `pick-next-task` skill (Phase D) which filters `status: ready` with no unresolved `depends_on`, sorts by priority, and prints the file body.

## Adding a new task

Three paths in increasing weight:

1. **Inbox**: drop a one-line bullet under `BACKLOG.md` → "Inbox." Use when you don't know if it will go anywhere.
2. **Briefing**: write `briefings/B-NNNN-<slug>.md`. Use when you need to think out loud, ground claims with code/links, or record a decision. Briefings can sit indefinitely.
3. **Task**: write `tasks/T-NNNN-<slug>.md` with full frontmatter and `status: ready`. Use only when the work is committed — acceptance is clear and someone (or some agent) is actually going to pick it up.

A briefing does not "promote" to a task. A briefing might be **cited** by a future task as background, but the task is the work commitment; the briefing is the supporting note.

## Closing a task

1. Implement.
2. Run the checks that prove the rows listed in `validation:`. Use `VALIDATION.md` (or the `verify-task` skill) to map each `V-*` row to its current proof. If a row is CI-only, say so explicitly. If a row is still `GAP`, the task is not done until the PR adds the proof and flips the row.
3. After `T-0028` lands, prefer `make verify` for the rows it covers.
4. PR title: `<Title> (T-NNNN)`.
5. On merge: change `status: done`, then `git mv tasks/T-NNNN-*.md tasks/done/`.

## What does **not** belong here

- Decisions and rationale (long-form, durable) → `DESIGN.md`.
- Architecture and how the project works → `CLAUDE.md`.
- Shipped, user-visible behaviour → `CHANGELOG.md`.
- Loose ideas with no shape yet → `BACKLOG.md` Inbox (one line).
- Indeterminate "wait for X" items → `BACKLOG.md` Triggers (one line + condition).
- Research, hypotheses, design notes, decision support → `briefings/B-*.md`.
- External bug reports from users → GitHub Issues.
