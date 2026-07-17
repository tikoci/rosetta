# Changelog

All notable user-visible changes to `@tikoci/rosetta` are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); project
uses [Semantic Versioning](https://semver.org/).

> **Agentic rule.** Any change with a user-visible effect (CLI, MCP tool shape,
> DB schema, CI behaviour, install flow) adds an entry under **[Unreleased]**
> in the same PR / commit. Promoting `[Unreleased]` to a dated version header
> is a manual step, done by hand alongside the `package.json` version bump
> before dispatching a latest-channel release (see `MANUAL.md` "Release
> Workflow") — CI no longer auto-bumps versions or auto-promotes CHANGELOG on
> any channel. Prerelease (`alpha`/`beta`/`rc`) release runs never promote
> `[Unreleased]` either, since they don't represent the next stable version.
> CI-only auto-bumps and pure refactors with no external effect are
> intentionally omitted — git history is authoritative for those.
>
> **Not a git log.** Don't list every commit. One bullet per behaviour change,
> grouped under `Added` / `Changed` / `Fixed` / `Removed` / `Deprecated` /
> `Security`. Details and rationale belong in `DESIGN.md`; the "what's next"
> backlog belongs in `BACKLOG.md`.

## [Unreleased]

### Added

- **New `rosetta export <dir>` command writes a DB-only dataset directory for local audit** (issue #101, the B-0022 export track). Produces `manifest.toml` plus seven flat TSVs — `changelog.tsv`, `callouts.tsv`, `properties.tsv` (joined to pages with a resolved `section_anchor`), `videos.tsv` (metadata + per-video transcript segment/word/byte counts), `commands.tsv`, and the paired `pages.tsv` (one row per page) / `sections.tsv` (one row per section, pivot-able) — from the runtime SQLite database alone — dataset generation reads only the resolved DB, with no caches or re-extraction (startup may still download/refresh the DB, as every command does). The serialization contract is a reversible Postgres-COPY-style escape (`\t`/`\n`/`\r`/`\\` backstopped on every value, whole-field `\N` for SQL NULL as distinct from the empty string) with stable ordering so a rebuild on the same DB is byte-identical, and `manifest.toml` carries `db_meta` provenance, per-file row counts, and honest disclosures of what the DB cannot provide (transcript provenance #21, per-version architecture #91). A column the DB cannot produce is omitted and disclosed, never recovered from a source artifact.

- **Every Docusaurus pipe table is now retained as normalized, queryable data in schema v10** (issue #92). `page_tables` keeps raw Markdown plus page order, nearest h1–h6 heading, enclosing h1–h3 `section_id`, width, and raggedness; `page_table_rows`/`page_table_cells` preserve every header/data cell at its actual width with escaped pipes decoded. Table-derived `properties` now point to their exact source row through `source_table_row_id`, while bullet-derived and historical properties remain honestly NULL. Property output is byte-for-byte unchanged; the shared fence-aware parser also corrects the B-0022 census counting error caused by an ordered-list code fence in `zerotier.md` (the rc.98 corpus contains 855 tables / 8,287 data rows, not 852 / 8,258).

- **README.md and DESIGN.md now describe the live Docusaurus corpus as current, not a pending migration** (issue #77). README's intro and "What's Inside" table dropped the "still needs a major migration away from the retired Confluence export" framing and refreshed prose-corpus figures for the actual Docusaurus build (363 pages/~653K words, 4,402 properties, 943 callouts), and gained a "Hardware overlay" row for `hardware_catalog`/`device_aliases` (255 devices incl. legacy/EOL + accessories, ~750 alias mappings) that was previously absent from the feature list entirely. DESIGN.md's "Corpus Snapshot" section is retitled "Historical Corpus Snapshot (legacy Confluence)" to stop reading as current-state to a skimmer; its already-caveated legacy figures are otherwise untouched.
- **YouTube transcript cache refreshed — 538 → 658 videos, ~2,090 non-empty transcript segments.** `make extract-videos` picked up a large backlog of previously-unswept videos (not just the handful published since the last 2026-07-07 sweep), converging over several incremental reruns as transient yt-dlp/YouTube request failures cleared on retry. Three genuinely non-English videos (Finnish, Russian, Japanese) that fail every run because YouTube has no English auto-captions for them are now recorded in `transcripts/known-bad.json` so future sweeps don't keep re-attempting them.

- **Retrieval-quality net hardened for the 0.11 corpus swap — golden set 24 → 35, plus a direct-surface eval matrix (issue #53).** The Phase 0 golden set (`fixtures/eval/queries.json`) grows by 11 hand-verified queries: +2 natural-language (`pppoe`, `dns`), +4 property, +3 changelog (fixed-CVE / feature-introduced / version-scoped), +2 video — closing the zero-coverage gap on property/changelog/video retrieval that the Confluence→Docusaurus swap left untested. `src/eval/retrieval.ts` gains a per-query `surface` field: `search` (default) still drives the durable `routeros_search` recall/MRR/classifier gate (the entry point most exposed to the swap), while `property`/`changelog`/`video` dispatch to the dedicated tools (`lookupProperty`/`searchChangelogs`/`searchVideos`) and feed a **separate, informational `surface_matrix`** (per-surface hit@5) kept out of the gated aggregates so those stay sensitive — a starting coverage board to grow over time. Golden `_thresholds` recomputed for the larger set (0.88/0.82/0.75/0.90; the old 0.85/0.70/0.65 had drifted loose over 27 search queries — the 2pp regression check vs `baseline.json` remains the tight forward guard). Both `baseline.json` and the **stale April-2026 Confluence-era `self-supervised-baseline.json`** regenerated against the live Docusaurus corpus. Grounded audit (0.10.0 vs current compare-and-contrast via the new one-off `src/eval/corpus-compare.ts`, blocking self-eval rehearsal, and an ETL Bug Ledger) recorded in `briefings/B-0020-0.11-retrieval-quality-audit.md`: **no net retrieval regression from the corpus swap** (14/16 topic-hit on both corpora; existing golden set 91.7% Recall@5 on Docusaurus), and #26's two "regressions" confirmed to miss on 0.10.0 too (pre-existing query-core weakness, not swap-induced). Queries that legitimately fail today stay pointed at the correct answer and fail loudly — no fixture was loosened to green the board.
- **Hardware overlay Phase 2A — `hardware_catalog`/`device_aliases` now drive device lookup and enrichment (MCP + TUI).** `routeros_device_lookup` and `routeros_search` resolve devices from free-form input far more accurately: an **alias stage** (exact-normalized, authoritative — never fuzzy) maps product codes, old names, and www/hardware slugs the matrix name misses to the canonical device (`cap_ac`→cAP ac, `RB750Gr3`→hEX), reported as `mode: "alias"` with the `matched_alias`. A single matrix-linked result now carries a compact **`hardware` overlay block** — `rosetta_device_id` (stable, persistable key), `category`, `discontinued`, `also_known_as` (name-like aliases only; slug/table artifacts excluded), genuine `non_default_ips`, and reconstructed `product_page_url` (mikrotik.com/product) + `hardware_page_url` — whose `note` steers agents to the device tool rather than fetching a page. Non-matrix entities (accessories, series, legacy/EOL) surface in a new `catalog` array as labeled thin rows with a `kind` field (`accessory`/`series`/`discontinued`/`device`), so an agent never mistakes a GPeR for a router. The classifier gains catalog-prominent families (Chateau, Audience, OmniTik, PowerBox, KNOT, Cube, DISC) plus a whole-input alias probe in `searchAll` for bare codes the regexes miss; `routeros_search`'s `related.devices` now carries `category`/`discontinued`; the browse TUI device card shows the overlay and a thin-row variant for catalog entities, and its stats screen lists the two overlay tables. No `/hardware` prose enters the FTS corpus (fields only). Reads the clean data from the #47/#48 cleanup. See `briefings/B-0019-hardware-overlay-phase2-mcp-tui-surfacing.md` and issue #49.
- **New Docusaurus `/docs` prose extractor (`extract-docusaurus.ts`) replaces `extract-html.ts` as the default prose source.** Discovers pages via `sitemap.xml`, fetches raw Markdown from manual.mikrotik.com, and populates `pages`/`sections`/`properties`/`callouts` — 360 in-scope `/docs` pages as of 2026-07-07 (CLI Reference and `/hardware` remain out of scope, tracked as follow-up work). `make extract`/`make extract-full` now run it by default; the legacy Confluence pipeline survives as `make extract-legacy-confluence` for rebuilding historical release DBs.
- **New `pages.rosetta_id` column** (schema v6) gives Docusaurus-sourced pages a stable, URL-derived identifier alongside the existing integer `id` — see `DESIGN.md` and `briefings/B-0012-docusaurus-manual-migration.md` "H7 — Identity / rosetta-id design".
- **npm prerelease dist-tag channel.** Testers can now opt into an in-progress build via `bunx @tikoci/rosetta@next` (newest prerelease of any stage) or `@alpha`/`@beta`/`@rc` (pinned to one stage), without moving the default `latest` channel. Channel is driven entirely by `package.json`'s committed version (a `-alpha`/`-beta`/`-rc` suffix means prerelease); OCI image tags (`:alpha`/`:beta`/`:rc`/`:next`) mirror the same scheme, and the bare `:latest` OCI tag now never moves on a prerelease release run. See `README.md` "Prerelease channels" and `MANUAL.md` "Release Workflow".
- **`bun test --coverage` now runs on every release build**, summarized in the workflow's step summary and uploaded as a `coverage-lcov` artifact — informational only, not a gate.
- **New `hardware_catalog` + `device_aliases` tables + `device_overview` view (schema v8) overlay `manual.mikrotik.com/hardware` and `mikrotik.com/product/<code>` onto the existing `devices` data.** `hardware_catalog` is a superset of `devices` — it also covers accessories and legacy/EOL SKUs `matrix.csv` doesn't track, carries a never-null display `name`, an optional `device_id` link back (renamed from `devices_id` to match `device_test_results.device_id`) for the ~156 rows matrix.csv already knows about, and lands each device's non-default management IP and FCC/IC regulatory IDs into `specs_json`; `devices` itself is unchanged. `device_aliases` resolves every observed slug/code/name variant (matrix.csv, `/hardware` slug/link/table code, www requested/declared/compare code) back to one rosetta-curated `rosetta_device_id`, with priority-ranked, collision-counted assignment so no code is silently claimed by the wrong device. `device_overview` is the documented read surface (catalog + devices spec columns + alias counts). A www product is only accepted as a device's spec source when its own identity agrees with the device's code/slug family (killing cross-sell misattribution such as a mounting bracket's specs landing on a cube page), attaches to at most one row outside a tiny justified shared-kit allowlist, and a declared-code matching tier resolves ROSE Data server and both KNOT Embedded LTE4 rows. Built by the new `src/extract-hardware-catalog.ts`, now wired into `make extract`/`make extract-full` and the `release.yml` extraction pipeline (ordered after `extract-devices`, which wipes both tables) so the catalog + aliases **ship in the published DB**; a release is blocked if the DB carries fewer than 200 `hardware_catalog` or 600 `device_aliases` rows. It emits a committed, deterministic `fixtures/hardware-catalog/catalog.json` (sorted rows + aliases + drop ledger — the change-review diff gate), enforces hard output invariants (declared code present in own aliases; one www product per row; every input entity attached or dropped-with-reason), and fails loudly — DB untouched — on category-taxonomy drift, a www page-template change, matrix coverage regressing, a previously-resolved device disappearing, an alias-collision/drop surge, or a www 404-rate swing. See `briefings/B-0017-hardware-overlay-device-resolution.md` and issue #35. MCP/TUI surfacing of this data is deferred to a follow-up (B-0017 "Phased implementation plan," phase 2).

- **New scheduled `Device Map Refresh` workflow (`device-map-refresh.yml`) watches for upstream hardware-page drift.** Weekly cron (+ manual dispatch) does a LIVE re-scrape of manual.mikrotik.com `/hardware` and mikrotik.com `/product` via `make assess-hardware assess-www device-map` — the network path `test.yml`'s per-PR drift gate deliberately never runs. It *detects* drift only: when the regenerated artifacts differ from the committed snapshot (or a device no longer resolves without a `device-exceptions.toml` entry), it fails the run (red check + scheduled-failure notification), uploads the regenerated artifacts, and opens/refreshes a single tracking issue with a diff-stat summary; the full diff is in the run logs. A human then resolves it through the normal flow — regenerate locally, review per `briefings/B-0018` "How to audit", open a standard PR that runs the required `device-map-check` gate. Closes the "how do we notice MikroTik added/moved/removed a page" half of B-0018's audit loop that the committed-snapshot coherence check can't cover on its own.
- **Reviewable device→URL map + drift gate (`make device-map`).** `device-map.tsv` (one row per matrix device → `/hardware` + www URLs, with a `needs_review` column) and `hardware-unmatched.tsv` (the reverse audit view: `/hardware` pages with no matrix device), backed by a curated `device-exceptions.toml` and a blocking drift gate (`make device-map-check`) that fails when a device stops auto-resolving without an exception, a curated exception goes stale, or a committed artifact drifts from freshly computed output — now run on every PR via `test.yml` (no network; validates only the committed snapshot). Human/MikroTik-readable legend in `briefings/B-0018-product-naming-three-source-map.md`.
- **New `QA` workflow (`qa.yml`) rehearses the release-locked quality gates without publishing** (issue #40, B-0014 Option B). A `workflow_dispatch` + `workflow_call` workflow that runs the checks previously provable only inside `release.yml` — DB content floors (incl. the hardware-overlay `hardware_catalog`/`device_aliases` floors), MCP contract, golden + self-supervised retrieval eval, docs-count, device-map drift, and `db_meta` provenance — against a freshly built (`db_source: local-build`) or published DB, on any ref, with **no npm publish, OCI push, or GitHub Release**. Focused dispatch via `test_scope` (single gate or `all`), `db_source`, `full_versions`, and `eval_self_blocking` (flip the self-supervised eval to a hard gate on demand). This is the intended way to verify release-pipeline changes — such as the hardware-overlay extraction wired in this same release — before an actual dispatch. **`release.yml` now calls this workflow directly** (issue #42): its single `build-and-release` job was split into `build` → `qa` (`uses: ./.github/workflows/qa.yml` with `db_source=artifact`) → `publish`, so the gates that fence a release are byte-for-byte the ones a `qa.yml` dispatch runs against the exact DB about to ship — one definition, no drift (the old cross-file floor guard is gone). See `MANUAL.md` "Release Workflow" / "Rehearsing release quality gates without publishing" and `VALIDATION.md` `V-qa-rehearsal`.

### Changed

- **`rosetta export` output shape refined so the two page-level files read cleanly and the section rollup reconciles** (issue #106, post-#103 per-TSV review; part of #95). The per-section file is renamed `pages.tsv` → **`sections.tsv`** and the per-page rollup `pages_summary.tsv` → **`pages.tsv`**, so each filename now matches its source table like every other dataset (`changelog`←`changelogs`, `callouts`←`callouts`, …); grouping `sections.tsv` by `page_id` in a spreadsheet pivots up to (near-)the `pages.tsv` word count, the small residual being heading-text lines that live in no fragment (disclosed in the manifest). `callouts.tsv` gains `rosetta_id` (page) and resolved `section_anchor` columns so a reader identifies the owning page/section by name without joining back to the DB — the same pairing `properties.tsv` already emits — with the long `content` field moved last. `changelog.tsv` moves `sort_order` before `description` for the same long-column-last reason. No schema change, no re-extraction, no MCP/TUI change; the export still reads the DB alone and rebuilds byte-identically. `MANUAL.md` updated.
- **Section coverage of a page is now (near-)total — a synthetic lead ("H0") fragment captures pre-first-heading prose** (`briefings/B-0023-page-section-normalization.md`, part of #95). `parseSections` split the page body only on h1–h3, so the lead-in prose before the first heading — an AI-summary blockquote, an intro paragraph, and the *entire* body of pages whose only heading is the title — belonged to no `sections` row: 11.7% of the corpus by word, and 40 whole pages, had no section to resolve to and didn't roll up to the page total. Each page with non-empty lead prose now gets a lead fragment (`level = 0`, reserved `anchor_id = "_lead"`, heading = the page title) holding that content, so section words cover ~98% of page words (the residual is heading-text lines, which belong to no fragment) and every table/callout/property before the first heading resolves to a real `section_id` instead of NULL (measured on the local corpus: tables/properties/callouts with no section context all drop to 0). A page whose only pre-heading line is the title mints no lead fragment (no empty fragments). No schema DDL change (the `sections` table already stores `level`/`anchor_id`), no MCP tool-surface change; the `rosetta export` `pages.tsv`/`sections.tsv` rollup and the `section_id` disclosure reflect the fuller coverage.
- **`hardware-unmatched.tsv` reframed as a classified inventory — new `kind` column.** Every `/hardware` page with no matrix device is now labeled `device` / `accessory` / `module` / `series-or-doc` (67/12/8/15 of the current 102) by a shared, rule-based classifier (`src/hardware-kind.ts`), so the reverse-audit set is a typed inventory rather than an undifferentiated pile: `kind = device` isolates real off-matrix routers worth filing as matrix gaps, while `series-or-doc`/`accessory`/`module` are expected non-devices to skip. Classification carries a single per-slug override today (`nray-series` → `device`; one kit, not a family — see the wiring entry below), and the logic is shared so a future `include-accessories`-style filter or "include module" cross-link reuses it instead of re-deriving. Regenerated deterministically by `make device-map`; validated by the existing `device-map-check` gate. See `briefings/B-0018-product-naming-three-source-map.md`.
- **`hardware-unmatched.tsv` now shows the ETL www-spec mapping status — new `www_code`/`www_specs` columns.** Each off-matrix `/hardware` page now records which `mikrotik.com/product` code the catalog actually pulled specs from and how many real fields it captured, read from the committed `fixtures/hardware-catalog/catalog.json` so the file view matches the DB rather than approximating it (no DB or network dependency in the drift gate). A blank `www_code` means the ETL mapped no marketing product to that page: filtering `kind = device` + blank `www_code` yields the concrete **spec-backfill worklist** (15 real devices as of 2026-07-13 — `dynadish-6`, `sxt-2`, `chateau-lte6`, the `ltap-lr8-*` LoRa kits, …), each of which usually *does* have a product page `assess-www` simply never fetched. `make device-map` reads `catalog.json` when present (blank columns + a console note if absent); the feedback mechanism to close the gaps is tracked in #70. See `briefings/B-0018-product-naming-three-source-map.md`.
- **Curated `hardware-www-map.toml` wired into the ETL — off-matrix spec gaps closed (device gaps 15 → 4; #70 first task).** The maintainer answer-key of `/hardware`-slug → `mikrotik.com/product` codes the auto-resolver can't derive (e.g. `sxt-2`→`RBSXTG-2HnDr2-168`, `dynadish-6`→`dynadish_6`) now feeds two ETL points through a shared loader (`src/hardware-www-map.ts`): `assess-www` seeds every code into its candidate fetch, and `extract-hardware-catalog` force-attaches single-code products to their row past the identity-agreement gate (a human vouched for them). 14 off-matrix devices that shipped with no specs — `sxt-2`, `dynadish-6`, `cube-60g-ac`, `chateau-lte6`/`-lte12`, `intercell`, `lhg-xl-2`, `wireless-wire-cube`, … — now carry full spec sheets in `hardware_catalog`; the reverse-audit spec-backfill worklist (`kind = device` + blank `www_code`) drops from 15 to 4, the remainder being genuinely un-single-attachable (`seed_only` module/kit pages whose identity is owned by the kits that embed them, and series-style multi-variant pages — both still fetched for the deferred surfacing work). All 65 curated codes were cross-checked against `mikrotik.com/sitemap.xml`. `nray-series` reclassified `series-or-doc`→`device` (one kit, not a family). Baseline canaries updated for the +52 seeded products (dropped-www 30→67, all accounted in the drop ledger; matrix coverage unchanged). See `briefings/B-0018-product-naming-three-source-map.md` and issue #70.
- **Hardware-overlay data-quality follow-ups (B-0017 items 1–2), before Phase 2 surfacing.** Two extract-time filters clean `device_aliases`/`hardware_catalog` so any consumer can trust them without re-deriving classifications: (1) a `hardware-link` alias whose token names a **dropped** www product is dropped as cross-sell pollution (e.g. `qm_x`→sxtsq-5-ax, `mant_lte_5o`→chateau-lte12) — a device's `/hardware` page merely *linking* an accessory no longer leaves that accessory code as the device's alias; standalone series pages (`hw-*-series`) stay exempt since they legitimately claim member/kit codes (`wap_60g`→hw-wap-60g-series). (2) `specs_json._non_default_ips` now keeps only genuine subnet deviations (outside `192.168.88.0/24`) — same-subnet `.88.x` secondaries are filtered, shrinking the field from 63 rows to 11 (the `192.168.188.1` embedded-LTE cluster + intercell + woobm-usb). Both are proven by new `checkInvariants` probes (#8/#9) and anchor tests; `fixtures/hardware-catalog/catalog.json` moves once (20 cross-sell aliases removed, 16 collisions cleared). See `briefings/B-0017-hardware-overlay-device-resolution.md` "Lingering data-quality items" and issue #47.
- **`/hardware` ↔ matrix.csv matcher correctness fixes** (feeds `hardware_catalog`). Canonical matching (`canon`/`canonNoRev`/`canonForms`) with `code > slug > table` precedence, cross-page table suppression, a shared-`&`-base guard, a bogus-accessory-link filter, and an own-slug collision guard (kept only when corroborated or title-agreeing). Fixes previously wrong binds — Chateau LTE7/LTE12 → `chateau-lte6-us`; `R11e-LR8`/`-LR9` → `wAP LR2 kit` (a `canonNoRev` over-strip); `/hardware/hap-ax-2` (titled hAP ax³) also claiming hAP ax2 — and regenerates `ros-hardware-assessment.json` + the `hardware_catalog` overlay accordingly. Anchor-tested in `src/assess-hardware.test.ts`. See `briefings/B-0018-product-naming-three-source-map.md`.
- **Relative Markdown links inside property descriptions now resolve to live `manual.mikrotik.com` URLs** instead of being left as broken relative paths once extracted out of their source page.
- **`release.yml` CI now builds the DB from the live Docusaurus extractor, not the legacy Confluence HTML export.** The `html_url` workflow input is gone; a new `extract-docusaurus.ts --check-counts --strict` step proves the docs-count invariant on every release run instead of only in manual/local runs. Rebuilding a historical pre-migration DB remains possible via the local-only `make extract-legacy-confluence` target — it is no longer reachable from CI.
- **Work tracking moved from in-repo `tasks/T-*.md` files to GitHub Issues.** Issues start as discussion and earn the `agent-ready` label once acceptance criteria settle; `umbrella` marks theme-tracking issues and `blocked` marks named waits. PRs close issues via `Closes #N`, and partial landings must spawn follow-up issues before merge (new `issue-pr-linking.instructions.md`). `tasks/` is now a frozen archive; the 17 remaining active task files were closed with per-file disposition notes (superseded / won't-fix / migrated to an issue) in tasks/done/T-*.md. See issue #18.
- **Release version bumps are now a manual step for every channel, including `latest`.** CI's old `bump-version` job (blind `PATCH + 1`, auto-committed straight to `main`) is gone entirely — it couldn't reason across the new prerelease channels. A new preflight fails a latest-channel release if `CHANGELOG.md` lacks a `## [<version>]` heading for the bare `package.json` version being released, so CHANGELOG promotion can't be skipped by accident. See `MANUAL.md` "Version bumps are a manual step".
- **`make lint` (and `test.yml`'s Lint step, now `make lint`) covers Markdown and spelling, not just Biome.** Adds `markdownlint-cli2` (config in `.markdownlint-cli2.yaml`, rules shared with the IDE via `.markdownlint.yaml`; LLM instruction files, `briefings/`, `tasks/`, `fixtures/`, and the `manual/` cache excluded) and `cspell` (`cspell.json` + a seeded `project-words.txt` RouterOS/tikoci dictionary) as `bun run lint:md` / `lint:spell`, so local `make lint` and CI check the same three things. `release.yml`'s fast-fail Lint stays Biome-only.

### Fixed

- **165 properties were silently destroyed on every build; `properties` and `callouts` now carry a real `section_id` (issue #90, schema v9).** `properties.section` stored **heading text**, and `UNIQUE(page_id, name, section)` plus `INSERT OR IGNORE` dropped any property whose page repeated a heading — the shipped `v0.11.0-rc.97` DB holds 4,416 of 4,581 parsed properties, and nothing logged the gap (the extractor's own "Properties:" line counted *attempted* inserts, so it reported rows the DB did not contain). `ppp-aaa` alone lost most of its user/profile properties to its four `Properties` headings. A corpus-wide measurement showed the obvious fix is insufficient: keying on `section_id` still destroys 87 rows, because the manual documents one property name several times *within a single section* (`dot1x` defines `interface` twice under `Server` — once for the server table, once for the client one), so section is not an identity at all. **The constraint is therefore removed**, not re-keyed; extractors now assert parsed == stored and fail the build on any gap (`V-extractor-no-silent-drops`). All 4,575 parsed properties are stored, and the 141 distinct properties the constraint had been eating — `name` = "Name used for authentication" and friends — are searchable for the first time. `properties.section_id` and the brand-new `callouts.section_id` (callouts previously had no section attribution whatsoever) resolve for 99.7% and 89% of rows respectively; the remainder are genuinely above any heading and stay NULL rather than being forced into a section. Property→section attribution rises from 72% resolvable to 99.7%. A property under an h4–h6 folds to its enclosing h1–h3 section, so `sections` remains the retrieval unit and `routeros_get_page` is unchanged; `section` keeps the raw h4 text, so the finer heading stays recoverable.
- **`routeros_lookup_property` and `routeros_search`'s `related.properties` now return `section_anchor`, which finally makes same-named properties tellable apart** (issue #90). Storing every property surfaces a fact the old constraint hid by deleting it: 111 name/section groups (276 rows) are *indistinguishable* by `section`, because it holds heading text that repeats — a `lookup_property(name="name")` on PPP AAA returns three rows all reading "Properties", meaning the profile name, the login name, and the active-user name. `section_anchor` carries the section's `anchor_id` (`properties`, `properties-1`, `properties-2`), which is unique within a page and feeds straight back into `routeros_get_page(page, section=…)` to read that exact fragment — the workflow the tool description now spells out. Null when a property sits above any heading.
- **`bunx`/global-install DB staleness across same-schema releases (e.g. `0.11.0-beta.92` → `beta.93`, or any future patch that doesn't bump `SCHEMA_VERSION`) is now self-healing** (issues #76, #23). `ensureDbReady()`'s redownload check widens from "schema version differs" to also compare `db_meta.release_tag` against the running package's own version — the new `checkDbFreshness()` (`src/setup.ts`) — since `dbDownloadUrls()` already resolves a version-pinned DB per exact release and `stamp-db-meta.ts` already stamps the matching tag; the missing piece was that `ensureDbReady` never looked at it. A local repro (documented on #76) confirmed bunx re-resolves the registry manifest fresh, unconditionally, on every invocation, so the running package version is always current — only the cached DB could go stale. Dev-mode checkouts are exempt (a locally-extracted DB's `release_tag` is expected to drift from `package.json`'s in-progress version and must never trigger a network fetch). A release-tag-only mismatch (schema still current) that fails to redownload — e.g. offline — degrades gracefully to the existing, still-queryable DB with a warning instead of crashing startup; only a genuine schema mismatch remains a hard failure.
- **New `ROSETTA_OFFLINE=1` environment variable** short-circuits all DB freshness network attempts instead of letting them time out. A release-tag-only mismatch falls back to the existing DB with a warning (same as an unintentional offline failure); a genuine schema mismatch, or no DB at all, still fails hard — offline can't fix either. See `MANUAL.md` "How Updates Work".
- **New `bunx-upgrade-smoke` release CI job** closes the gap `bunx-smoke` couldn't cover: it only ever installs onto an empty cache, so it never exercised the actual upgrade path. The new job seeds a real `bunx`-installed DB from the previously-published version on the same dist-tag, then invokes the just-published version bare (no `--refresh`) and asserts the startup banner shows the new release — proving `checkDbFreshness` actually self-heals a live install, not just its unit tests. Also exercises `ROSETTA_OFFLINE=1` against that same stale DB to prove the graceful-degradation path end to end. Runs on macOS/Linux/Windows; skipped when there's no prior publish yet on that channel (issues #76, #23).
- **Device search resolves concatenated product-name spellings — `hapax3` now finds hAP ax³** (issue #67). The whole separator-free class (`hexs`, `capax`, `chateaulte12`, `fiberboxplus`, …) previously fell through every stage: `device_aliases` stored `hap ax3`/`hap_ax3` but never the concatenation, and the `searchDevices` stage written for exactly this case (a slug-normalized LIKE over `devices.product_url`) was dead in production — no extractor populates `product_url`, only the test fixtures did. `extract-hardware-catalog.ts` now derives a `canon()`-collapsed alias (source `collapsed`, lowest rank, zero cross-device collisions) from every surviving *name-bearing* alias, plus a standalone `hw-<slug>` row's own page slug (its only identity — how `chateaulte12` finds the catalog-only original Chateau LTE12); `hardware-table` codes and matrix-linked rows' page slugs stay uncollapsed so hAP ax³'s disambiguation slug `hap-ax-2` can't claim `hapax2` from the real hAP ax². Read side, both alias probes (`searchDevices` stage 1.5 and `searchAll`'s whole-input probe) fall back to the collapsed query key, so any separator spelling (`hap.ax3`, `hap-ax3`) resolves as `mode: "alias"`; a new per-token probe in `searchAll` surfaces a device mentioned inside prose ("hapax3 wifi settings") for tokens that look like model spellings (digit or code separator — bare English words that double as product names stay regex-gated on their styled form). Derived spellings resolve lookups but never appear in `also_known_as`; the dead `product_url` LIKE stage is removed. MCP + TUI both inherit via the query core.
- **Category/index pages no longer arrive content-free — leaked `<DocCardList />` is now expanded into a real child-link list** (issue #65). manual.mikrotik.com's Docusaurus `.md` (`llms.txt`) output emits the `@theme/DocCardList` component unrendered, so ~50 index pages (e.g. `bgp.md`) reached the corpus as a bare tag plus its `import` line with their entire child-page navigation missing — the one MDX leak that is real data loss rather than cosmetic scaffolding. `extract-docusaurus.ts` now reconstructs the list from the rosetta-id path tree it already holds (a pre-parse pass, so links flow into `pages.text`/`sections` like ordinary prose), rendering each direct child as `- [Title](url) — summary` sorted by title. Honest fallback: a `<DocCardList />` with no discoverable children is left untouched rather than silently erased. Upstream MDX passthrough (imports, `WideTable`, `Tabs`, `:::` admonitions) is characterized in #65 and intentionally left as-is — readable or no data loss. Reported to MikroTik; this is the local stopgap.
- **Classifier no longer turns natural-language prose into a bogus command path** (issue #59, BL-4 from `briefings/B-0020`). A no-slash question whose first word happens to be a top-level menu (`port forward to an internal server`, `port 8291 access`) was greedily pathified by the canonicalizer into `/port/forward/to/an/internal/server` at *medium* confidence, because `detectCommandPath` in `src/classify.ts` runs the (DB-less, tree-unaware) canonicalizer on any input starting with a top-level word. The no-slash branch now only treats the input as navigation when **every** trailing token is a bare menu segment (`^[a-z][a-z0-9-]*$`, not a prose stopword like `to`/`an`/`from`); a stopword or non-identifier token means it's a question and it's left for FTS instead. Legit space-separated navigation is unaffected (`ip firewall filter`, `interface wifi`, `routing bgp`, `port`). Pinned by a classifier-only golden anchor (`cmd-path-nl-not-a-path`, using a new `expected_classified` `null` = "must be absent" convention). Being a pure heuristic without command-tree access, two clean prose tokens can still slip through (`port forwarding`→`/port/forwarding`); a tree-validated post-check in query-core is the deeper fix, deferred. Retrieving the NAT/port-forwarding page for such verbose NL is the separate #26 FTS-candidate-pool weakness, not this bug.
- **Command→page linkage now ranks candidates instead of picking an arbitrary one, fixing wrong-page property lookups on core menus** (issue #58, BL-1/BL-2 from `briefings/B-0020`). `link-commands.ts` collected every page that merely *mentions* a command path in a code block, then linked `commands.page_id` to `candidatePageIds[0]` — the first in insertion order — so on the Docusaurus corpus **433 of 493 linked dirs (88%) pointed at an unrelated page** (`/ip/firewall/filter`→l3-hardware-offloading, `/ip/dhcp-server`→hotspot, `/ip/service`→containers). The pick is now the *authoritative* page: the one whose own `/docs/` slug (or breadcrumb) trails the command path (new pure, unit-tested `src/link-ranking.ts` — contiguous trailing-segment match anchored at the leaf, prefix-tolerant so `/ip/dhcp-server`↔`.../dhcp` still matches; property count only tie-breaks among aligned pages). A command with **no** aligned page is left unlinked rather than mis-linked, so `routeros_lookup_property` falls back to an honest low-confidence global search instead of resolving *high*-confidence to the wrong page. Effect: aligned links ~2× (60→111), and real properties that exist now resolve high-confidence to the correct page (`/ip/dhcp-server lease-time`, `/ip/ipsec/peer exchange-mode`, `/ip/dns servers`) while the existing clean anchors (`prop-wireguard-listen-port`, `prop-vxlan-vni`) stay green. Properties the new manual documents only as prose (firewall `action`, BGP `distance`) and dotted/nested wifi properties remain unresolved — a separate property-extraction/CLI-Reference-overlay concern tracked apart from linkage.
- **Flaky CI: two timer/IO-bound `src/setup.test.ts` cases (`waitForUsableDb returns true…`, `probeDb closes statements…`) no longer trip bun's default 5s per-test timeout under GitHub shared-runner contention** (issue #32). Both resolve in a few hundred ms locally but do real `setTimeout`/`bun:sqlite` file I/O; each now gets an explicit 15s bun-level timeout (well above its own 2s internal deadline) so runner jitter can't fail them without weakening any assertion.

- **`release.yml`'s first real `0.11.0-alpha` dispatch (2026-07-09) failed at "Run tests (fast-fail)" despite 0 failing tests** (649 pass / 0 fail). Root cause: `bunfig.toml` carried a long-dormant `[test].coverageThreshold = { lines: 0.70, functions: 0.80 }` (present since April 2026, never actually exercised because `test.yml` never ran `bun test` with `--coverage`) — the first time `--coverage` ran anywhere in CI was `T-0037`'s new step, and real coverage (55.64% lines / 62.78% functions) tripped the dormant threshold, failing the whole release despite every test passing. `bunfig.toml`'s threshold is removed — coverage reporting is informational only, per `VALIDATION.md` `V-coverage-reported`, and should never gate on its own. Also hardened `release.yml`'s error reporting so a real future failure of this kind is self-explanatory instead of a bare "Process completed with exit code 1": the "Run tests (fast-fail)", "MCP contract tests (real DB)", and "MCP retrieval eval (Phase 0)" steps now each emit an explicit `::error::` annotation distinguishing an actual test failure from a nonzero exit with no failing tests reported.
- **Phase 0 golden-query retrieval eval (`src/eval/retrieval.ts`, `fixtures/eval/queries.json`) now matches on `pages.rosetta_id` instead of the numeric `pages.id`.** `extract-docusaurus.ts` re-mints `pages.id` as a fresh rowid on every run, so the golden set's old Confluence-era numeric ids could never match again after the `T-0036` cutover — this is what failed `release.yml`'s "MCP retrieval eval (Phase 0)" step on `T-0037`'s first real dispatch (all 12 `nl-question` queries scored 0% recall) even though `routeros_search` was actually finding the right page for 10 of the 12. `fixtures/eval/baseline.json` regenerated against the live Docusaurus corpus. Two real ranking regressions the fixture fix uncovered (a firewall-filter query and a BGP-peering query both miss their real page) are left failing visibly in the eval's per-query output rather than papered over — tracked by `tasks/T-0038-docusaurus-retrieval-ranking-regressions.md`.
- **Release skill and command-tree extraction now use authenticated GitHub API requests with retry handling.** This avoids shared-runner unauthenticated rate-limit failures while fetching `tikoci/routeros-skills` and discovering restraml versions during `release.yml`; the `extract-skills-from-cache` Makefile comment now correctly describes it as a local/offline rebuild path, not the release CI path. The shared retry helper (`src/github.ts`) now also backs off on GitHub's secondary/abuse-detection `403 + Retry-After` responses (not just primary-quota exhaustion) and no longer misreads a missing `x-ratelimit-reset` header as an immediate-retry signal; skill file bodies are fetched with the documented `application/vnd.github.v3.raw` accept header.
- **`extract-docusaurus.ts`'s `parseProperties()` now also parses bullet-list property definitions** (`- **name** (type[; default: x]) : description`), not just Markdown tables. Characterizing the 32 pages a naive bold-bullet grep flags (issue #20) showed the overwhelming majority are non-property prose (command menus, chain/enum-value lists, JSON API fields, naming-convention explainers) that must stay excluded, not force-fit; the real gain is scoped to 4 pages whose bullet lists are genuine property definitions: `queues.md` (+51), `scheduler.md` (+6, including one real upstream doc typo now correctly flagged `malformedEmphasis` instead of silently mis-parsed), `clock.md` (+2), and `queues/htb-hierarchical-token-bucket.md` (+3) — +62 properties corpus-wide (4509 → 4571), with zero new false positives across all 365 in-scope pages.
- **FTS `snippet()` excerpt highlighting no longer collides with native Markdown bold in the Docusaurus corpus** (issue #24). Since `T-0035`, indexed prose is raw Markdown and can already contain `**bold**`; wrapping a match in the same `**` marker produced visibly broken output like `****hAP****`. All 7 `snippet()` call sites (`pages`, `properties`, `callouts` x2, `changelogs`, `video_segments`, `dude_pages`) now share one exported sentinel-marker pair (`query.ts`'s `EXCERPT_MARK_START`/`EXCERPT_MARK_END`, `>>>`/`<<<`) — corpus-safe, since the only literal occurrences across all 365 in-scope pages are confined to fenced code blocks (`api.md`'s wire-protocol notation), never in prose. Also fixed 3 adjacent TUI rendering bugs in `browse.ts` found in the same footprint: the pages-excerpt bold conversion was correct but dead code (query.ts still emitted `**`); callouts/changelogs/videos/dude-pages excerpt rendering had no bold-off pairing (bold never turned back off once triggered); and `renderProperties` accepted but never rendered its own `excerpt` field, always showing the plain unhighlighted description.

### Removed

- **CI's automatic `package.json`/`CHANGELOG.md` version-bump commit** (the `bump-version` job in `release.yml`) — superseded by the manual version-bump step above.

## [0.10.0] — 2026-07-08

### Changed

- **v0.10.x will be last release(s) based on Confluence HTML doc extraction.** v0.11.x and beyond will use new manual.mikrotik.com as source for MikroTik documentation pages.

### Fixed

- **Only changelog and version bump.** Promote to an even-number release. Otherwise, identical to 0.9.3.

## [0.9.3] — 2026-07-07

### Changed

- **YouTube transcript cache refreshed for the final Confluence-corpus release.** The committed transcript cache now covers 538 MikroTik channel videos through June 19, 2026, and remains the source release CI imports via `extract-videos-from-cache`.
- **Product matrix snapshot refreshed for the final Confluence-corpus release.** The default device extractor now consumes the July 7, 2026 browser-exported matrix snapshot with 156 products.
- **Release docs now identify local-only source refreshes.** `MANUAL.md` distinguishes cache inputs that CI consumes from live sources CI already refreshes, including the product-matrix browser export caveat.

## [0.9.2] — 2026-06-18

### Changed

- **Docs now flag MikroTik's manual.mikrotik.com migration.** Project docs record that future RouterOS manual updates are Docusaurus-based, not Confluence HTML exports, and outline the extraction/MCP/TUI redesign options.

### Fixed

- **Schema-mismatch setup guidance now points MCP users at a fresh bunx resolution.** The refresh message tells users to restart the MCP client or run `bunx @tikoci/rosetta@latest --refresh` when their cached package is older than the published DB.

### Removed

- **Stale `ros-toc.json` PDF-era artifact removed.** The current HTML extraction pipeline is the source of RouterOS page metadata, and no runtime code consumed the empty-title TOC file.

## [0.9.1] — 2026-05-26

### Fixed

- **Release npm publish now fails fast on missing or unauthorized `NPM_TOKEN`.** The release workflow verifies npm package availability and read-write package access before extraction, artifact publishing, OCI pushes, or GitHub Release creation; partial release retries can update existing GitHub Release assets before publishing to the explicit npm registry.
- **Release skill extraction now authenticates GitHub API reads.** The `extract-skills.ts` GitHub API calls use `GITHUB_TOKEN`/`GH_TOKEN` when available, and release CI passes `github.token` to avoid unauthenticated API 403s while fetching `tikoci/routeros-skills`.

## [0.8.13] — 2026-05-03

### Added

- **`make verify` target.** Runs typecheck + lint + tests + MCP contract tests + Phase 0 retrieval eval in one command. Requires a populated DB (`make extract` first). Covers V-typecheck, V-lint, V-unit, V-tool-registry, V-tool-shapes, V-tool-budget, V-retrieval-floor. Skips the clean-tree check that `make preflight` enforces.

### Changed

- **CLAUDE.md is now a thin routing index, and agent rules live in narrow `.github/instructions/*.instructions.md` files.** Canonical reference material moved to `MANUAL.md` and `DESIGN.md`, legacy broad instruction files became routing stubs, and Copilot-facing guidance now points at the scoped rule files instead of duplicating the whole project reference.
- **TUI/MCP parity and CLI help/manual parity are now CI-enforced.** New `src/browse-parity.test.ts` proves every MCP tool has a matching `.routeros_*` browse dot-command, and new `src/cli-help.test.ts` locks `MANUAL.md`'s CLI Flags table to `bun src/mcp.ts --help`. The `--help` output now documents `browse <cmd> [args]`, `browse --once <cmd>`, and TLS env var names explicitly.
- **MCP contract tests and Phase 0 retrieval eval are now blocking in release CI.** Both were previously `continue-on-error: true` pending a first green CI run; both have now passed — `continue-on-error` removed and step names updated (dropped `(non-blocking)` suffix).
- **Work tracking restructured.** `BACKLOG.md` slimmed to an inbox + triggers list. Active work now lives in `tasks/T-NNNN-*.md` (frontmatter: status, depends_on, conflicts_with, validation, acceptance). Research and decision notes live in `briefings/B-NNNN-*.md`. New `VALIDATION.md` matrix names every load-bearing invariant and the CI step that proves it. Three new `.github/skills/` (`pick-next-task`, `promote-idea`, `verify-task`) wrap the conventions. `CLAUDE.md` and `.github/copilot-instructions.md` doc-rule tables updated to match.
- **Task verification docs now distinguish current proofs from planned ones.** `tasks/README.md` and the `verify-task` skill no longer assume a `make verify` target already exists, `VALIDATION.md` now points `V-db-min-content` at the real inline release step, and `V-retrieval-self` is recorded honestly as a tracked gap until release CI actually runs the self-supervised eval.
- **The test workflow now exercises the real stdio MCP client path.** `.github/workflows/test.yml` runs `src/mcp-stdio-client.test.ts`, which spawns `bun src/mcp.ts` through `@modelcontextprotocol/sdk`'s `StdioClientTransport`, proves the 14-tool registry/resources surface over stdio, and catches stdout framing pollution.
- **Release `bunx-smoke` matrix now includes `windows-latest`.** Catches the EBUSY / readonly-WAL / temp-file class of bugs on Windows. Step uses `RUNNER_TEMP` instead of `mktemp` (not available in Git Bash) and sets `shell: bash` as the job default.
- **Release CI now runs the Phase 1 self-supervised retrieval eval (non-blocking).** After the existing Phase 0 hand-curated eval step, `release.yml` now executes `src/eval/self-supervised.ts` against the freshly built full DB and appends the pass/fail result to the workflow summary. Results are visible but non-blocking until a stable baseline is established.

### Removed

- **`make release`, `make build-release`, `make bump-version` removed from Makefile.** All release artifact production now goes through the GitHub Actions `release.yml` workflow. The Makefile retains ETL targets and developer checks (`make preflight`, `make verify`).

### Security

- **CodeQL ignore scope now anchors the root `skills/` cache explicitly.** `.github/codeql/codeql-config.yml` now ignores `/skills/**` instead of an unanchored `skills/**`, keeping the committed `.github/skills/` workflow docs distinct from the extracted root-level skill cache.

## [0.8.12] — 2026-05-02

### Fixed

- **Windows package-mode DB installation no longer renames a SQLite-opened temp
  file.** Download validation now finalizes every SQLite statement before close,
  and `replaceDbFile` retries transient `EBUSY` / `EEXIST` / `EPERM` rename
  failures for up to 30 seconds to cover delayed handle release, antivirus, or
  indexers.
- **Abandoned `.tmp.*` DB artifacts are removed immediately when no active
  download lock exists**, so failed Windows installs do not keep accumulating
  274 MB temp databases between launches.

## [0.8.11] — 2026-05-02

### Fixed

- **Stale `.tmp.*` cleanup now runs on every startup**, not only when a download
  is triggered. This removes accumulated 274 MB temp files from previous failed
  downloads even when the DB is already healthy.
- **Windows rename now handles `EBUSY`** in addition to `EEXIST`/`EPERM` in the
  `replaceDbFile` fallback path, providing better defense against antivirus or
  indexer locks on the destination.
- **Schema-mismatch recovery messages no longer reference `bun pm cache rm`** or
  use shell `&&` syntax. The actionable command is now
  `bunx @tikoci/rosetta@latest --refresh`, which works cross-platform and
  handles both package and DB refresh in one step.

## [0.8.10] — 2026-05-02

### Security

- **CodeQL + Dependency Review wired up.** New
  [`.github/workflows/codeql.yml`](.github/workflows/codeql.yml) runs the
  `security-and-quality` suite (security-extended + code-quality queries)
  against `javascript-typescript` and `actions` on push, PR, and a weekly
  cron. [`.github/codeql/codeql-config.yml`](.github/codeql/codeql-config.yml)
  excludes vendored/generated content (`box/`, `dude/`, `transcripts/`,
  `matrix/`, `skills/`, `fixtures/`, `dist/`, `images/`) so scans focus on
  shipped/runtime TypeScript, extractors, the bin shim, release scripts, and
  workflow YAML; test/eval harnesses are excluded to avoid temp-file/file-race
  noise outside shipped code. New
  [`.github/workflows/dependency-review.yml`](.github/workflows/dependency-review.yml)
  blocks PRs introducing high-severity dependency advisories. New
  [`.github/dependabot.yml`](.github/dependabot.yml) opens weekly grouped
  update PRs for `github-actions` and `bun` ecosystems. The Test workflow
  gains an "AI findings probe" step that polls candidate Code Quality
  endpoints and prints a CI notice (no-op until GitHub ships a stable API).
  Repo-level Dependabot security updates, secret scanning with push protection,
  and private vulnerability reporting are enabled.
  See `SECURITY.md` for the configured posture summary.

### Changed

- **Documentation/instruction cleanup:** agent-facing instructions, release/extraction docs,
  and BACKLOG structure now match the current CI pipeline, MCP resource surface,
  and `DESIGN.md` source-of-truth for cross-tikoci command validation strategy.
- **MCP search/property confidence metadata:** `routeros_search.classified`
  now includes `command_path_confidence`, and `routeros_lookup_property`
  rows include `confidence` (`high`/`medium`/`low`) to distinguish scoped
  command-page matches from global fallbacks.
- **CI release hygiene:** the `Release` workflow input formerly named
  `force` is now `republish_assets`, making clear that it reuploads GitHub
  Release assets / OCI tags while skipping immutable npm publication. Release
  CI also runs `bun test` in the early fast-fail gate before downloading the
  HTML export while preserving the post-extraction DB-wipe guard.
- **DB retention:** release builds now run `make gc-versions` after command
  linking to prune `schema_node_presence` to active RouterOS channel heads
  (stable, long-term, testing, development). Full command-version history and
  changelogs remain untouched.
- **Tool descriptions: `routeros_stats` and `routeros_current_versions`
  now follow the workflow-arrow (→) convention.** `stats` suggests
  `→ routeros_search`; `current_versions` suggests
  `→ routeros_search_changelogs` with a `from_version`/`to_version`
  hint. The Phase 2 contract test's `KNOWN_EXCEPTIONS` allow-list is
  removed — every registered tool now carries a follow-up arrow.

### Fixed

- **bunx/package startup no longer races the shared `~/.rosetta/ros-help.db`.**
  Package-mode DB preparation now uses a sidecar lock so concurrent MCP clients
  wait for the first download instead of competing to rename the file on
  Windows. Waiters no longer probe-lock the canonical DB while another process
  is replacing it, startup aborts instead of falling through to a schema-only
  empty DB when recovery fails, probes no longer create a missing canonical DB
  as a side effect, and stale `.tmp` / `-wal` / `-shm` artifacts are cleaned up
  instead of accumulating in `~/.rosetta/`.
- **Video transcript VTT cleanup:** malformed cue markup is dropped without
  leaking tag fragments into extracted transcript text.
- **Release workflow npm propagation log:** the bunx smoke-test polling loop
  now reports the correct attempt number while waiting for the npm registry.

### Added

- **`routeros_explain_command` MCP tool:** read-only CLI command explanation
  with canonical path/verb, argument property matches, warnings, docs,
  changelogs, version check, and TUI dot-command parity.
- **`canonicalize.ts`: pluggable verb resolver, `extractMentions()`,
  per-command confidence flag (issue #5 — H4, H6, H8).**
  - `CanonicalizeOptions { isVerb?: (token, parentPath) => boolean }` lets
    callers plug in a path-aware verb classifier. rosetta wires a DB-backed
    resolver against the `commands` table so `/interface/wifi-qcom/info`,
    `/system/script/run`, and other menu-specific verbs classify correctly
    instead of falling back to bare navigation. The resolver supplements the
    curated universal verb heuristic (it does not replace helpers like
    `find`, which are not enumerated everywhere in the command tree).
  - `extractMentions(input, cwd?, options?)` — surfaces every distinct path
    the input *references*, including bare navigation with no verb (e.g.
    `/ip/firewall/filter` standing alone in prose). Superset of
    `extractPaths()`. `ParseResult` also carries a new `mentions: string[]`
    field for callers that already use `canonicalize()` directly.
  - `CanonicalCommand.confidence: 'high' | 'medium' | 'low'` — `high` for
    well-formed CLI (absolute path with directly-identified verb),
    `medium` for relative-with-cwd or pure navigation, `low` when the verb
    was inferred from a trailing path segment (looser/prose-shaped input).
    Lets consumers filter prose-extracted results when they need higher
    precision.
- **`src/canonicalize-resolver.ts`** — DB-backed `isVerb` adapter for
  rosetta's `commands` table, with per-resolver in-memory caching. Wired
  into `searchAll()` via a `ClassifyOptions { isVerb? }` pass-through on
  `classifyQuery`, so MCP `routeros_search` and TUI `s` benefit
  automatically when input contains a path with a menu-specific verb.

<!-- markdownlint-disable-next-line MD024 -- historical [0.8.10] entry had two Fixed blocks; kept verbatim, not rewriting a released section -->
### Fixed

- **Changelog version lookup and bridge VLAN retrieval.** `routeros_search` /
  `routeros_search_changelogs` now keep exact patch-version lookups exact, but
  fall back from an absent major.minor changelog (for example `7.22`) to its
  patch rows (`7.22.*`). Generic "what changed in X.Y" questions now populate
  `related.changelogs`, and bridge VLAN filtering searches treat "switch" as
  context so the dedicated Bridge VLAN Table page ranks in the top results.
- **`canonicalize.ts` robustness — markdown / prose / common-verb gaps.**
  Tokenizer now strips a leading U+FEFF BOM and treats backticks (`` ` ``) and
  zero-width space (U+200B) as whitespace in both the outer and word loops, so
  inputs from markdown fences, doc snippets, and BOM-prefixed files extract
  cleanly instead of embedding the noise into the first path segment.
  `GENERAL_COMMANDS` gains four verbs that are universal in the rosetta
  `commands` table but were missing: `clear`, `unset`, `reset-counters`,
  `reset-counters-all`. Cross-checked against the DB to confirm zero path
  collisions — `info`/`warning`/`error`/`debug` are intentionally NOT added
  (`/error` is itself a top-level cmd; `info` is a dir at
  `/interface/wireless`). Menu-specific verbs need a path-aware resolver
  (tracked as H4 in the audit). New `src/canonicalize.fuzz.test.ts`
  documents both the shipped behaviour and the still-on-the-books H1–H8
  hardenings.

## [0.8.9] — 2026-04-23

## [0.8.8] — 2026-04-22

### Changed

- **CI: `bump-version` now auto-promotes `[Unreleased]` → `[VERSION] — DATE`**
  and prepends a fresh `## [Unreleased]` skeleton after every release. No
  manual CHANGELOG fixup is needed — agents and developers only write to
  `[Unreleased]`; the version heading is filled in automatically.
- **CI: Phase 0 retrieval eval runs on release builds (non-blocking).**
  `release.yml` now executes `bun run src/eval/retrieval.ts` against the
  freshly built full DB after extraction and writes the report to the job
  summary. Non-blocking while the baseline adapts to the real-DB corpus —
  flip to blocking after one green real-DB run refreshes the baseline.
- **CI: Phase 2 contract checks run in a dedicated real-DB step on release
  (non-blocking).** `release.yml` executes `bun test src/mcp-contract.test.ts`
  after the full `bun test` suite so the token-budget and shape-invariant
  blocks run against the freshly built full DB in a fresh process (the
  shared `bun test` run pins the DB singleton to `:memory:` before this
  file loads, so Blocks B/C would otherwise skip). Non-blocking:
  `continue-on-error: true` while we observe the step green across a few
  rebuilds; test output is written to the job summary. `test.yml`
  intentionally does not get a dedicated step: a clean CI checkout has no
  `ros-help.db`, so B/C would skip regardless and the step would be
  redundant with Block A in the main run.

### Added

- **MCP behavioural eval framework (Phases 0–2)** — three new surfaces for
  validating that the MCP tool layer keeps doing what we expect, with no LLM
  cost in the default flow:
  - **Phase 0** (`make eval`) — 20 hand-curated golden queries in
    `fixtures/eval/queries.json`, scored on recall@k / MRR / classifier
    accuracy with baseline regression gating (2pp tolerance).
  - **Phase 1** (`make eval-self`) — ~170 auto-generated queries from
    section headings, property names, and page titles using deterministic
    seeded sampling. Per-strategy thresholds + 5pp baseline tolerance.
  - **Phase 2** (`bun test src/mcp-contract.test.ts`) — frozen tool
    registry test, workflow-arrow (→) convention check, token-budget
    guardrails on 10 canonical queries, and response-shape invariants for
    5 representative queries (portable across DBs of varying richness).
    Runs inside `bun test`.
  - See `BACKLOG.md` "MCP Behavioral Testing — research + roadmap" for the
    full 5-phase plan.
- **Tool-surface change ritual** documented in `CLAUDE.md`: adding,
  removing, or renaming an MCP tool requires updating both `src/mcp.ts`
  and the `EXPECTED_TOOLS` array in `src/mcp-contract.test.ts`, plus a
  `CHANGELOG.md` entry under `[Unreleased]`.

### Fixed

- **Phase 1 self-supervised sampling is now deterministic on full DBs.**
  The cmd-path strategy no longer uses SQL randomness; it samples from a
  stable ordered set using the same seeded shuffle as the other strategies,
  so `self-supervised-baseline.json` stays reproducible across runs.

- `CHANGELOG.md` (Keep a Changelog format, back-filled from v0.1.0) with an
  agentic "update `[Unreleased]` on every user-visible change" rule in
  `CLAUDE.md` + `CONTRIBUTING.md`.
- **TUI: `view` / `v` command.** Re-renders the current context (page,
  results, sections, etc.) without popping the navigation stack the way
  `b` does. Useful after exiting the pager to re-read what you were
  looking at.
- **TUI: bare `page` re-renders current page.** When already in a page or
  sections context, `page` with no args re-renders the current page
  instead of erroring.

- **CI: fast-fail quality gate.** `release.yml` now runs `typecheck` + `lint`
  immediately after `bun install`, before the ~2-minute extraction pipeline.
  Tests continue to run post-extraction as the DB-wipe guard.
- **CI: `bump-version` rebase-retry.** Back-to-back release runs no longer
  fail with `! [rejected] HEAD -> main (fetch first)`. The job fetches +
  rebases onto `origin/main` and retries the push up to 3× (safe because
  the commit only touches `package.json`).
- **`routeros_search_tests`: 512-byte rows surface first when no
  `packet_size` filter is set.** 512B is the conventional mid-size
  benchmark RouterOS admins compare on, so within the LIMIT they now
  precede 1518B "best case" rows that previously crowded them out.
  Pin `packet_size` to override.
- **TUI dot-commands print usage on missing required args.** Calling
  e.g. `.routeros_get_page` with no args now prints the args, brief
  description, and TUI equivalent instead of silently returning `null`.

<!-- markdownlint-disable-next-line MD024 -- historical [0.8.8] entry had two Fixed blocks; kept verbatim, not rewriting a released section -->
### Fixed

- **TUI device detail benchmark truncation now always keeps all 512B rows.**
  When compacting long per-device test lists, the renderer now preserves every
  512-byte result (the common comparison size) and only truncates non-512 rows.
- Tests/CI: importing `extract-test-results.ts` no longer opens the DB or runs
  extraction side effects at module-load time. The extractor now runs only
  under `import.meta.main`, and `extract-test-results.test.ts` sets
  `DB_PATH=:memory:` before dynamic import to prevent cross-file DB singleton
  contamination that could make `query.test.ts` fail depending on test order.
- **`extract-test-results`: throughput values with thousands separators now
  parse correctly.** Values like `7,112.3` Mbps were truncated to `7` because
  `parseFloat` stops at a comma. The extractor now strips commas before parsing,
  so the DB will contain correct figures after the next re-extraction.
- **TUI pager: navigation keystrokes no longer bleed into the REPL prompt.**
  Pager ran in raw mode while readline's data handler was still active, so
  each keystroke (`1`, `4`, `q`, etc.) accumulated in readline's internal
  line buffer and reappeared echoed after the next prompt (e.g. `> 1432q`).
  Fixed by clearing `rl.line`/`rl.cursor` before re-prompting after dispatch.
- **TUI: `[p]` and `[cal]` page hints now work on pages with sections.**
  Pages with headings push `ctx.type = "sections"` (not `"page"`), so the
  `p`/`prop` and `cal`/`callouts` context-scoped handlers were silently
  falling back to "no page, show usage" even while a page was showing.
  Both handlers now check for `sections` context too, so all five footer
  hints (`[N]`, `[p]`, `[cmd]`, `[cal]`, `[b]`) work correctly regardless
  of whether the page has headings.
- **TUI help text mentions `[N]` section navigation.** The post-pager hint
  line now reads `[N] = go to section N` alongside `[p]` / `[cal]` / `[b]`.
- **TUI pager: digits open the listed result.** In a results pager
  (search, devices, callouts, videos, properties, changelogs, sections,
  command tree, dude), pressing `1`..`N` (where N is the number of
  visible results) now opens that result and exits the pager. Previously
  digits were always interpreted as page jumps, so users had to quit the
  pager (`q`) and then type the number — wasted keystrokes on the most
  common path. Page-jump still works for digits beyond the visible
  result count.
- `routeros_search_changelogs` `X..Y` version range is now inclusive on both
  ends, normalises reversed ranges (`7.21..7.20` → `7.20..7.21`), and returns
  entries chronologically (oldest first).
- Build: missing `compareVersions` import in `src/browse.ts` — was failing
  typecheck on both `test.yml` and `release.yml`.

## [0.8.2 – 0.8.3] — 2026-04-22

### Changed

- **TUI polish round-2.** Dot-command aliases (`.s` → `.routeros_search`), back
  navigation re-renders, page calendar rendering, Markdown → ANSI sweep across
  skills/pages.
- **CI:** `bump-version` decoupled from `bunx-smoke` — a smoke regression no
  longer blocks the next version from being available for the fix release.
  Force-mode runs also skip the npm publish step (npm versions are immutable).
- **Lint rule sharpened.** `bun run lint` must be zero errors repo-wide, not
  just on touched files.

### Fixed

- `browse` CLI args now route through the normal TUI dispatcher, so every TUI
  command (not just `s`) works when passed at launch.
- Resolved `noNonNullAssertion` lint errors in `canonicalize.test.ts` that
  were blocking CI.

## [0.8.0 – 0.8.1] — 2026-04-21

### Fixed

- **`bunx` install path is now rock-solid on macOS.** The last `{ readonly: true }`
  DB open (in `mcp.ts::ensureDbReady` and `setup.ts::dbHasData`) was removed.
  Freshly-written WAL-mode SQLite DBs with no `.shm` sibling cannot be opened
  readonly on macOS, which caused `Validated … | Still incompatible after
  re-download (DB=unreadable)` for v0.8.0 users. Added a structural anchor test
  that forbids `{ readonly: true }` on DB opens.

### Added

- **Cross-platform bunx smoke job in CI.** `release.yml` now runs a
  `bunx-smoke` matrix on macOS + Linux after npm publish, pinning the just-
  published version and exercising `--refresh`, `--version`, and the full MCP
  server boot path. Linux-only CI had green-lit v0.8.0 before this was added.

## [0.7.5 – 0.7.8] — 2026-04-21

### Added

- **`db_meta` table (schema v5).** Database provenance — `release_tag`,
  `built_at`, `source_commit`, `schema_version`. Stamped at release time,
  shown in the startup banner.
- **Auto-update story for bunx.** DB download URL pins to the running package
  version (`releases/download/v<VER>/ros-help.db.gz`) with `latest` as
  fallback. Atomic `.tmp.<pid>` write, magic-byte + size + schema probe, then
  `renameSync`. Stale `.db-wal` / `.db-shm` siblings are cleaned up in the
  same step. Schema mismatch is a hard error with an actionable message.
- **TUI usability: MCP probe via dot-commands.** `.routeros_search`, `.page`,
  `.device` etc. invoke the same code path as the MCP server tool and dump
  raw JSON. `.help` lists all 13 dot-commands. Contract: "a human can always
  see exactly what the agent would receive."
- **Hunger-knob `related` caps.** `routeros_search.limit` scales callout /
  video caps proportionally via `relatedCaps(limit)`.
- **Glossary in `related`.** Short queries that match a glossary term/alias
  surface the definition in `related.glossary`.

### Fixed

- **CI DB-wipe regression (v0.7.6).** `extract-dude.test.ts` had imported
  `extract-dude.ts` (which loads `db.ts`) before any `DB_PATH=:memory:` was
  set; `query.test.ts:beforeAll` then `DELETE FROM …`'d the CI-built DB,
  shipping a 3-page release. Fixed with `DB_PATH=:memory:` hoisting, a
  `query.test.ts` hard-fail if the singleton isn't `:memory:`, and a
  `release.yml` DB content gate (`pages ≥ 200`, `commands ≥ 1000`,
  `devices ≥ 100`, `properties ≥ 1000`) that runs before publish.
- `extract-html.ts` exits non-zero if 0 pages are extracted.
- `probeDb` and `ensureDbReady` open the DB read-write so WAL-mode init
  doesn't fail on macOS.

## [0.7.0 – 0.7.4] — 2026-04-20

### Added

- **North Star — unified `routeros_search`.** New pre-search regex classifier
  in `src/classify.ts` (pure module, 42 table-driven tests) detects command
  path, version, topic, device model, command fragment, and property-name
  candidate. `searchAll()` in `src/query.ts` wraps `searchPages` and runs
  classifier-driven side queries in parallel, returning
  `{ query, classified, pages, related: {command_node, properties, devices,
  callouts, videos, changelogs, skills, glossary}, next_steps }`.
- **Glossary table.** Seeded at DB init. Resolves RouterOS domain jargon
  (product codes, abbreviations, subsystem names).
- **Known-topics table.** Union of changelog categories and command path
  segments for soft topic routing in the classifier.
- **Changelog range expansion.** `buildChangelogVersionSet` includes channel
  head versions and latest long-term patches.

### Removed

- **`routeros_search_callouts`** and **`routeros_search_videos`** — folded
  into `routeros_search.related`. Tool count: 15 → 13. The underlying
  `searchCallouts()` / `searchVideos()` functions remain in `query.ts` as
  internal helpers used by `searchAll()` and `getPage()` TOC mode.
- **`routeros_search_properties`** — previously removed (useless without
  command-tree context); internal function retained for TUI.

### Changed

- `routeros_get_page` is budget-aware: TOC mode surfaces top properties,
  related videos, and callout summary inline, so small-budget callers rarely
  need a second tool call.

## [0.6.4 – 0.6.9] — 2026-04-13 → 2026-04-20

### Added

- **`schema_nodes` table + multi-arch import.** `deep-inspect.json` from
  `tikoci/restraml` is now the preferred source. Dual-arch (x86/arm64) trees,
  `_completion` data (11K+ args with valid values + 17 style types),
  `schema_node_presence` flat junction, `_attrs` JSON catch-all. The
  `commands` + `command_versions` tables are regenerated from `schema_nodes`
  for backward compatibility.
- **`desc_raw` decomposition.** Parsed into `data_type`, `enum_values`,
  `range_min`/`range_max`, `max_length` at import time.
- **Completion data in `browseCommands()` / `browseCommandsAtVersion()`.**
- **RouterOS agent skills as MCP resources.** `rosetta://skills` (listing)
  and `rosetta://skills/{name}` (per-skill content) with provenance header
  noting community/AI-generated/human-reviewed status.
- **CLI flag support for DB path.** Explicit `--db <path>` overrides all
  discovery modes.
- **Section-level excerpts in search** + server-wide instructions surfaced
  via `SERVER_INSTRUCTIONS`.
- **RouterOS CLI path canonicaliser.** `src/canonicalize.ts` maps any input
  form to `{ path, verb, args }` tuples (61 tests covering subshells, blocks,
  navigation).
- **Release workflow version resolution.** `release.yml` reads `package.json`
  for version when workflow input is blank.

### Fixed

- `dude_pages`: stripped Wayback / wiki chrome from extracted text; removed
  stub entries; `routeros_dude_get_page` accepts `max_length`.
- `browseCommands` arch filtering corrected and tests added.
- Removed `{ readonly: true }` from early DB validation in setup (repeat
  regression trail — finally closed in 0.8.1).
- Stop words + compound terms counts corrected in tool descriptions.

## [0.5.x – 0.6.3] — 2026-04-09 → 2026-04-13

### Added

- **MCP Registry metadata.** `server.json` manifest + CI validation job.
- **MCP dataset resources.** `rosetta://datasets/device-test-results.csv`,
  `rosetta://datasets/devices.csv`, `rosetta://schema.sql`,
  `rosetta://schema-guide.md`.
- **`routeros_command_diff`.** Structural diff of command trees between two
  RouterOS versions.
- **`PRAGMA user_version`** written at DB init; MCP server validates on boot.
- **Sitemap-based device slug resolution** for 100% product-page coverage;
  AKA / alias matching via dash-split + slug-normalised LIKE.
- **Changelog extraction: legacy version support** with CI verification;
  version-set building tests.
- **`ensureDbReady` function in `mcp.ts`** — hard validation before the
  server starts serving.

### Fixed

- Per-session HTTP transport routing (each MCP client session gets its own
  `McpServer` + transport).
- `.dockerignore` added to slim the build context.
- OCI smoke test via `docker pull` (not `docker load`); container entrypoint
  restored in Docker build context.

## [0.4.x] — 2026-04-04 → 2026-04-09

### Added

- **`routeros_search_tests`.** Cross-device ethernet + IPSec benchmark search
  with mode, configuration, and packet-size filters.
- **Device test results + block diagrams.** Scraped from `mikrotik.com/product/<slug>`:
  2,874 measurements across 125 devices, 110 block-diagram URLs.
- **Experimental TUI (`browse`).** Interactive terminal browser — REPL with
  paging, OSC 8 links, context-scoped navigation.
- **Video transcripts via yt-dlp.** 518 MikroTik channel videos, ~1,890
  chapter-level segments with timestamps. NDJSON cache in `transcripts/`
  makes CI reproducible without a yt-dlp dependency.
- **Unicode superscript / subscript normalisation** in product names.
- **Auto-bump patch version after release** (Makefile + CI).
- **Security policy documentation** (`SECURITY.md`) + build-script hardening
  against shell injection.

### Fixed

- HTTP transport test stabilisation; lint sweep.
- `search_tests` response slimmed to reduce context bloat.

## [0.3.x] — 2026-03-31 → 2026-04-01

### Added

- **Streamable HTTP transport** via `--http` flag. Built on `Bun.serve()` +
  `WebStandardStreamableHTTPServerTransport`, stateful per-session routing,
  optional `--tls-cert` / `--tls-key` for direct HTTPS. Defaults to localhost;
  `--host 0.0.0.0` logs a warning.
- **OCI image publishing** (`ammo74/rosetta` on Docker Hub,
  `ghcr.io/tikoci/rosetta` on GHCR). Multi-arch linux/amd64 + linux/arm64.
  Smoke-tested in CI via `docker pull`.
- **`get_page` smart budgeting.** `max_length` default 16000, compact callout
  summary in TOC mode.

### Fixed

- Replaced crane with `Dockerfile + docker buildx` for OCI builds — several
  crane approaches all failed identically on Docker 28 with containerd image
  store.
- Per-session HTTP transport routing.

## [0.2.x] — 2026-03-30

### Added

- **npm distribution.** `bunx @tikoci/rosetta` as canonical install.
  Runtime version resolution (`import.meta.dirname` + `package.json` read)
  so `--version` shows a real number. Claude Desktop full-path PATH
  workaround documented in `--setup` output.
- **Changelog extraction** from `download.mikrotik.com/routeros/<ver>/CHANGELOG`;
  `routeros_search_changelogs` tool with version range + category + breaking
  filters.
- **Markdownlint configuration** (`.markdownlint.yaml`, `.markdownlintignore`).

### Fixed

- CI release workflow: pass HTML dir to `extract-properties`; tolerate
  Confluence zip absolute-path entry; lint issues; TypeScript dev-dependency
  for typecheck.
- `inspect.json` fetched from restraml GitHub Pages (removed `~/restraml`
  dependency).

## [0.1.0] — 2026-03-26

Initial public release.

### Added

- **Core MCP server** (`src/mcp.ts`) with 8 tools: `routeros_search`,
  `routeros_get_page`, `routeros_lookup_property`, `routeros_command_tree`,
  `routeros_device_lookup`, `routeros_command_version_check`,
  `routeros_current_versions`, `routeros_stats`.
- **HTML extraction pipeline** (317 pages, 4,860 properties, 1,034 callouts,
  2,984 sections) + **command tree** (46 RouterOS versions, 1.67M
  command-version junction rows) + **product matrix** (144 devices).
- **SQL-as-RAG** with FTS5 (`porter unicode61` for prose, plain `unicode61`
  for device model numbers), BM25 ranking, compound-term recognition,
  AND→OR fallback.
- **Compiled single-file binaries** for macOS arm64/x64, Linux x64, Windows
  x64 via `bun build --compile`.
- **`--setup` flow.** Downloads DB from GitHub Releases, prints MCP client
  config snippets for Claude Desktop, Claude Code, VS Code Copilot, Copilot
  CLI, Cursor, Codex.
- **`DB_PATH` env override** + three-mode DB path resolution (compiled /
  dev / package at `~/.rosetta/`).
- Bun tests for the query planner + schema health.

[Unreleased]: https://github.com/tikoci/rosetta/compare/v0.10.0...HEAD
[0.10.0]: https://github.com/tikoci/rosetta/compare/v0.9.3...v0.10.0
[0.9.3]: https://github.com/tikoci/rosetta/compare/v0.9.2...v0.9.3
[0.9.2]: https://github.com/tikoci/rosetta/compare/v0.9.1...v0.9.2
[0.9.1]: https://github.com/tikoci/rosetta/compare/v0.8.13...v0.9.1
[0.8.13]: https://github.com/tikoci/rosetta/compare/v0.8.12...v0.8.13
[0.8.12]: https://github.com/tikoci/rosetta/compare/v0.8.11...v0.8.12
[0.8.11]: https://github.com/tikoci/rosetta/compare/v0.8.10...v0.8.11
[0.8.10]: https://github.com/tikoci/rosetta/compare/v0.8.9...v0.8.10
[0.8.9]: https://github.com/tikoci/rosetta/compare/v0.8.8...v0.8.9
[0.8.8]: https://github.com/tikoci/rosetta/compare/v0.8.3...v0.8.8
[0.8.2 – 0.8.3]: https://github.com/tikoci/rosetta/compare/v0.8.1...v0.8.3
[0.8.0 – 0.8.1]: https://github.com/tikoci/rosetta/compare/v0.7.8...v0.8.1
[0.7.5 – 0.7.8]: https://github.com/tikoci/rosetta/compare/v0.7.4...v0.7.8
[0.7.0 – 0.7.4]: https://github.com/tikoci/rosetta/compare/v0.6.9...v0.7.4
[0.6.4 – 0.6.9]: https://github.com/tikoci/rosetta/compare/v0.6.3...v0.6.9
[0.5.x – 0.6.3]: https://github.com/tikoci/rosetta/compare/v0.4.5...v0.6.3
[0.4.x]: https://github.com/tikoci/rosetta/compare/v0.3.1...v0.4.5
[0.3.x]: https://github.com/tikoci/rosetta/compare/v0.2.1...v0.3.1
[0.2.x]: https://github.com/tikoci/rosetta/compare/v0.1.0...v0.2.1
[0.1.0]: https://github.com/tikoci/rosetta/releases/tag/v0.1.0
