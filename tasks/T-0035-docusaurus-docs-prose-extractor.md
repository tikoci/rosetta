---
id: T-0035-docusaurus-docs-prose-extractor
title: Docusaurus /docs prose extractor (main docs only — CLI Reference and /hardware deferred)
status: ready
priority: high
area: extraction
depends_on:
  - T-0034-rosetta-id-scheme-spike
conflicts_with: []
validation:
  - V-db-min-content
acceptance:
  - "New extractor (extract-docusaurus.ts or similar) discovers /docs pages via sitemap.xml/llms.txt and populates pages/sections/properties/callouts for /docs prose only — CLI Reference (/docs/cli-reference/*) and /hardware are explicitly out of scope for this task"
  - "Uses the rosetta-id scheme validated by T-0034 (not re-litigated here)"
  - "Property parsing follows B-0012 H4: Markdown emphasis extraction (not a ported HTML regex), tolerant of the malformed bold/italic collision pattern found in dhcp.md"
  - "Admonitions (:::tip/:::info/:::warning, and the ::::-nested form) map into callouts"
  - "Relative Markdown links in descriptions resolve to rosetta-ids or live manual.mikrotik.com URLs, not left as broken relative paths"
  - "extract-html.ts's role for /docs prose is fully replaced; extract-html.ts itself is either retired or scoped down to only what still needs it (confirm against DESIGN.md before deciding which)"
  - "New V-docusaurus-docs-count row added to VALIDATION.md per B-0012 H8 (exact count match: sitemap /docs subset <-> llms.txt <-> extracted pages), starts non-blocking, promoted to blocking once a full extraction run is green"
  - "MANUAL.md and CHANGELOG.md updated per normal extractor-change conventions"
trigger: "T-0034-rosetta-id-scheme-spike reaches status: done"
created: 2026-07-07
---

# Body

Second of two staged tasks following the 2026-07-07 T-0033 homework pass (see
`briefings/B-0012-docusaurus-manual-migration.md`, "Next steps" section, and "Proposed migration
task files" item #1). This is the real, committed `/docs`-only prose extractor — not a spike.

Deliberately narrow scope, and why: of everything surveyed in B-0012 (H1-H8), `/docs` prose is
the one piece that's both well-understood (H1 site internals, H4 property-table shape) and
self-contained. CLI Reference needs a JSX-aware `ArgTable` parser plus an overlay-merge design
against `schema_nodes`/restraml (H3), and the identity side of that overlay isn't fully safe
until restraml responds to the proposed contract in
[tikoci/restraml#85](https://github.com/tikoci/restraml/issues/85). `/hardware` still has an
open choice between an HTML parser and the `search-doc.json` text fallback (H2/H6) that hasn't
been made. Pulling either into this task would reintroduce exactly the kind of premature,
likely-to-be-refactored work this staging is trying to avoid. CLI Reference, `/hardware`, and the
MCP/TUI source-typed-results rework stay as *proposed, not yet created* tasks (items #2, #3, #6
in B-0012's "Proposed migration task files") — write them for real once this task lands and
restraml has responded.

Do not start this task until `T-0034` is `done` and its H7 decision is recorded in B-0012 — the
identity scheme this extractor mints IDs with is not this task's decision to make.

## 2026-07-07 — unblocked

`T-0034` reached `done` the same day: H7 confirmed Option 2 (separate `rosetta_id TEXT UNIQUE`
column), validated end-to-end against 20 real `/docs` pages via
`src/spike-docusaurus-docs-prototype.ts`. Read that task's progress note and B-0012's H7 section
before starting — notably the `.md`/`.mdx`-suffix-stripping fix in `deriveRosettaId()`
(`src/spike-docusaurus-rosetta-id.ts`), which the real extractor must carry forward or every
internal doc-to-doc link will mint a duplicate id for its target page.
