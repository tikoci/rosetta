---
description: "Canonical routing rule for where information belongs: GitHub issue, briefing, backlog, DESIGN, MANUAL, CHANGELOG, VALIDATION, or CLAUDE."
applyTo: "*.md, .github/instructions/**"
---
# Where does this go?

Use one canonical home for each kind of information:

- **Committed codebase work** → a GitHub issue. Issues start as discussion; add the `agent-ready` label only once acceptance criteria are settled. `umbrella` = theme tracking issue, `blocked` = waiting on a named event. PRs close issues via `Closes #N` (see `issue-pr-linking.instructions.md`). `tasks/` is a frozen archive — never add new `T-*.md` files.
- **Grounded research or decision support** → `briefings/B-*.md`
- **Loose thought with no shape yet** → `BACKLOG.md` Inbox
- **Waiting on a specific external event** → `BACKLOG.md` Triggers
- **Durable rationale or architecture tradeoff** → `DESIGN.md`
- **Operator, install, release, or re-extraction procedure** → `MANUAL.md`
- **Project orientation and routing map** → `CLAUDE.md`
- **User-visible shipped behavior** → `CHANGELOG.md`
- **Load-bearing invariant and proof** → `VALIDATION.md`
- **Agent-specific entrypoint shim** → `AGENTS.md` or `.github/copilot-instructions.md`, pointing back to `CLAUDE.md`

Other files should point at the canonical home, not restate it.
