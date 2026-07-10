# briefings/

Grounded research notes, design memos, and decision support docs for rosetta.

A briefing is **not** a work item. It might inform a future task. It might land at "do nothing." Both outcomes are valid — recording the thinking is the point.

## When to write a briefing

- You want to think out loud about a tradeoff before deciding.
- You're checking whether current behaviour is right (a "double-check" review of an existing surface).
- You hit a research-shaped question whose answer is "do an experiment, see what happens."
- You're about to make a non-obvious decision and want the reasoning recorded so future-you (or a future agent) doesn't have to redo it.

If the conclusion of a briefing is "yes, do this codebase work," **then** open a GitHub issue and cite the briefing from it. The briefing stays as the rationale. (Before 2026-07-10 this meant creating a `tasks/T-*.md`; that queue is now a frozen archive — see `tasks/README.md`.)

## When **not** to write a briefing

- You already know the work needed → open a GitHub issue directly.
- The thought is half-formed, no grounding yet → `BACKLOG.md` Inbox (one line).
- The decision rationale is durable, project-wide, and load-bearing → it belongs in `DESIGN.md`. A briefing might *become* a `DESIGN.md` section if it stabilises.

## Frontmatter spec

Lighter than tasks. Two states only.

```yaml
---
id: B-0007-tool-surface-review
topic: Audit current 14-tool MCP surface for consolidation candidates
status: open                       # open | resolved
related_tasks: []                  # task IDs this briefing informs (filled in if/when work spawns)
created: 2026-05-02
last_revisited: 2026-05-02         # bump when you re-read or update; helps surface stale thinking
---

# Body

Free-form. Sections that tend to be useful:

- **Question** — what we're trying to figure out.
- **What's grounding this** — links to code, data, prior briefings, external sources. A briefing without grounding is a blog post.
- **Options considered** — the alternatives, with tradeoffs.
- **Current lean** — best guess as of `last_revisited`. May change.
- **Decision (if resolved)** — the call. What was chosen. What was rejected and why.
- **Open questions** — explicit list of what we still don't know.
```

### Field rules

- **id** — `B-NNNN-<slug>`. Pad to 4 digits. Independent numbering from `T-*` tasks.
- **topic** — one-line description, useful for the BACKLOG.md index.
- **status** — `open` (still thinking, or watching for triggers) or `resolved` (decision recorded; no further work expected unless something changes). A briefing that turns into one or more issues stays `resolved` once the decision is made; the issues track the work.
- **related_tasks** — historical `T-*` IDs and/or issue numbers (`#N`) this briefing informs, populated as work spawns from (or cites) the briefing.
- **created** / **last_revisited** — both ISO dates. `last_revisited` is the freshness signal.

## Lifecycle

```text
B-NNNN-*.md  status: open
       │  decision made or research concluded
       ▼
status: resolved
       │  (optional) spawns GitHub issue(s), issues cite this briefing
       ▼
stays in briefings/ forever as the rationale record
```

There is no `briefings/done/`. Resolved briefings stay in place — they're the durable rationale layer between code and decisions.

## What does **not** belong here

- Codebase work commitments → GitHub Issues (`tasks/` is a frozen archive).
- One-line ideas → `BACKLOG.md` Inbox.
- Project-wide architectural rationale → `DESIGN.md`.
- Status updates on in-progress tasks → those go in PR descriptions or task body edits.
