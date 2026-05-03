---
description: "Markdown code blocks must be fenced and language-tagged; use routeros for RouterOS CLI and text for plain output."
applyTo: "*.md, .markdownlint.yaml, .markdownlintignore"
---
# Markdown fenced code

Use fenced code blocks with explicit language tags.

- `routeros` for RouterOS CLI or scripts
- `text` for plain output or pseudo-URLs
- `sh`, `json`, `sql`, etc. for real language-specific examples

This keeps markdown machine-readable and aligned with the repo's markdownlint rules.
