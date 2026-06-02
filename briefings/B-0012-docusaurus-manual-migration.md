---
id: B-0012-docusaurus-manual-migration
topic: Docusaurus manual migration after Confluence retirement
status: open
related_tasks: []
created: 2026-05-29
last_revisited: 2026-06-02
---

# Question

How should rosetta evolve now that MikroTik's public RouterOS help system has moved from the old Confluence site/export to the Docusaurus manual at <https://manual.mikrotik.com>?

## What's grounding this

- Future official docs are expected on <https://manual.mikrotik.com>, not as Confluence HTML exports.
- Current rosetta prose extraction depends on Confluence-specific structure: page IDs, breadcrumb metadata, `confluenceTable`, callout macros, and `syntaxhighlighter-pre` code blocks.
- The new site exposes a normal sitemap at <https://manual.mikrotik.com/sitemap.xml>.
- The new CLI Reference at <https://manual.mikrotik.com/docs/CLI%20Reference/> exposes command menus, flags, argument names, and argument types from `/console/inspect`-derived data. Example: <https://manual.mikrotik.com/docs/CLI%20Reference/system/ip/address> renders `/ip/address` as a directory with flags and argument/read-only argument tables.
- restraml already publishes versioned `inspect.json` / `deep-inspect.json` from live CHR `/console/inspect`; rosetta stores those in `commands`, `command_versions`, `schema_nodes`, and `schema_node_presence`.
- MCP and TUI surfaces currently present a Confluence-page-shaped world: page search, page IDs, sections, property lookup, and command links back to legacy docs.

## Machine-readable exposure — status

### Original 2026-05-29 findings (now superseded)

When first tested against <https://manual.mikrotik.com/docs/CLI%20Reference/system/ip/address> on 2026-05-29, the deployed site exposed **no** raw Markdown: `.md`/`.mdx`/`/index.md`/`?raw=1` and `Accept: text/markdown` all returned rendered HTML, `/__docusaurus/debug/*` was 404, there was no `llms.txt`, and the only plaintext source was the local search plugin's `search-doc.json`. The conclusion then was that the site was Docusaurus-native internally but published nothing curl-friendly.

### Verified 2026-06-02 — MikroTik has shipped the machine-readable layer

Re-tested 2026-06-02; the site changed materially within days. The "Using this documentation" page now documents these explicitly ("The whole manual is published in plain formats so it can be read by retrieval pipelines, assistants, and other automated tools, not only in a browser."):

- **Per-page raw Markdown works.** `…/getting-started/using-this-documentation.md` → `200`, raw Markdown body. `…/docs/cli-reference/ip/address.md` → `200`, raw **MDX** (includes `import {ArgTable} from '@site/src/components/common'`). Both are served as `Content-Type: application/octet-stream` rather than `text/markdown`, but the bytes are real Markdown/MDX.
- **`llms.txt` and `llms-full.txt` are live.** `llms.txt` is a page index ("An index of every page, with a short description and a link for each"); `llms-full.txt` is the whole manual concatenated (≈30K+ words sampled) for bulk ingestion.
- **`sitemap.xml`** lists ~1,100+ URLs. CLI Reference URLs are now lowercase `cli-reference` (e.g. `…/docs/cli-reference/ip/address`), **not** the earlier `CLI%20Reference` form.
- **Search** is a lunr-based local Docusaurus plugin (publishes `search-doc.json` with the `searchDocs`/`pageTitle`/`tagName`/`version` schema of `@easyops-cn/docusaurus-search-local`). Porter stemming is on by default. The index carries a `version` field, currently `"current"` or `null`.
- **CLI Reference is auto-generated** from RouterOS itself ("generated automatically from the RouterOS system itself … menus, commands, and argument types are extracted from the software"). Argument types are present in the MDX (`typ="ipAddr"`, `typ="interface_enum"`, `mandatory="1"`), but encoded as JSX `<ArgTable>`/`<ArgTableRow>` component props — enum *values*, package associations, and version provenance are not in the published source.

### What this means for rosetta extraction

The Option D plan stands, but the input layer is much better than assumed:

1. **Prefer per-page `.md`/`.mdx`** discovered via `sitemap.xml` (or `llms.txt`) over parsing rendered HTML — that was the hoped-for "future official raw Markdown endpoint" and it now exists.
2. **CLI Reference `.md` still needs a JSX-aware parser** (`ArgTable`/`ArgTableRow` props), and it lacks enum values / package / version — so restraml `deep-inspect.json` remains rosetta's versioned command authority; treat manual CLI Reference as official current-manual presentation/cross-link material (Option C/D split unchanged).
3. **`search-doc.json`** is a structural completeness check, not a primary source (it has already lost table/code structure).
4. `llms-full.txt` is a cheap whole-corpus diff/completeness signal between extractions.

### Still-open asks to MikroTik (not yet shipped)

Most of the original publishing recommendations have landed. What remains:

