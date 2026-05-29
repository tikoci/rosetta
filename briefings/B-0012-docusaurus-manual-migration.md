---
id: B-0012-docusaurus-manual-migration
topic: Docusaurus manual migration after Confluence retirement
status: open
related_tasks: []
created: 2026-05-29
last_revisited: 2026-05-29
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

## Raw Markdown exposure findings

Tested against <https://manual.mikrotik.com/docs/CLI%20Reference/system/ip/address> on 2026-05-29:

- Direct Markdown/MDX routes return 404: `.md`, `.mdx`, `/index.md`, `/index.mdx`, and `/raw/...`.
- Query parameters do not change representation: `?raw=1`, `?plain=1`, and `?download=1` still return rendered HTML.
- Content negotiation does not help: `Accept: text/markdown`, `text/plain`, `application/mdx`, and `application/json` still return rendered HTML.
- Docusaurus debug endpoints are not published: `/__docusaurus/debug/*` returns 404.
- The production bundle includes metadata with the internal source path, for example `source: "@site/docs/CLI Reference/system/ip/address.md"`, but not the raw Markdown file.
- Per-route content chunks are fetchable and contain compiled MDX/React plus metadata. For `/ip/address`, the route maps to `/assets/js/e98f1f74.b3beb3c0.js`, which contains tables as React component calls rather than source Markdown.
- The local search plugin publishes plaintext section data at `search-doc-1780040063461.json` and an alias `search-doc.json`. This is useful for fallback indexing, but it has already lost Markdown structure and may flatten tables/code.

Conclusion: the current site is Docusaurus-native internally, but the deployed production site does not make raw Markdown available through stable curl-friendly URLs.

Docusaurus itself does not appear to have a single built-in "emit raw Markdown beside every rendered page" option. The official docs plugin consumes `**/*.md` and `**/*.mdx`, compiles them with MDX into React/static output, and publishes metadata such as source paths. Docusaurus does support the pieces needed to add this cleanly:

- `staticDirectories` copies files verbatim into the build output, which can publish a curated raw-doc tree if the source tree is mirrored there during build.
- Local/custom plugins can use lifecycle hooks and static data generation to copy published source files, emit manifests, or add machine-readable routes.
- The docs plugin metadata already tracks source paths and route metadata, so a custom plugin can preserve the same published-doc filtering/version rules instead of exposing drafts or private files by accident.

For rosetta, the fallback order should be:

1. Prefer any future official raw Markdown or manifest endpoint if MikroTik adds one.
2. Parse rendered HTML from sitemap-discovered pages for prose and tables.
3. Use `search-doc*.json` only as a fallback text source or completeness check.
4. Avoid depending on hashed compiled MDX chunks except as a last-resort metadata probe; their URLs and structure are build artifacts.

## Recommended MikroTik publishing change

Ask MikroTik to publish source docs as explicit public artifacts rather than relying on Docusaurus internals:

- Add a curl-friendly raw Markdown tree, for example `/raw-docs/<docPath>.md` and `/raw-docs/<docPath>.mdx`, served with `Content-Type: text/markdown; charset=utf-8`.
- Add a machine-readable manifest such as `/manual-manifest.json` with `docId`, `permalink`, `sourcePath`, `rawMarkdownUrl`, `title`, `version`, `lastModified`, `sha256`, `sidebar`, and `frontMatter`.
- Add per-page HTML discovery links, for example `<link rel="alternate" type="text/markdown" href="/raw-docs/CLI%20Reference/system/ip/address.md">`.
- If CLI Reference pages are generated from `/console/inspect`, also publish the generated structured source as JSON, for example `/cli-reference.json` or one JSON file per path, so agents do not have to reverse-engineer tables from HTML.
- Optionally publish `llms.txt` and `llms-full.txt` that point agents at the manifest, raw Markdown tree, CLI Reference JSON, sitemap, and version/provenance notes.

Implementation choices for MikroTik:

- Easiest: copy the public docs source into a non-conflicting static path during build, such as `static/raw-docs/`, and ensure draft/private files are excluded.
- Better: add a small Docusaurus plugin that uses the docs plugin metadata to emit only published docs plus a manifest, preserving the same include/exclude/version rules as the rendered site.
- Best for rosetta: publish the Markdown manifest and the `/console/inspect`-derived CLI Reference JSON together, with content hashes and RouterOS version/provenance metadata.

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

- Does MikroTik publish the Docusaurus source content or a stable generated metadata artifact, or is rendered HTML/sitemap the only reliable public input?
- Are CLI Reference pages versioned anywhere, or are they always "current"?
- How should page identity migrate when existing `pages.id` values are Confluence IDs but Docusaurus pages are URL/content-hash based?
- Should CLI Reference argument types promote directly into `schema_nodes`, or stay as a separate official-manual layer linked by path?
- What minimum-content and retrieval evals need to change so CI catches a broken Docusaurus import?
- How should old help.mikrotik.com URLs be retained: historical provenance only, redirects, or link map from legacy pages to new manual URLs?
