---
description: "When work uncovers breakage, workarounds, risks, or deferred items, record them in project files before finishing."
applyTo: "src/**, bin/**, scripts/**, .github/workflows/**, *.md"
---
# Capture undone work

Do not leave known breakage, workarounds, deferred follow-ups, or footguns as conversational asides.

- Actionable now → `tasks/T-*.md`
- Needs thinking first → `briefings/B-*.md`
- One-line heads-up or trigger → `BACKLOG.md`
- Durable constraint or gotcha → `DESIGN.md`
- New invariant or missing proof → `VALIDATION.md`

If conversation history vanished, a new agent should still be able to discover the issue from the repo files alone.
