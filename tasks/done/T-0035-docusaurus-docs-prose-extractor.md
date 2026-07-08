---
id: T-0035-docusaurus-docs-prose-extractor
title: Docusaurus /docs prose extractor (main docs only — CLI Reference and /hardware deferred)
status: done
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

## 2026-07-07 — implemented and closed (all seven acceptance bullets)

Real, committed code — not a spike:

- `src/rosetta-id.ts` — the spike's `deriveRosettaId`/`checkCollisions`/`parseSitemapLocs`
  promoted to production (spike files deleted); `src/rosetta-id.test.ts` replaces
  `spike-docusaurus-rosetta-id.test.ts` with the same coverage plus a `rosettaIdToUrl` round-trip
  test.
- `src/extract-docusaurus.ts` — discovers `/docs` pages via `sitemap.xml`, scoped to exclude
  `/docs/cli-reference/*` and `/docs/tags*` (including the bare `/docs/tags` root, a real live
  404 caught during smoke-testing, not just `/docs/tags/*`); fetches raw Markdown
  (`{url}.md` for leaf pages, `{url}index.md` for category/index pages whose sitemap URL ends in
  `/` — also a real live 404 caught during smoke-testing, not assumed); parses property tables
  (`Property` or `Parameter` header, both seen live), admonitions into callouts, h1–h3 sections
  (skipping the real duplicated-title-H1 quirk in the raw `.md` source), and resolves relative
  Markdown links inside property descriptions to live `manual.mikrotik.com` URLs with the anchor
  fragment preserved. A real parsing bug was caught by the fixture tests, not invented for
  coverage: RouterOS example scripts use `#` for comments (e.g. `# Drop ARP frames...`), which a
  naive line-by-line heading regex misdetects as a Markdown heading — fixed with a fenced-code-block
  tracker (`makeFenceTracker`) that suppresses heading/section-context detection inside ``` fences.
- `src/db.ts` — `pages.rosetta_id TEXT` migration (unique-when-not-null index), `SCHEMA_VERSION`
  bumped 5→6 (`src/paths.ts`).
- `fixtures/docusaurus/*.md` — four real pages (dhcp.md, sms.md, dot1x.md, address-lists.md)
  committed as test fixtures, chosen to hit: the known malformed-emphasis case, the "Parameter"
  header spelling (not just "Property"), real live `::::`-width admonitions, a property-free page,
  and the RouterOS-comment-vs-heading collision.
- `src/extract-docusaurus.test.ts` — unit tests against those fixtures (property parsing incl.
  malformed-emphasis flagging, admonition parsing, section splitting incl. the duplicate-title and
  code-fence-comment edge cases, link resolution, `isInScopeDocsUrl` scoping, `markdownUrlFor`
  category-page handling, `parseLlmsTxtInScopeCount`). `src/release.test.ts` gained Makefile-target
  assertions for the new wiring. All durable, fixture-anchored checks per the "trend toward
  catching something, even if fragile" brief — not live-network tests.
- **Live end-to-end smoke-verified, not just unit-tested:** a full unthrottled run
  (`DB_PATH=/tmp/... bun run src/extract-docusaurus.ts --check-counts --strict`) against the real
  live site extracted exactly 360/360 pages with **zero fetch errors** and an exact
  `llms.txt`-scoped count match (`MATCH`, exit 0) — 2,903 sections, 4,501 properties (132
  malformed-emphasis, generalizing well beyond the T-0034 prototype's 20-page sample), 938
  callouts. `--from-cache` reproduced identical counts from the cached run. `PRAGMA
  foreign_key_check` on the resulting DB reported zero violations. This is what caught both real
  bugs above (the category-index `index.md` 404 and the bare `/docs/tags` 404) — they only showed
  up at full scale, not in the 4-fixture unit-test sample.
- `Makefile` — `extract-docusaurus`/`extract-docusaurus-from-cache`/`extract-docusaurus-check-counts`
  added; `extract`/`extract-full` now run `extract-docusaurus` instead of
  `extract-html`+`extract-properties`; those two survive as `extract-legacy-confluence`, per
  DESIGN.md's "still useful for rebuilding historical release DBs" framing — kept, not retired.
  `release.yml` was deliberately **not** touched — B-0012's "Next steps" section records that no
  new release ships until the Docusaurus migration is solid, so flipping the actual release
  pipeline stays a separate, later decision, not bundled into this task.
- `VALIDATION.md` — `V-docusaurus-parse-shape` (blocking; the fixture-based parsing tests) and
  `V-docusaurus-docs-count` (non-blocking; B-0012 H8's cross-check, `--check-counts` proved green
  at full scale above, but isn't wired into any CI workflow yet since `release.yml` wasn't
  touched — the acceptance bullet's "promoted to blocking once green" is about CI enforcement,
  which doesn't exist yet, not about whether the check itself passes).
- `MANUAL.md`, `DESIGN.md`, `CHANGELOG.md` updated per normal extractor-change conventions.

All seven acceptance bullets satisfied. `manual/` (the live-fetch page cache) is gitignored, not
committed — only the four curated `fixtures/docusaurus/*.md` are. Status: `done`.
