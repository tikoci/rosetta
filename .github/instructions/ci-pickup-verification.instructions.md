---
description: "When closing work, verify which CI workflow and step pick it up. Do not rely on local-only validation paths."
applyTo: "tasks/**, VALIDATION.md, .github/workflows/**, README.md, MANUAL.md, CHANGELOG.md, src/**"
---
# CI pickup verification

Before calling work complete, identify how CI exercises it:

- Name the exact workflow and step that covers the changed behavior.
- Confirm the behavior runs on normal triggers (`push`, `pull_request`, or `workflow_dispatch`) rather than requiring a local-only command.
- If CI does not cover it yet, update CI in the same change or leave the task open and record the gap in `tasks/`, `BACKLOG.md`, or `VALIDATION.md`.

Do not close a task on the assumption that maintainers will run ad hoc local commands later.
