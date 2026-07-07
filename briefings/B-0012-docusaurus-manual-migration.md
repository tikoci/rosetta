---
id: B-0012-docusaurus-manual-migration
topic: Docusaurus manual migration after Confluence retirement
status: open
related_tasks:
  - T-0033-docusaurus-premigration-grounding
created: 2026-05-29
last_revisited: 2026-07-07
---

# Question

How should rosetta evolve now that MikroTik's public RouterOS help system has moved from the old Confluence site/export to the Docusaurus manual at <https://manual.mikrotik.com>?

## What's grounding this

- Future official docs are expected on <https://manual.mikrotik.com>, not as Confluence HTML exports.
- Current rosetta prose extraction depends on Confluence-specific structure: page IDs, breadcrumb metadata, `confluenceTable`, callout macros, and `syntaxhighlighter-pre` code blocks.
- The new site exposes a normal sitemap at <https://manual.mikrotik.com/sitemap.xml>.
- The new CLI Reference at <https://manual.mikrotik.com/docs/cli-reference/> exposes command menus, flags, argument names, and argument types from `/console/inspect`-derived data.
- restraml already publishes versioned `inspect.json` / `deep-inspect.json` from live CHR `/console/inspect`; rosetta stores those in `commands`, `command_versions`, `schema_nodes`, and `schema_node_presence`.
- **The dependency with restraml is circular, not one-way.** rosetta consumes restraml `deep-inspect.{x86,arm64}.json`; restraml's `enrich-openapi.ts` in turn reads rosetta's `ros-help.db` (property descriptions, `commands.page_id` link strategies) to enrich its OpenAPI output. Verified 2026-07-07 in `~/GitHub/restraml` (`enrich-openapi.ts`, `rosetta-consumer.test.ts`, `CLAUDE.md` "Downstream consumer contract"). Any change to rosetta page identity or the `commands`/`pages` shape is therefore also a restraml-facing contract change.
- MCP and TUI surfaces currently present a Confluence-page-shaped world: page search, page IDs, sections, property lookup, and command links back to legacy docs.

## Machine-readable exposure — status

### Original 2026-05-29 findings (now superseded)

When first tested against the CLI Reference on 2026-05-29, the deployed site exposed **no** raw Markdown: `.md`/`.mdx`/`/index.md`/`?raw=1` and `Accept: text/markdown` all returned rendered HTML, `/__docusaurus/debug/*` was 404, there was no `llms.txt`, and the only plaintext source was the local search plugin's `search-doc.json`. The conclusion then was that the site was Docusaurus-native internally but published nothing curl-friendly.

### Verified 2026-06-02 — MikroTik has shipped the machine-readable layer

Re-tested 2026-06-02; the site changed materially within days. The "Using this documentation" page now documents these explicitly ("The whole manual is published in plain formats so it can be read by retrieval pipelines, assistants, and other automated tools, not only in a browser."):

- **Per-page raw Markdown works.** `…/getting-started/using-this-documentation.md` → `200`, raw Markdown body. `…/docs/cli-reference/ip/address.md` → `200`, raw **MDX** (includes `import {ArgTable} from '@site/src/components/common'`). Both are served as `Content-Type: application/octet-stream` rather than `text/markdown`, but the bytes are real Markdown/MDX.
- **`llms.txt` and `llms-full.txt` are live.** `llms.txt` is a page index ("An index of every page, with a short description and a link for each"); `llms-full.txt` is the whole manual concatenated for bulk ingestion.
- **`sitemap.xml`** lists 1,100+ URLs (1,322 as of 2026-07-07). CLI Reference URLs are lowercase `cli-reference` (e.g. `…/docs/cli-reference/ip/address`), **not** the earlier `CLI%20Reference` form.
- **Search** is a lunr-based local Docusaurus plugin (publishes `search-doc.json` with the `searchDocs`/`pageTitle`/`tagName`/`version` schema of `@easyops-cn/docusaurus-search-local`). Porter stemming is on by default. The index carries a `version` field, currently `"current"` or `null`.
- **CLI Reference is auto-generated** from RouterOS itself ("generated automatically from the RouterOS system itself … menus, commands, and argument types are extracted from the software"), encoded as JSX `<ArgTable>`/`<ArgTableRow>` component props in the MDX. ~~Enum values, package associations, and version provenance are not in the published source.~~ *Enum-values part superseded 2026-07-07 — see below.*

