---
id: T-0022-script-example-demarcation
title: Preserve RouterOS code blocks in page text as fenced blocks
status: ready
priority: low
area: extraction
depends_on: []
conflicts_with: []
validation: []
acceptance:
  - "extract-html.ts emits page.text with code blocks fenced (```routeros) in context"
  - "Plain-text path preserved for consumers that don't want Markdown"
  - "Existing page.code field unchanged (separate flat code dump)"
trigger: ""
created: 2026-05-02
---

# Body

Today the extractor flattens RouterOS code blocks to a separate `page.code` field, losing their position in the surrounding prose. Preserve them as fenced `routeros` blocks in `page.text` so context is intact for the LLM, while keeping the plain-text path for consumers (TUI, FTS) that prefer the flat form.
