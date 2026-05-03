---
description: "Meta-rule for writing .github/instructions files: one topic per file, smallest honest scope, and pointers instead of duplicated prose."
applyTo: ".github/copilot-instructions.md, .github/instructions/**, CLAUDE.md"
---
# Instruction scopes

When adding or editing instruction files:

- Put one rule or one tightly related topic in each file.
- Use the smallest honest `applyTo` scope; broad scopes are fine when the rule is genuinely broad.
- Keep one normative home per rule. Other instruction files should point to it instead of copying the prose.
- Prefer adding a new narrow file over inflating a generic router file.
