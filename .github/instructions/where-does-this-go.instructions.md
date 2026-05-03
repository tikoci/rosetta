---
description: "Canonical routing rule for where information belongs: task, briefing, backlog, DESIGN, MANUAL, CHANGELOG, VALIDATION, or CLAUDE."
applyTo: "*.md, .github/instructions/**"
---
# Where does this go?

Use one canonical home for each kind of information:

- **Committed codebase work** → `tasks/T-*.md`
- **Grounded research or decision support** → `briefings/B-*.md`
- **Loose thought with no shape yet** → `BACKLOG.md` Inbox
- **Waiting on a specific external event** → `BACKLOG.md` Triggers
- **Durable rationale or architecture tradeoff** → `DESIGN.md`
- **Operator, install, release, or re-extraction procedure** → `MANUAL.md`
- **Project orientation and routing map** → `CLAUDE.md`
- **User-visible shipped behavior** → `CHANGELOG.md`
- **Load-bearing invariant and proof** → `VALIDATION.md`

Other files should point at the canonical home, not restate it.
