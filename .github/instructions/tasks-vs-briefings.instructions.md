---
description: "Pointer for the work-tracking split: GitHub issues are commitments, briefings are research, backlog is the loose/thinking-first layer, tasks/ is a frozen archive."
applyTo: "tasks/**, briefings/**, BACKLOG.md, VALIDATION.md, CLAUDE.md"
---
# Issues vs briefings (tasks/ is archived)

The canonical detailed rules live in `tasks/README.md` (archive note + issue-queue summary) and `briefings/README.md`.

- **GitHub Issues** are the work commitments — discussion first, `agent-ready` label once the spec is settled. Acceptance criteria still cite `V-*` rows from `VALIDATION.md`.
- `briefings/B-*.md` are research or decision-support notes that may conclude with "do nothing" or "opened issue #N."
- `BACKLOG.md` is the loose-thought / trigger layer, not a substitute tracker.
- `tasks/T-*.md` is a **frozen archive** (migration: issue #18). Never create new task files; `tasks/done/` files stay for grep-able history. Sole in-flight exception: `T-0037`.

If you need the fine print, read the directory README that owns the file you are editing.