### Verified 2026-07-06 — site search internals and steering economics

Deeper research into the site's search system (forum thread
[#270916](https://forum.mikrotik.com/t/steering-ai-to-use-new-manual-mikrotik-com/270916),
post #20: three coding agents were each prompted to build a standalone CLI search
tool against the site) plus live measurements:

- **There is no server-side search API.** Search is a client-side lunr index
  published as `search-doc-{hash}.json` + `lunr-index-{hash}.json`. The hash is
  only discoverable by scraping it out of the HTML/JS chunks or brute-probing
  epoch-millisecond timestamps — all three agents needed fallback cascades, and
  one initially failed on a regex detail (unquoted `src` attributes). This
  confirms the earlier call: `search-doc.json` is a completeness check, **never**
  a primary ETL input, and "use the site's own search" is not a stable agent
  workflow. The stable agent workflow is `llms.txt` → per-page `.md`.
- **The site's tokenizer splits on slashes** (`lunr.tokenizer.separator =
  /[\s/]+/`), so `ip/dhcp-server/lease` is treated as three tokens. That is the
  only customization confirmed so far — the agents were asked specifically about
  the slash case and did **not** unwind all of MikroTik's minified lunr/Docusaurus
  code, so other custom behavior may exist (homework H2).
- **Steering cost per query is high.** Measured 2026-07-06: `llms.txt` is
  112 KB (~28K tokens) — fetching it as "step 1 of every question" costs about
  what the 166-tool mikrotik-mcp always-on surface costs, the very thing
  `bench-routeros-tools` flagged. rosetta's whole surface is ~6.3K always-on
  tokens and one call typically answers (89% hit@5, 100% path reconstruction in
  the bench).

### Verified 2026-07-07 — site surface inventory beyond `/docs`

The site is four surfaces, and **only `/docs` is in the machine-readable layer**:

| Section | Size (sitemap) | `.md`? | In `llms.txt`? | Notes |
|---------|---------------:|:------:|:--------------:|-------|
| `/docs/**` | ~1,000 URLs | ✅ | ✅ (596 entries) | Prose manual + `cli-reference` + `/docs/hardware/*` generic hardware topics (grounding, disks, LCD) + `/docs/tags/*` |
| `/hardware/<model>` | 240 URLs | ❌ 404 | ❌ | Per-device pages (quick-guide style: Safety Warnings, Connecting, Powering, Mounting, ports, buttons; ~5 HTML tables incl. Product code). Links out to `mikrotik.com/product/<slug>`. Overlaps rosetta's `devices` domain |
| `/changelog` | 32 URLs | ❌ 404 | ❌ | Docusaurus **blog instance** of dated "Doc Changes" posts (`changelog-YYYY-MM-DD`). **`/changelog/rss.xml` and `atom.xml` exist** — a stable watch input |
| `/blog` | 9 URLs | ❌ 404 | ❌ | Newsletter posts (`news130`…), often linking to PDF newsletters. `/blog/rss.xml` exists. No deeper PDF parsing needed |

Consequences:

- "Prefer per-page `.md`" applies to `/docs` only. `/hardware` device pages need
  a (small, well-structured) HTML parser after all — but they map to rosetta's
  existing `devices`/product-matrix domain, not to `pages` prose.
- The doc-changes feed solves two needs at once: **(a)** since docs are
  `"current"`-only, capturing `/changelog` deltas between extractions preserves a
  forward-only history (same posture rosetta took with help.mikrotik.com) even if
  it never surfaces in MCP; **(b)** long-term, CI can poll `changelog/rss.xml`
  and open an issue/PR when the manual changed — the automation input is already
  stable. Agents working on this project should treat `/changelog` as the "what
  moved upstream" pointer.
- CLI Reference `.md` is **richer than the 2026-06-02 finding recorded**:
  `/docs/cli-reference/lcd.md` shows inline **enum values**
  (`enum (dark | light)`, `enum (min | hour | daily | weekly)`), **ranges**
  (`time [30s .. 2h]`), **composite/alt types**
  (`alt { enum (never) { never:0 }, time [30s .. 2h] }`), and per-directory
  header metadata: `Conditions: !smips` (arch condition) and `Syscap: lcd`
  (system-capability gate). Package association and version provenance are still
  absent. `Conditions`/`Syscap` are data a CHR-based `/console/inspect` may
  never see (CHR has no LCD; smips builds aren't inspected), so the CLI
  Reference is not merely a lossy re-rendering of inspect — it carries facts
  restraml cannot produce. Full coverage survey is homework H3.

### What this means for rosetta extraction

The Option D plan stands, but the input layer is much better than assumed:

1. **Prefer per-page `.md`/`.mdx`** discovered via `sitemap.xml` (or `llms.txt`) over parsing rendered HTML — that was the hoped-for "future official raw Markdown endpoint" and it now exists (for `/docs`; see the surface inventory for the rest).
2. **CLI Reference `.md` still needs a JSX-aware parser** (`ArgTable`/`ArgTableRow` props). It now has enum values/ranges/alt types and `Conditions`/`Syscap`, but still lacks package and version provenance — so restraml `deep-inspect.json` remains rosetta's versioned command authority; treat manual CLI Reference as an official *current-manual* companion/overlay (Option C/D split unchanged, overlay design in Option D note).
3. **`search-doc.json`** is a structural completeness check, not a primary source (it has already lost table/code structure).
4. `llms-full.txt` is a cheap whole-corpus diff/completeness signal between extractions.
5. **Cross-check counts must be enforced, not just observed.** Extraction should compare like-for-like sets (sitemap `/docs` subset ↔ `llms.txt` entries ↔ extracted pages ↔ `search-doc.json` docs) and **fail ETL/CI** on mismatch — new `V-*` rows in `VALIDATION.md`, not log lines. Note the sets differ by construction (`llms.txt` = `/docs` only, 596 entries; sitemap = 1,322 incl. `/hardware`, `/blog`, `/changelog`, `/docs/tags/*`), so "100% match" only holds after scoping each comparison.

### Working assumption on upstream asks

Assume **none** of the still-open asks below ship near-term. Build the Docusaurus plumbing now; if MikroTik later ships structured CLI data, versioned docs, or a manifest, the plumbing makes adoption easier — do not wait for it.

### What the migration is *for* (reframe)

Because the vendor now gives the prose away in machine form, rosetta's
differentiation is no longer "has the docs" — it is **structure + versions +
linking**: the command-version matrix, device/chip/spec pivots, weighted
callouts, changelogs, and the one-call `related` block. The prose import remains
worth doing for offline//app deployment, one-call token efficiency, and as the
substrate those links hang off — but it should be built as a *companion* to the
live site, not a mirror competing with it. Concretely: **every extracted page and
CLI-reference row must carry its live `manual.mikrotik.com/….md` URL** so any
result can be escalated to (or verified against) the current official page. That
makes rosetta the best *steering engine* rather than a steering competitor. Full
positioning argument: B-0013.

### Still-open asks to MikroTik (not yet shipped)

Most of the original publishing recommendations have landed. What remains (assume none land near-term — see working assumption above):

- **Structured CLI Reference data** (JSON/YAML per path) instead of JSX-wrapped MDX, including package associations and per-version provenance. (Raised in forum #270714 post #70 "Dear @mrz".) *Enum values shipped 2026-07 in the MDX itself.*
- **Versioned docs** beyond a single `"current"` tag. (Forum #270714 posts #58/#68.)
- **Stable, package-agnostic, path-derivable URLs** with well-known `#flags`/`#attributes` anchors. (Forum #270714 posts #58/#70.)
- **A manifest** (`docId`, `permalink`, `sourcePath`, `version`, `sha256`, `frontMatter`) would still help, but is lower priority now that `.md` + `sitemap.xml` + `llms.txt` cover discovery.
- **Machine-readable `/hardware`** (`.md` or structured data for the 240 device pages) and `llms.txt` coverage for the non-`/docs` sections.

## Search-quality and structured-pivot feedback (rosetta → MikroTik)

Separate from extraction, rosetta's FTS work surfaces feedback worth giving MikroTik about *their* search, posted to forum #270714:

- **Porter stemming mangles product/command codes.** The lunr default stems English prose, but `CCR2216-1G-12XS-2XQ`, `RB4011iGS+RM`, `88F3720`, `wifi-qcom` are identifiers. rosetta uses `unicode61` **without** Porter for the device index plus a LIKE substring fallback and an exact→LIKE→prefix→OR cascade (`DESIGN.md` "FTS5 for text"). A no-stem field + substring fallback for codes would fix "`RB1100` doesn't find `RB1100AHx4`".
- **Admonitions deserve index weight.** Callouts carry "requires package X", "changed in 7.x", "not on CHR" — high-value but diluted in page-level FTS. rosetta indexes 1,034 callouts separately.
- **`matrix.csv` as a search/index asset and generated-pivot source.** rosetta extracts the product matrix (144 products, 34 columns; RAM/storage normalized to integer MB) into SQLite for structured device filters, and extracts product-page block diagrams (110 devices) which carry switch-chip detail. The matrix's columns (`CPU` e.g. `88F3720`, `Architecture`, `SFP+ ports`, `License level`) are natural **build-time pivots**: a Docusaurus build step could generate MDX pages like "devices using CPU 88F3720" or "devices with 10G SFP+" or "devices using switch chip 98DX3236", turning structured hardware data into indexable, linkable navigation surfaces that don't exist as hand-written pages today. This both improves on-site search recall for chip/spec queries and gives third-party indexers stable pivot URLs.

## Options considered

### Option A — Freeze prose docs, keep command/schema updates

Treat the March 2026 Confluence export as a historical prose snapshot. Continue updating command-tree data from restraml and changelogs from MikroTik download URLs.

**Pros:** Lowest risk; preserves current DB schema and MCP/TUI contracts; keeps versioned command data fresh.

**Cons:** rosetta's prose answers drift from official docs; new feature docs never land; the README promise of complete current docs becomes less true over time.

**Status: this is the de facto posture today** — it was acceptable only as an interim, and the interim is over. The migration exists because A is no longer good enough.

### Option B — Docusaurus page scraper as a drop-in prose extractor

Replace `extract-html.ts` with a crawler/parser that discovers pages from `sitemap.xml`, fetches Docusaurus-rendered HTML, and maps headings, admonitions, tables, and code blocks into the existing `pages`, `sections`, `callouts`, and `properties` tables.

**Pros:** Smallest conceptual change for MCP/TUI consumers; preserves SQL-as-RAG model and most query code.

**Cons:** "Drop-in" is probably optimistic. Confluence IDs disappear, URLs and anchors change, page hierarchy is path-based, and property tables may not preserve the same semantics. Synthetic page IDs from URL/content hashes would need migration care.

**Status: rejected as the primary path** — starting from rendered HTML is the wrong plan now that `.md` exists for `/docs`. Two carve-outs survive: `.md` pages will still need custom fixups (very long pages, MDX/JSX islands), and the HTML parser skill is still required for `/hardware` device pages, which have no `.md`.

### Option C — CLI Reference as a first-class structured source

Parse the Docusaurus CLI Reference pages into a new `manual_cli_reference`-style table: package/path, flags, arguments, read-only arguments, rendered descriptions, and manual URLs.

**Pros:** Captures MikroTik's own published `/console/inspect` presentation, including human-facing descriptions and data CHR-based inspect misses (`Conditions`/`Syscap`, menus absent on CHR).

**Cons:** It is "current only" unless MikroTik publishes versioned manuals. It may duplicate or conflict with restraml `deep-inspect.json`. If rosetta treats it as the command authority, it loses the version matrix that restraml provides.

Best use: companion/provenance layer for current manual URLs, human descriptions, and inspect-invisible facts — not the replacement for versioned inspect data.

### Option D — Hybrid official manual + restraml deep-inspect *(current lean)*

Use Docusaurus narrative pages for prose RAG, Docusaurus CLI Reference for official current manual links/labels, and restraml `deep-inspect.json` for versioned command truth.

**Pros:** Preserves rosetta's strongest current asset: version-aware command data. Lets agents see official manual pages and command-tree facts together. Keeps live-router `/console/inspect` as the ultimate validator for connected-router tools outside rosetta.

**Cons:** Requires deliberate merge/linking rules when Docusaurus CLI Reference disagrees with restraml for a version/package/arch. Forces MCP/TUI result-shape work instead of just a crawler swap.

**Overlay sketch:** treat the parsed CLI Reference as a **version-less enrichment overlay** keyed by command path (+ argument name). Where a path/arg matches restraml data, attach the CLI Reference URL and any manual-only facts (`Conditions`, `Syscap`, human description) to the versioned record; where it doesn't match, keep it as a manual-only row with explicit provenance. Never let the overlay assert version facts — it has no version to assert.

### Option E — Upstream/source-artifact integration

Look for a published source repository, JSON artifact, or stable Docusaurus build artifact that exposes MDX/docs data more directly than rendered HTML.

**Pros:** Cleaner than scraping rendered pages; may preserve frontmatter, sidebar hierarchy, and generated CLI metadata.

**Cons:** Unknown availability and stability. Scraping bundled JavaScript chunks is brittle unless MikroTik documents it as an API.

**Status: discovery track, do not block on it** — but run it *before* committing to parsers (homework H1/H2): un-minify and document how the site is actually built (plugins, custom lunr behavior, any additional emitted artifacts) so future agents inherit that understanding instead of re-deriving it, and so we catch shortcuts or metadata we'd otherwise miss.

### Option F — Broader MCP/TUI redesign around source-typed results

Stop treating "page" as the dominant result type. Model search output as source-typed results: narrative doc page, CLI Reference menu, command-tree node, property/argument, changelog entry, device, video, Dude page, skill guide.

**Pros:** Matches the post-Confluence world and the North Star unified-search direction. Agents can follow explicit relationships: command node → CLI Reference page → narrative doc page → changelog/version facts.

**Cons:** Larger change touching query core, MCP schemas/descriptions, browse dot-commands, parity tests, docs, and retrieval evals.

This should happen alongside the Docusaurus extractor, not as an afterthought — otherwise rosetta imports the new source but presents it through old Confluence assumptions. Points that pull toward F anyway:

- The `/hardware` section (240 device pages) naturally joins rosetta's `devices` data — a source-typed result, not a prose page.
- `routeros_search` already returns more than help.mikrotik.com pages (devices, callouts, videos, changelogs, skills), so the source-typed concept half-exists; F is finishing it deliberately, possibly with more parameters on `routeros_search` rather than more tools.
- A cross-source **rosetta-id** scheme (see identity question below) is effectively the F data model — figuring out ID mapping for the migration advances F for free. F's full surface work remains *future* work after the Docusaurus source has landed.

## Current lean

Pursue Option D, implemented in phases:

1. Discover stable source inputs: sitemap, `llms.txt`, per-section machine-readability (the 2026-07-07 surface inventory), any documented source artifacts, and CLI Reference page conventions. *(Largely done; remaining unknowns are the T-0033 homework.)*
2. Build a Docusaurus prose extractor with synthetic stable IDs and explicit `source_kind` / `source_url` provenance rather than pretending Confluence IDs still exist. Design the ID scheme to apply to **all** sourced tables (pages, CLI-reference rows, devices, changelog entries), not just prose — that identity work is the F down-payment.
3. Add CLI Reference extraction as a companion structured source linked to `schema_nodes` by command path, per the version-less overlay sketch in Option D.
4. Rework MCP/TUI search around source-typed results and preserve TUI/MCP parity in the same change set.
5. Keep restraml `deep-inspect.json` as rosetta's versioned command authority; use Docusaurus CLI Reference as official current-manual presentation and cross-link material.

**Sequencing gate:** publish a final help.mikrotik.com-corpus NPM release **before** any migration code lands, so the last Confluence-based DB is durably installable. Tracked in `BACKLOG.md` Triggers; T-0033 (research-only) may proceed before the gate, extractor work may not.

## Pre-migration homework (tracked as T-0033)

Research assignments that must resolve before extractor tasks are cut. Each produces an update **to this briefing** (that is the deliverable — B-0012 stays the single source future coding agents read):

- **H1 — Site internals write-up.** Un-minify/document how manual.mikrotik.com is built: Docusaurus plugins in play (`docusaurus-plugin-llms`, `@easyops-cn/docusaurus-search-local`, blog instances), custom components (`ArgTable`), page assembly, and any additional emitted artifacts. Goal: future agents never re-unwind minified JS to learn this.
- **H2 — Lunr/tokenizer deep-dive.** Extract MikroTik's full search customization (beyond the confirmed slash-splitting separator) and compare against rosetta's FTS cascade — find anything rosetta missed, and anything MikroTik missed worth forum feedback.
- **H3 — CLI Reference survey.** Coverage pass across all `cli-reference/*.md`: how consistently enum values/ranges/alt types appear; full semantics of `Conditions`/`Syscap`; what overlaps deep-inspect vs is manual-only; overlay key design (path+arg match rules).
- **H4 — Property-descriptions assessment.** The suspected hard part: today's extractor does heavy Confluence parsing to populate `properties`. Sample representative `/docs` `.md` pages and assess what a Markdown-based property parser preserves/loses vs current, before any extractor task is written.
- **H5 — restraml downstream-effects inventory.** `enrich-openapi.ts` reads `ros-help.db` (`commands.page_id`, description merging). Enumerate exactly what breaks when page identity moves off Confluence IDs, and agree the cross-repo contract (likely: restraml consumes the new stable rosetta-id + `source_url`).
- **H6 — Non-`/docs` sections plan.** `/hardware` (HTML parser → `devices` join), `/changelog` (RSS-driven delta capture, stored even if unsurfaced), `/blog` (low priority; PDF newsletters, no deep parsing). Decide storage + MCP surfacing per section.
- **H7 — Identity / rosetta-id design.** See open question below; must be decided before the extractor mints IDs.
- **H8 — CI cross-check design.** Which scoped count comparisons (sitemap↔llms.txt↔extracted↔search-doc) become blocking `V-*` rows; what minimum-content and retrieval-eval fixtures change so a broken Docusaurus import fails CI.

## Open questions

- ~~Does MikroTik publish the Docusaurus source content or a stable generated metadata artifact, or is rendered HTML/sitemap the only reliable public input?~~ **Answered 2026-06-02:** per-page `.md`/`.mdx`, `llms.txt`, `llms-full.txt`, and `sitemap.xml` are all published. No JSON manifest yet, but discovery is solved. **2026-07-07:** machine-readable layer covers `/docs` only — see surface inventory.
- ~~Are CLI Reference pages versioned anywhere, or are they always "current"?~~ **Answered 2026-06-02:** still a single `"current"` tag; no per-version manual copies yet.
- **Page/source identity (H7).** Existing `pages.id` values are Confluence IDs; Docusaurus pages are path-based. Observed: agents cling to whatever ID rosetta returns and quote it in prose ("confirmed from rosetta#91931"), so the ID *will* leak into human-facing text regardless. Lean: a cross-source **rosetta-id indirection table** (id → source kind, source path/URL, extraction provenance) covering every surfaced row type, giving one dereference point and a remap seam if MikroTik ever ships versioned pages. Design caution: prefer **derivable/verifiable IDs** (e.g. source-path slugs like `docs/ip/address` or prefixed slugs) over opaque numerics — agents fabricate plausible-looking numbers, and an opaque scheme makes fabricated citations indistinguishable from real ones, while a slug is self-checking against the URL it derives from. Whether `sitemap.xml` permalinks alone suffice is part of H7.
- **CLI Reference argument data: promote into `schema_nodes` or separate layer?** Lean: separate version-less overlay (Option D sketch). Versioned deep-inspect stays richer where they overlap because it has version provenance and the CLI Reference's build version is unknown — even now that enum values are published, there is no version to file them under. The sharper questions are (a) surfacing the CLI Reference **URL** on command results, and (b) capturing manual-only facts like `Conditions: !smips` / `Syscap: lcd` that inspect never sees. Answer belongs to H3.
- **What CI changes catch a broken Docusaurus import (H8)?** Scoped cross-checks can be exact (fail on any mismatch) because `/docs` has three independent inventories (sitemap subset, `llms.txt`, `search-doc.json`) to reconcile against extracted pages. Deeper parse-quality checks (long pages, CLI Reference tables, `/hardware` tables) need content-shape fixtures, not just counts. `/changelog` review may also carry clues about what changed when counts drift.
- **How should old help.mikrotik.com URLs be retained?** Lean: rosetta returns **manual.mikrotik.com URLs** (plus the rosetta-id) on all results going forward; legacy Confluence URLs/IDs are kept only as historical provenance columns for the final Confluence-corpus release — no redirect machinery in rosetta. (A legacy→new link map is only worth building if H4/H5 show consumers actually hold old URLs.)
