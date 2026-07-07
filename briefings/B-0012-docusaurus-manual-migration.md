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
- **Search** is a lunr-based local Docusaurus plugin (publishes `search-doc.json` with the `searchDocs`/`pageTitle`/`tagName`/`version` schema ~~of `@easyops-cn/docusaurus-search-local`~~ — *corrected 2026-07-07 afternoon: the schema resemblance was coincidental. It's actually a MikroTik-patched fork of the `docusaurus-lunr-search` package, loaded from a local build path, not the npm `@easyops-cn` package — see H1/H2 write-up below.*). Porter stemming is on by default. The index carries a `version` field, currently `"current"` or `null`.
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

### Verified 2026-07-07 (afternoon) — H1, H2, H3, H4, H5, H6, H8 homework resolved

All findings below are from live probes against `https://manual.mikrotik.com` (curl + Python
parsing, no browser rendering) run today, plus a background-agent read-only pass over
`~/GitHub/restraml`. Raw probe artifacts (fetched JS bundles, all 236 CLI Reference `.md`
files, the live `lunr-index`/`search-doc` JSON) stayed in scratch, not committed — treat the
numbers below as the durable record, not the files.

#### H1 — Site internals

The homepage's initial HTML is a near-empty Docusaurus shell that embeds its own build config
as a `JSON.parse(...)` blob inside `/assets/js/main.<hash>.js`. This is a stable, legitimate way
to read MikroTik's effective `docusaurus.config.js` without unwinding application logic.

- **Generator:** `Docusaurus v3.10.1`; all `@docusaurus/*` packages pinned to `3.10.1`.
- **Build path leaked via an unbundled local plugin reference** (not sensitive — just an
  artifact of a non-npm plugin): `.../ci-docu-pub/24133/docusaurus/docusaurus/routeros/plugins/lunr-search-patched/index.js`
  — confirms the build runs on **GitLab CI** (project `ci-docu-pub`), build #24133 as of this
  snapshot.
- **Full plugin list:** a locally-patched search plugin (registered internally as
  `docusaurus-lunr-search`, `"type":"project"` — i.e. not an npm package, see H2),
  `docusaurus-plugin-image-zoom@3.0.1`, a second `@docusaurus/plugin-content-docs` instance
  (`id:"hardware", path:"hardware", routeBasePath:"hardware", sidebarPath:"./sidebarsHardware.ts"`),
  a second `@docusaurus/plugin-content-blog` instance (`id:"changelog", routeBasePath:"changelog", path:"./changelog"`),
  and `docusaurus-plugin-llms@0.4.0` (config: `generateLLMsTxt:true, generateLLMsFullTxt:true,
  generateMarkdownFiles:true, includeBlog:false`, **no `docsDir` override**).
- The default `classic` preset carries the default docs instance (`path:"/"`), the default blog
  instance (`blogTitle:"Product news"` — `/blog`), and the sitemap plugin
  (`changefreq:"weekly", priority:0.5`).
- **`markdown` config:** `format:"mdx"`, `mermaid:true` (Mermaid diagrams are a supported
  content type — watch for any in the corpus during extraction), `mdx1Compat` flags all `false`
  (real MDX3 syntax, not MDX1 back-compat).
- **`/hardware` is a first-class Docusaurus docs instance, not a bespoke section.** Its pages
  are real Markdown source (webpack module comments leak source paths, e.g.
  `@site/hardware/lte-products/lhg-r.md`) built through the standard docs plugin — MikroTik
  simply didn't opt it into the machine-readable layer (see H6).
- **Why `/hardware` gets no `.md`/`llms.txt` coverage — now root-caused, not just observed.**
  `docusaurus-plugin-llms`'s own README (checked 2026-07-07 via its GitHub repo) documents a
  `docsDir` option, "Base directory for documentation files (default: `'docs'`)," and documents
  **no** per-instance/`pluginId` scoping option. MikroTik's invocation passes no `docsDir`
  override, so the plugin only walks `docs/` — the `hardware` instance uses `path:"hardware"`
  (a sibling directory), so it's structurally invisible to the plugin, not deliberately
  excluded. Grounded in the plugin's documented default, not a guess about MikroTik's intent.

#### H2 — Lunr/tokenizer deep-dive

Rather than unwind the lazy-loaded, webpack-chunked search UI bundle (impractical via curl —
its chunk hash isn't in any static manifest until the search box is actually used), the live
**serialized lunr index** was fetched and parsed directly. Its filename hash
(`search-doc-<epoch-ms>.json` / `lunr-index-<epoch-ms>.json`) was read straight out of the same
`main.js` siteConfig blob as H1 (key `"docusaurus-lunr-search":{"default":{"fileNames":{...}}}`)
— no brute-forcing needed. Snapshot hash `1783409636720` as of 2026-07-07; it changes on the
next site rebuild, so future work must re-discover it the same way. Parsed as a lunr.js v2.3.9
index:

- **`fields: ["title", "content", "keywords"]`** — three-field document. No per-field boost is
  recoverable from the serialized index (boost weights live in the query-time JS, still
  requires the chunk).
- **`pipeline: ["stemmer"]` only — corrects the earlier assumption.** Vanilla lunr's default
  pipeline is `[trimmer, stopWordFilter, stemmer]`. MikroTik's patched build strips **trimmer
  and stopWordFilter**, keeping only the Porter stemmer. Confirmed two ways: (a) the serialized
  `pipeline` array literally lists only `"stemmer"`; (b) the inverted index contains raw
  stopwords (`is`, `to` — both on lunr's default stopword list) and un-trimmed
  punctuation/entity garbage as literal terms (`configuration&quot`, `configuration).open`,
  `0&quot`, `0'..'9`). MikroTik's index is noisier than stock lunr defaults as a result.
- **Porter stemming confirmed** (`configuration` → `configur` is an index term).
- **No slash-containing compound terms exist in the index** (zero hits for `/` in
  `invertedIndex`), independently corroborating the forum-reported custom slash separator
  (`ip/dhcp-server/lease` → 3 tokens).
- **Hyphenated identifiers are not split** — `ccr1009-7g-1c-1s+pc` is a single index term, so
  device/product codes stay intact (consistent with rosetta's own device-index approach).
- **New: `search-doc.json` covers `/hardware`, `/changelog`, and `/blog` too, not just
  `/docs`.** 8,219 total `searchDocs` entries: 4,263 `/docs/*`, **3,851 `/hardware/*`**, 101
  `/changelog/*`, 4 `/blog/*` — one merged index (`{"options":{"id":"default"}}`) across every
  docs+blog instance, not per-instance. This refines the morning surface-inventory table:
  `/hardware` is absent from `.md`/`llms.txt`, but *is* covered by the client search index,
  including flattened section-level prose. **Practical implication for H6:**
  `search-doc.json`'s `content` field is a legitimate stopgap plain-text source for `/hardware`
  prose (safety warnings, regulatory text, package contents) not in `matrix.csv`, without
  writing an HTML parser for a first pass — tables still collapse to run-on text
  (`Number of DC inputs 1 (3-pin terminal);Min voltage 12 V...`), so it stays a fallback, not a
  structured-field source.
- **Forum feedback candidate (new):** the missing trimmer/stopWordFilter is worth adding to the
  rosetta→MikroTik search-quality feedback below, alongside the already-confirmed slash
  separator — raw HTML-entity/punctuation tokens in the index look like unintentional noise,
  not a deliberate choice.

#### H3 — CLI Reference survey (full census, not a sample)

`llms.txt` lists exactly **236** `cli-reference/*.md` URLs; all 236 were fetched and parsed
(regex over raw MDX — a structural census, not a real MDX parser). Results:

| Fact | Count / rate | Note |
|---|---:|---|
| Files with `<ArgTable>` | 223/236 | 13 pages are text-only (no argument table) |
| Files with a **Flags** table (`c1="Flag"`) | 147/236 | Distinct from Argument/Read-only tables |
| Files with a Read-only Argument table | 172/236 | |
| Files with `**Conditions:**` | 41/236 | |
| Files with `**Syscap:**` | 18/236 | |
| Files with `**Package:**` | **69/236** | **Corrects this briefing's earlier "package association absent" claim — see below** |
| `**Type:**` row distribution | Command 460, Directory 510, Settings 119 | "Settings" is a third menu-node type not previously documented — likely single-item (non-list) menus like `/system/clock` |
| Argument rows with bare `typ="enum"` (no values) | 493 | |
| Argument rows with `typ="enum (...)"` (values present) | 1,150 | Common but **not universal** even for enum-typed args — refines the morning `lcd.md`-only sample |
| `alt { ... }` composite/alternative rows | 293 | |
| `[min .. max]` range rows | 397 | |
| `composite { ,  }` rows with **empty** sub-field names | 268 | Composite-subfield naming is inconsistently populated |

New, concrete findings not in this briefing before today:

1. **`**Package:** <name>` is a real per-command-path field — contradicting every earlier
   "package association is absent" statement in this briefing** (Option C cons, "still-open
   asks," the `schema_nodes` open question). 19 distinct values observed: `advanced-tools,
   calea, container, dhcp, dude, gps, hotspot, iot, ipv6, openflow, ppp, rose-storage, security,
   tr069-client, ups, userman-5, wireless-qca, wireless-rep, zerotier`. This directly addresses
   the `schema_nodes._package population` BACKLOG trigger *for the current-manual overlay* —
   rosetta doesn't have to wait on restraml to emit package provenance; **the CLI Reference
   overlay could become the actual source for `schema_nodes._package`.**
2. **`**Conditions:**` is a mixed namespace, not purely architecture.** Confirmed arch tokens
   (`i386, arm64, mmips, tile, smips, mipsel, powerpc`, singly or `!`-negated, sometimes
   comma-lists) **and** what look like internal build-feature flags: `BFD_AUTHENTICATION,
   CONSOLE_DEBUG, IKE2_DEV, MSRP_ENABLE`. Their exact semantics are **not confirmed** — flag as
   uncertain provenance if ever surfaced to agents; don't assert meaning beyond "a condition
   gating this command's presence."
3. **`**Syscap:**` vocabulary is broader than "lcd" and includes boolean expressions.**
   Observed (partial list; full list only in the scratch probe, not promoted anywhere):
   `!prestera-ac3, (poe or poe-in), 60ghz, app, chr, cloud-vpn, container, crs_prestera,
   dfstest, gpio, health, health-settings, lcd, multiswitch, nochr, oldswitch, partitions, poe,
   poesettings, ptp`. Notably `Syscap: nochr` and `Syscap: chr` both exist as explicit, opposite
   tags — **MikroTik explicitly marks CHR-availability rather than leaving it implicit**, which
   strengthens (with a concrete citation) the claim that CLI Reference "carries facts restraml
   cannot produce": CHR-based `/console/inspect` can't observe its own absence the way a
   manually-curated `nochr` tag can assert it.
4. **Enum numeric codes sometimes appear inline**, e.g. `alt { , enum (from-dscp | from-ingress
   | from-dscp-high-3-bits) { from-dscp:65536, from-ingress:65537,
   from-dscp-high-3-bits:65538 } }` — plausibly the actual RouterOS API wire-protocol integer
   codes. **Not verified against a live-router API capture — flag as a hypothesis**, not a
   confirmed fact, until cross-checked.
5. **A per-page AI-generated one-line summary blockquote exists** (`> ...` under the H1) but is
   **essentially never populated for CLI Reference pages** (235/236 show a placeholder
   `-----------`). By contrast, spot-checked ordinary `/docs` prose pages (`dns.md`,
   `introduction.md`) **do** carry a real generated summary. This looks like a `/docs`-prose-only
   feature (plausibly reading a frontmatter `description` that's populated for hand-authored
   prose but empty for auto-generated CLI MDX) — **provenance (MikroTik's own addition vs. an
   upstream default) is unconfirmed either way.** Useful either as a free page-level abstract or
   an extra `pages` column, if it proves reliable.
6. **Still absent, confirmed again:** no version-provenance field of any kind across all 236
   pages — this part of the original assumption stands.

#### H4 — Property-descriptions assessment

Sampled representative `/docs` prose pages with property tables (`network-management/dhcp.md`
in depth, plus a `dns.md` spot check). Verdict: **this is not the hard part it was feared to
be** — the Markdown property-table shape is structurally close to today's Confluence
`confluenceTable` shape, not a rewrite:

- Properties render as a plain two-column Markdown pipe table under a `### Properties` (or
  `#### Read-only properties`) heading: `| Property | Description |`, with name/type/default
  packed into column 1 exactly like the Confluence `<strong>name</strong> (<em>type</em>;
  Default: value)` pattern — Markdown `**name**`/`*type*`/"Default:" instead of HTML tags.
  `extract-properties.ts`'s current approach (`parsePropertyCell`: name from bold, type from
  italics, `Default:` regex) **translates directly** — swap DOM `querySelector` calls for a
  Markdown-emphasis regex.
- Section attribution ("nearest preceding heading") works the same way against Markdown
  `##`/`###` headings as it did against HTML `h1`–`h3`.
- **New risk not present in the HTML source: malformed/collided emphasis markers.** Verbatim
  example: `**check-gateway** *(none \| arp \| bfd \| ping***;** Default: **none)**` — bold and
  italic delimiters collide around the pipe-escaped enum union. HTML's `<strong>`/`<em>` never
  had this ambiguity. A naive `**...**`/`*...*` regex will mis-split this — needs a more
  forgiving extraction (e.g. strip `*` runs first, then regex the plain text).
- **Descriptions carry real relative Markdown links to other pages/anchors** (e.g.
  `[gateway reachability](../user-guides/routing-and-networking-protocols/routing-decision.md)`,
  `./dhcp.md#dhcp-server`) — richer than Confluence, which had no structured cross-page linking
  in property descriptions. A genuine upgrade opportunity, but also a new parsing task:
  relative `.md` links need resolving to either the live URL or rosetta's own page-identity
  scheme (ties to H7).
- **Admonitions are easier than Confluence's `div[role=region].confluence-information-macro`.**
  Docusaurus emits plain `:::type ... :::` (or `::::type ... ::::` nested one level) fenced
  directives — types `tip`, `info`, `warning` observed on `dns.md`. Simpler, purely textual —
  a net simplification for the `callouts` extractor.
- **Not yet assessed:** how very long pages or heavier non-property tables round-trip broadly —
  the DHCP sample had one clean non-property table, but a wider sample hasn't been checked.
  Flag as a residual unknown for the actual extractor task, not fully closed here.

#### H5 — restraml downstream-effects inventory (cross-repo, read-only)

A background read of `~/GitHub/restraml` (read-only, no changes made there) confirmed and
partly corrected this briefing's existing claim:

- **`enrich-openapi.ts` treats `pages.id`/`commands.page_id` as an opaque bound SQL parameter
  throughout** (five prepared statements joining `commands`→`pages`→`properties` purely by
  passing `page_id` from one query's result into the next). No arithmetic, no string
  formatting, no `viewpage.action?pageId=` URL construction — the emitted `externalDocs` URL
  uses `pages.url` verbatim. SQLite's weak column typing means the SQL keeps working if
  `pages.id`/`commands.page_id` become TEXT slugs, *provided both columns migrate together*.
- **The only concrete breakage found is TypeScript type annotations** (`PageInfo.page_id:
  number` and several `as {page_id: number}` casts) — a compile-time fix, not a runtime one.
- **Correction to this briefing:** it cited `rosetta-consumer.test.ts` as evidence for the
  *reverse* dependency (restraml consuming rosetta's DB). That test file actually only covers
  the *forward* direction (rosetta consuming restraml's `deep-inspect.json`) — zero references
  to `ros-help.db`, `pages`, or `page_id`. **Neither that test nor `enrich-openapi.test.ts`
  exercises the `ros-help.db`-reading path at all** (pure-function unit tests only, no DB
  fixture). The "verified circular dependency" is real code, but **untested** on restraml's
  side — a gap, not a false claim.
- **No documented schema/type contract for `ros-help.db`'s shape exists anywhere in restraml**
  (`CLAUDE.md`/`AGENTS.md`/`BACKLOG.md`/git history all checked) — the "Downstream consumer
  contract" section documents only the forward direction.
- **Risk area worth tracking:** `enrich-openapi.ts` has a title-as-path lookup heuristic
  (matching `pages.title` values that look like `/routing/bgp`) as one of its strategies. Once
  `pages.id` itself becomes a path-shaped slug, there's a possible ambiguity between the new ID
  and this pre-existing title heuristic — not a hard break today, worth re-validating once the
  new schema exists.
- **Proposed contract (posted, not yet agreed — still a proposal):** restraml widens
  `page_id`'s TS type from `number` to `string` (opaque key either way); rosetta guarantees
  `pages.url` keeps resolving; restraml adds a DB-fixture test that actually exercises
  `enrich-openapi.ts` against a sample `ros-help.db`, closing the untested-gap finding above.
  **Filed as [tikoci/restraml#85](https://github.com/tikoci/restraml/issues/85) on 2026-07-07**
  — still needs restraml-side agreement/response before it's a real contract, not just a
  proposal.

#### H6 — Non-`/docs` sections (refinement)

Refines the existing surface-inventory table above (still accurate on the sitemap/`.md`/`llms.txt`
columns):

- `/hardware` is sourced from real Markdown (`@site/hardware/**/*.md`) through a genuine second
  Docusaurus docs-plugin instance (H1) — an HTML parser remains a workable path, but
  `search-doc.json`'s flattened `content` field (H2) is a legitimate, already-published
  plain-text alternative for a first pass, at the cost of losing table structure (already true
  of `matrix.csv`'s existing structured extraction, which stays authoritative for spec fields).
- `/changelog` is confirmed as a second `plugin-content-blog` instance (`id:"changelog"`) — no
  new discovery needed for the existing RSS/delta-capture plan.
- `/blog` is the default blog instance (`blogTitle:"Product news"`), already fully described.

#### H8 — CI cross-check design (concrete proposal)

Building on this briefing's existing lean, concrete `V-*` rows to add to `VALIDATION.md` once
the Docusaurus extractor lands (naming follows the existing `V-<kebab>` convention in
`VALIDATION.md`; **none of these exist yet — do not add until the extractor task that depends on
them is in flight**):

- **`V-docusaurus-docs-count`** (blocking): exact scoped count match between `sitemap.xml`
  (`/docs/**`, excluding `/docs/tags/*`), `llms.txt` entries, and `pages` rows after extraction.
- **`V-docusaurus-cli-count`** (blocking): same, scoped to `cli-reference/*` — 236 as of this
  writing; extractor must produce exactly that many overlay rows, or fail with a diff of which
  paths are missing/extra.
- **`V-docusaurus-hardware-count`** (blocking): sitemap `/hardware/*` count (240 as of the
  morning inventory) vs. rows touched by the `/hardware` extractor.
- **`V-docusaurus-content-shape`** (non-blocking initially): fixture-based, not count-based — a
  small set of known-tricky pages (a very long page, the malformed-emphasis property pattern
  from H4, a CLI Reference page with `Conditions`/`Syscap`/`Package` all present, a `/hardware`
  page) with hand-verified expected output, diffed every extraction. Promote to blocking once
  stable.
- **`V-docusaurus-search-doc-crosscheck`** (non-blocking, informational): compare
  `search-doc.json`'s per-section URL set against extracted `sections`/`properties` anchors —
  an early-warning drift signal since it's an independent MikroTik-published inventory, but
  never authoritative on its own (it already loses structure).

### What this means for rosetta extraction

The Option D plan stands, but the input layer is much better than assumed:

1. **Prefer per-page `.md`/`.mdx`** discovered via `sitemap.xml` (or `llms.txt`) over parsing rendered HTML — that was the hoped-for "future official raw Markdown endpoint" and it now exists (for `/docs`; see the surface inventory for the rest).
2. **CLI Reference `.md` still needs a JSX-aware parser** (`ArgTable`/`ArgTableRow` props). It now has enum values/ranges/alt types, `Conditions`/`Syscap`, **and `Package`** (69/236 pages — see H3), but still lacks version provenance — so restraml `deep-inspect.json` remains rosetta's versioned command authority; treat manual CLI Reference as an official *current-manual* companion/overlay (Option C/D split unchanged, overlay design in Option D note).
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

- **Structured CLI Reference data** (JSON/YAML per path) instead of JSX-wrapped MDX, including per-version provenance. (Raised in forum #270714 post #70 "Dear @mrz".) *Enum values shipped 2026-07 in the MDX itself; package association also shipped as a `**Package:**` field — confirmed 2026-07-07, see H3 — so only version provenance remains genuinely missing.*
- **Versioned docs** beyond a single `"current"` tag. (Forum #270714 posts #58/#68.)
- **Stable, package-agnostic, path-derivable URLs** with well-known `#flags`/`#attributes` anchors. (Forum #270714 posts #58/#70.)
- **A manifest** (`docId`, `permalink`, `sourcePath`, `version`, `sha256`, `frontMatter`) would still help, but is lower priority now that `.md` + `sitemap.xml` + `llms.txt` cover discovery.
- **Machine-readable `/hardware`** (`.md` or structured data for the 240 device pages) and `llms.txt` coverage for the non-`/docs` sections. *Partial mitigation confirmed 2026-07-07: `search-doc.json` already includes flattened plain-text content for all 3,851 `/hardware/*` search-doc entries (see H2/H6) — a usable stopgap, though still not a `.md`/`llms.txt` fix.*

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

- **H1 — Site internals write-up.** ✅ **Resolved 2026-07-07** — see "Verified 2026-07-07
  (afternoon)" → H1 above.
- **H2 — Lunr/tokenizer deep-dive.** ✅ **Resolved 2026-07-07** — see H2 above (pipeline is
  `[stemmer]` only, not the lunr default; `search-doc.json` covers `/hardware`+`/changelog`+`/blog`
  too).
- **H3 — CLI Reference survey.** ✅ **Resolved 2026-07-07** — full 236-page census, see H3 above
  (notably: `Package` field exists, contradicting earlier claims).
- **H4 — Property-descriptions assessment.** ✅ **Resolved 2026-07-07** — see H4 above. Verdict:
  not the hard part it was feared to be; main new risk is malformed Markdown emphasis, not a
  structural rewrite.
- **H5 — restraml downstream-effects inventory.** ✅ **Researched 2026-07-07** — see H5 above.
  Contract *proposed*, filed as
  [tikoci/restraml#85](https://github.com/tikoci/restraml/issues/85) on 2026-07-07 — still
  needs restraml-side agreement before it's a real contract, not just a filed proposal.
- **H6 — Non-`/docs` sections plan.** ✅ **Resolved 2026-07-07** — see H6 above; `/hardware` is a
  real docs-plugin instance with two viable extraction paths (HTML parser or
  `search-doc.json` text fallback).
- **H7 — Identity / rosetta-id design.** ⚠️ **Partly resolved 2026-07-07** — schema-ripple
  analysis done (see the open question below), but the specific naming scheme is a values-based
  decision posed to the user rather than guessed.
- **H8 — CI cross-check design.** ✅ **Resolved 2026-07-07** — concrete `V-*` row proposals, see
  H8 above.

## Open questions

- ~~Does MikroTik publish the Docusaurus source content or a stable generated metadata artifact, or is rendered HTML/sitemap the only reliable public input?~~ **Answered 2026-06-02:** per-page `.md`/`.mdx`, `llms.txt`, `llms-full.txt`, and `sitemap.xml` are all published. No JSON manifest yet, but discovery is solved. **2026-07-07:** machine-readable layer covers `/docs` only — see surface inventory.
- ~~Are CLI Reference pages versioned anywhere, or are they always "current"?~~ **Answered 2026-06-02:** still a single `"current"` tag; no per-version manual copies yet.
- **Page/source identity (H7).** Existing `pages.id` values are Confluence IDs; Docusaurus pages are path-based. Observed: agents cling to whatever ID rosetta returns and quote it in prose ("confirmed from rosetta#91931"), so the ID *will* leak into human-facing text regardless. Lean: a cross-source **rosetta-id indirection table** (id → source kind, source path/URL, extraction provenance) covering every surfaced row type, giving one dereference point and a remap seam if MikroTik ever ships versioned pages. Design caution: prefer **derivable/verifiable IDs** (e.g. source-path slugs like `docs/ip/address` or prefixed slugs) over opaque numerics — agents fabricate plausible-looking numbers, and an opaque scheme makes fabricated citations indistinguishable from real ones, while a slug is self-checking against the URL it derives from. Whether `sitemap.xml` permalinks alone suffice is part of H7.

  **Schema grounding added 2026-07-07 (H7 partly resolved, one decision remains — asked of the
  user rather than guessed):** `src/db.ts` declares `pages.id INTEGER PRIMARY KEY`, and every FK
  pointing at it (`properties.page_id`, `commands.page_id`, `schema_nodes.page_id`,
  `pages.parent_id` self-ref) is `INTEGER`. Making the derivable slug *be* `pages.id` itself (the
  lean as originally written) is therefore not conceptual-only — it's a concrete DDL change
  rippling through four-plus columns and every join in `query.ts`/`mcp.ts` that assumes an
  integer page id. By contrast, `devices.id` is already `INTEGER PRIMARY KEY AUTOINCREMENT` — a
  synthetic, rosetta-native key unrelated to any external source — so devices need no identity
  migration at all. That contrast suggests a refinement:
  - **Option 1 (the lean as written):** `pages.id`/FKs become the TEXT slug directly (e.g.
    `"docs/ip/address"`). Pro: one column, no indirection. Con: the FK/DDL ripple above, and the
    "rosetta-id" becomes identical to a raw URL path rather than a rosetta-owned identifier — if
    MikroTik ever restructures URLs, every FK needs rewriting, not just a lookup-table update.
  - **Option 2 (refinement):** keep `id` columns opaque autoincrement integers everywhere (as
    `devices` already does — zero schema disruption, joins stay cheap), and add a separate
    indexed `rosetta_id TEXT UNIQUE` column that MCP/TUI surface instead of the raw integer.
    Still satisfies the original goal (a self-checking, URL-derivable citation instead of a
    fabricable opaque number) without an FK-type migration, and gives a clean remap seam
    (rewrite the `rosetta_id` value; integer joins untouched) — generalizes uniformly across
    `pages`, the CLI Reference overlay, a future `/hardware` page table, and `changelogs`.

  Either option still needs the actual prefix/naming convention decided (e.g. does a prose page
  get `docs/ip/address` or `page:docs/ip/address`; does a CLI Reference row reuse
  `schema_nodes.path` or get its own `cli/...` form). **This is a values-based decision, not a
  researchable one — see the question posed to the user in the T-0033 session that produced this
  section rather than a guess recorded here.**
- **CLI Reference argument data: promote into `schema_nodes` or separate layer?** Lean: separate version-less overlay (Option D sketch). Versioned deep-inspect stays richer where they overlap because it has version provenance and the CLI Reference's build version is unknown — even now that enum values are published, there is no version to file them under. The sharper questions are (a) surfacing the CLI Reference **URL** on command results, and (b) capturing manual-only facts like `Conditions: !smips` / `Syscap: lcd` that inspect never sees. Answer belongs to H3.
- **What CI changes catch a broken Docusaurus import (H8)?** Scoped cross-checks can be exact (fail on any mismatch) because `/docs` has three independent inventories (sitemap subset, `llms.txt`, `search-doc.json`) to reconcile against extracted pages. Deeper parse-quality checks (long pages, CLI Reference tables, `/hardware` tables) need content-shape fixtures, not just counts. `/changelog` review may also carry clues about what changed when counts drift.
- **How should old help.mikrotik.com URLs be retained?** Lean: rosetta returns **manual.mikrotik.com URLs** (plus the rosetta-id) on all results going forward; legacy Confluence URLs/IDs are kept only as historical provenance columns for the final Confluence-corpus release — no redirect machinery in rosetta. (A legacy→new link map is only worth building if H4/H5 show consumers actually hold old URLs.)

## Proposed migration task files (T-0033 closeout)

Not yet created as real `tasks/T-*.md` files — proposed here per T-0033's acceptance criteria,
to be cut once H7's naming-scheme decision lands and, for #5, once the restraml cross-repo
contract is actually agreed (not just proposed). Rosetta's own convention treats a task file as
a commitment, not a maybe, so these stay proposals until then. Each cites the B-0012 section(s)
it depends on:

1. **Docusaurus prose extractor** — new `extract-docusaurus.ts` fetching `.md` pages via
   `sitemap.xml`/`llms.txt`, replacing `extract-html.ts` for `/docs` prose. Depends on: H1 (site
   internals), H4 (property-table parsing), H7 (identity scheme, once the naming decision lands).
2. **CLI Reference overlay extractor** — populates a version-less overlay table (or
   `schema_nodes._package`/new columns) keyed by command path, per Option D's overlay sketch.
   Depends on: H3 (full census — `Package`/`Conditions`/`Syscap`/enum findings), H7.
3. **`/hardware` extractor** — HTML parser (or `search-doc.json`-text fallback per H2) feeding
   `devices`/a new hardware-page table. Depends on: H1/H2/H6.
4. **`/changelog` watcher** — RSS-driven delta capture, CI trigger already tracked in
   `BACKLOG.md` Triggers ("Manual doc-changes watcher"). Depends on: H6.
5. **restraml page-identity contract** — cross-repo task (partly lives in `tikoci/restraml`) to
   land the H5 proposed contract: widen `page_id` TS types there, add a DB-fixture test
   exercising `enrich-openapi.ts` against a sample `ros-help.db`. Depends on: H5, H7. Proposal
   filed as [tikoci/restraml#85](https://github.com/tikoci/restraml/issues/85) — cut this task
   once restraml responds/agrees.
6. **MCP/TUI source-typed results (Option F)** — result-shape rework so the above land through
   forms agents can actually use, not bolted onto page-shaped output. Depends on: #1–#5 landing
   first, per this briefing's existing "alongside the extractor, not an afterthought" framing.

The H8 `V-*` rows are not a standalone task — fold each into the acceptance criteria of the
task that makes it true (e.g. `V-docusaurus-docs-count` belongs to task #1).

**Sequencing gate still applies:** none of the above may start until the final
help.mikrotik.com-corpus NPM release ships (`BACKLOG.md` Triggers) — this proposal list is
research output, not a green light to start extractor work.
