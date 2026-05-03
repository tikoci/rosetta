---
description: "Use descriptive prose filenames for instruction files, tasks, and briefings so the purpose is obvious from a directory listing."
applyTo: ".github/instructions/**, tasks/**, briefings/**"
---
# Descriptive prose filenames

Filename slugs should explain the rule or work item without opening the file.

- Good: `tool-surface-change.instructions.md`, `release-via-ci.instructions.md`
- Bad: `mcp.md`, `docs.md`, `misc.instructions.md`

Prefer sentence-like slugs that describe the topic, especially in `.github/instructions/`, `tasks/`, and `briefings/`.
