---
description: "LLM-targeted instruction files are excluded from markdownlint so authoring rules for human docs do not distort agent-facing guidance."
applyTo: ".markdownlint.yaml, .markdownlintignore, CLAUDE.md, .github/copilot-instructions.md, .github/instructions/**"
---
# Exclude LLM instruction files from markdownlint

Agent-facing instruction files are a different audience than README-style docs.

- Keep them excluded via `.markdownlintignore`.
- The exclusion set includes `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md`, and `.github/instructions/**`.
- Put human-facing markdown style enforcement in the lint config, not in these files.