- **Structured CLI Reference data** (JSON/YAML per path) instead of JSX-wrapped MDX, including enum values, package associations, and per-version provenance. (Raised in forum #270714 post #70 "Dear @mrz".)
- **Versioned docs** beyond a single `"current"` tag. (Forum #270714 posts #58/#68.)
- **Stable, package-agnostic, path-derivable URLs** with well-known `#flags`/`#attributes` anchors. (Forum #270714 posts #58/#70.)
- **A manifest** (`docId`, `permalink`, `sourcePath`, `version`, `sha256`, `frontMatter`) would still help, but is lower priority now that `.md` + `sitemap.xml` + `llms.txt` cover discovery.

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

This is acceptable only as an interim maintenance posture.

### Option B — Docusaurus page scraper as a drop-in prose extractor

Replace `extract-html.ts` with a crawler/parser that discovers pages from `sitemap.xml`, fetches Docusaurus-rendered HTML, and maps headings, admonitions, tables, and code blocks into the existing `pages`, `sections`, `callouts`, and `properties` tables.

**Pros:** Smallest conceptual change for MCP/TUI consumers; preserves SQL-as-RAG model and most query code.

**Cons:** "Drop-in" is probably optimistic. Confluence IDs disappear, URLs and anchors change, page hierarchy is path-based, and property tables may not preserve the same semantics. Synthetic page IDs from URL/content hashes would need migration care.

This is the likely first implementation step, but it should not pretend source identity is unchanged.

### Option C — CLI Reference as a first-class structured source

Parse the Docusaurus CLI Reference pages into a new `manual_cli_reference`-style table: package/path, flags, arguments, read-only arguments, rendered descriptions, and manual URLs.

**Pros:** Captures MikroTik's own published `/console/inspect` presentation, including human-facing descriptions and package/path pages that may cover areas CHR-based inspect misses.

**Cons:** It is probably "current only" unless MikroTik publishes versioned manuals. It may duplicate or conflict with restraml `deep-inspect.json`. If rosetta treats it as the command authority, it loses the version matrix that restraml provides.

Best use: companion/provenance layer for current manual URLs and human descriptions, not the replacement for versioned inspect data.

### Option D — Hybrid official manual + restraml deep-inspect

Use Docusaurus narrative pages for prose RAG, Docusaurus CLI Reference for official current manual links/labels, and restraml `deep-inspect.json` for versioned command truth.

**Pros:** Preserves rosetta's strongest current asset: version-aware command data. Lets agents see official manual pages and command-tree facts together. Keeps live-router `/console/inspect` as the ultimate validator for connected-router tools outside rosetta.

**Cons:** Requires deliberate merge/linking rules when Docusaurus CLI Reference disagrees with restraml for a version/package/arch. Forces MCP/TUI result-shape work instead of just a crawler swap.

This is the current lean.

### Option E — Upstream/source-artifact integration

Look for a published source repository, JSON artifact, or stable Docusaurus build artifact that exposes MDX/docs data more directly than rendered HTML.

**Pros:** Cleaner than scraping rendered pages; may preserve frontmatter, sidebar hierarchy, and generated CLI metadata.

**Cons:** Unknown availability and stability. Scraping bundled JavaScript chunks is brittle unless MikroTik documents it as an API.

Use this as a discovery track before implementing the crawler, but do not block on it.

### Option F — Broader MCP/TUI redesign around source-typed results

Stop treating "page" as the dominant result type. Model search output as source-typed results: narrative doc page, CLI Reference menu, command-tree node, property/argument, changelog entry, device, video, Dude page, skill guide.

**Pros:** Matches the post-Confluence world and the North Star unified-search direction. Agents can follow explicit relationships: command node → CLI Reference page → narrative doc page → changelog/version facts.

**Cons:** Larger change touching query core, MCP schemas/descriptions, browse dot-commands, parity tests, docs, and retrieval evals.

This should probably happen alongside the Docusaurus extractor, not as an afterthought, because otherwise rosetta will import the new source but present it through old Confluence assumptions.

## Current lean

Pursue Option D, implemented in phases:

1. Discover stable source inputs: sitemap, rendered HTML, any documented source artifacts, and CLI Reference page conventions.
2. Build a Docusaurus prose extractor with synthetic stable IDs and explicit `source_kind` / `source_url` provenance rather than pretending Confluence IDs still exist.
3. Add CLI Reference extraction as a companion structured source linked to `schema_nodes` by command path.
4. Rework MCP/TUI search around source-typed results and preserve TUI/MCP parity in the same change set.
5. Keep restraml `deep-inspect.json` as rosetta's versioned command authority; use Docusaurus CLI Reference as official current-manual presentation and cross-link material.

## Open questions

- ~~Does MikroTik publish the Docusaurus source content or a stable generated metadata artifact, or is rendered HTML/sitemap the only reliable public input?~~ **Answered 2026-06-02:** per-page `.md`/`.mdx`, `llms.txt`, `llms-full.txt`, and `sitemap.xml` are all published. No JSON manifest yet, but discovery is solved.
- ~~Are CLI Reference pages versioned anywhere, or are they always "current"?~~ **Answered 2026-06-02:** still a single `"current"` tag (search index `version` field is `"current"`/`null`); no per-version manual copies yet.
- How should page identity migrate when existing `pages.id` values are Confluence IDs but Docusaurus pages are URL/content-hash based? (Now lean on `.md` source path + sitemap permalink for stable identity.)
- Should CLI Reference argument types promote directly into `schema_nodes`, or stay as a separate official-manual layer linked by path? (Note: published MDX lacks enum values/package/version, so restraml stays the authority — argues for separate layer.)
- What minimum-content and retrieval evals need to change so CI catches a broken Docusaurus import?
- How should old help.mikrotik.com URLs be retained: historical provenance only, redirects, or link map from legacy pages to new manual URLs?
