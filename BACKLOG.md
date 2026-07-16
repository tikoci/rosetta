# Backlog — rosetta

> Lightweight inbox + watch list. Real work lives in [GitHub Issues](https://github.com/tikoci/rosetta/issues), grounded design notes in [`briefings/`](briefings/). See `tasks/README.md` (now an archive note) and `briefings/README.md` for the full convention.
>
> **Decision rule:**
>
> - Loose thought, no shape yet → **Inbox** below (one line).
> - Waiting on a specific external event → **Triggers** below (one line + condition).
> - Need to think out loud, ground claims, or record a decision → `briefings/B-NNNN-<slug>.md`.
> - Codebase work you'd commit to → open a **GitHub issue**; label it `agent-ready` only once the spec is settled (see `.github/instructions/where-does-this-go.instructions.md`).

---

## Inbox

Drop one-line thoughts here. Promote later — to an issue if it gains shape, to a briefing if it needs thinking-first, or delete if it doesn't survive a re-read.

- Keep merging `actions/setup-node`, `actions/upload-artifact`, and Docker action Dependabot bumps before GitHub's forced runtime transitions turn warnings into failures.
- `src/setup.test.ts` — `probeDb > closes statements so a probed temp DB can be renamed immediately` consistently times out on macOS (~7-8s vs 5000ms timeout); introduced in v0.8.12 Windows-rename fix; passes on CI (Linux). Investigate whether the timeout needs raising or the test needs a macOS skip/guard.
- Benchmark feedback loop: periodically compare retrieval/explain changes against `~/GitHub/bench-routeros-tools`; promote `route-blackhole`, version-new Wi-Fi `ssid=`, and skill-vs-raw-doc packaging into rosetta fixtures when the benchmark corpus stabilizes.
- Future `routeros_validate_command`: carry explicit static-vs-runtime provenance and include a bare-flag `blackhole` regression fixture because `/console/inspect` can accept forms that RouterOS runtime rejects.
- TUI longer wishlist: tab completion, persistent history (`~/.rosetta/browse_history`), export (JSON/CSV/Markdown), audit views, bookmarks. None individually picked up — promote one to an issue if a real need surfaces (umbrella [#27](https://github.com/tikoci/rosetta/issues/27) is the home for TUI work).
- Rung-1 steering skill: a skill encoding the `llms.txt → .md → cli-reference` workflow (per B-0013), possibly wrapping the one-shot CLI idea now tracked in B-0015 / umbrella [#27](https://github.com/tikoci/rosetta/issues/27). Cross-repo (`routeros-skills` or repo-local per the centrs#150 pattern) — promote once centrs#150's onboarding pilot lands.
- `device_detail: "brief" | "full"` arg on `routeros_search` — let an agent pull fuller device data inline and skip a second `routeros_device_lookup` call. Deferred from Phase 2A ([#49](https://github.com/tikoci/rosetta/issues/49)) to keep it shippable/budget-safe; recorded in B-0019 feedback #3. Promote to an issue if a real need surfaces.
- Doc → device cross-referencing: `routeros_get_page` "references devices"/"references pivots (switch chips)" block; main-doc prose as a test corpus for free-form device surfacing + a scope probe for how often devices are mentioned. Routed to `briefings/B-0007-special-hardware-pages.md` (Track B); downstream of Phase 2A ([#49](https://github.com/tikoci/rosetta/issues/49)).
- Switch-chip → device resolution: **promoted 2026-07-10** to issue [#34](https://github.com/tikoci/rosetta/issues/34) / `briefings/B-0017-hardware-overlay-device-resolution.md`, which reframes the chip→model gap (`devices.cpu` conflating the switch ASIC with the management CPU) as one instance of a broader three-way device-identity problem across `matrix.csv`, www product pages, and the new `/hardware` Docusaurus source. See that briefing for the original chip-ID case detail.
- Human manually added `hardware-www-matrix.csv` to repo from manual SQLite .output of `devices_overview` table (`sqlite3 -header -csv -readonly .rosetta/ros-help.db "SELECT * from device_overview;" > hardware-www-matrix.csv`), but should be regularized in CI.  Additionally the set of "human readable" _generated_ CSV/TSV/JSON files should be published on branch for GitHub pages to aid linking (and `main` branch protection rules), as part of CI.  e.g. GH Pages would allow `curl`/etc. on the SQL-based data.  Likely should be broader than "device"-things, and more regularized, but goal is that there are URLs for more table-based results from ETL.  _TSV with JSON as column renders poorly in GH since file does meet requirements for "pretty" HTML table in GH repo website, for unknown reason._
- `routeros_command_tree` path ergonomics: requires exact slash-delimited REST-like paths (e.g. `/ip/address/add/address`) and rejects natural forms like `ip address`; shape is tightly bound to `inspect.json`'s parts, some of which (e.g. `page_title`/`page_url`/`dir_role`/`data_type`/`_arch`/`completion`, often all `null`) may not carry their weight. Surfaced while reviewing B-0004 (2026-07-14), which is otherwise superseded/resolved — not yet scoped as its own issue.
- Can `yt-dlp` run reliably in GitHub Actions to automate the video-transcript cache refresh (`make save-videos-cache`)? Would close the last local-only extraction gap identified in B-0009 (Dude staying local-only is fine — it's a frozen archive, not a moving target). Investigate rate-limiting/bot-detection risk before promoting to an issue.

## Triggers

Items waiting on a specific external event. Not tracked as issues because the wait is indeterminate. When the trigger fires, open an issue.

| Trigger | Item |
|---------|------|
| Schema-versioned filename for package mode | If cross-version `bunx` upgrades still produce Windows lock/rename issues after the current sidecar-lock + probe-hardening fix. |
| `schema_nodes._package` population | When restraml emits package provenance in deep-inspect output. |
| MCP Registry publish automation | When CI OIDC auth is configured. Add publish step to `release.yml` and sync `server.json` version from tag. |
| OCI armv7 support | When Bun armv7 target and MikroTik `/app` armv7 support both exist. |
| Legacy documentation version tracking | Only if another archival Confluence export appears. Otherwise, use B-0012 instead of waiting for a second HTML export. |
| Copilot context provider via `lsp-routeros-ts` | When LSP integration matures enough to provide doc context via MCP or direct DB queries. |
| Cross-DB federation with forum archive | When forum archive is stable and a classifier/plugin point is ready. |
| Local usage analytics | When we need real query-shape data. Keep opt-in (`ROSETTA_LOG_USAGE=1`) and local-only. |
| Video extraction retry | At each scheduled transcript refresh — re-run consistent-fail videos after 48–72h gaps; add to `known-bad.json` after repeated failures. |
| LSP consumer artifacts | When `lsp-routeros-ts` is ready for static manifests. Publish path→URL/title and verbs manifests as CI artifacts. |
| Manual doc-changes watcher | After Docusaurus extraction lands: CI polls `manual.mikrotik.com/changelog/rss.xml` (verified live 2026-07-07) and opens an issue/PR when the manual changed, making re-extraction event-driven instead of scheduled. |
| bench-routeros-tools merge | When `agents/grounded-data-collection-agents` and the pending Claude matrix work land, review benchmark reports for stable external-eval fixtures and decide whether to promote a rosetta task. |

---

## Active work

Tracked in [GitHub Issues](https://github.com/tikoci/rosetta/issues) since 2026-07-10 (migration: [#18](https://github.com/tikoci/rosetta/issues/18)). The commands below need an authenticated [`gh` CLI](https://cli.github.com/); without it, the [Issues tab](https://github.com/tikoci/rosetta/issues) shows the same thing. List it live:

```sh
gh issue list                        # everything open
gh issue list --label agent-ready    # pick-up-now queue
gh issue list --label umbrella       # theme tracking issues
gh issue list --milestone 0.11.0     # 0.11 release checklist
gh issue list --milestone "0.12 — MCP surface"  # surface-cleanup theme
```

## Briefings index

Grounded research and decision notes. Open items are ongoing thinking; resolved items are decisions on the record.

| ID | Topic | Status |
|----|-------|--------|
| B-0001 | Should `routeros_lookup_property` grow broad FTS query mode? — resolved 2026-07-14: no, lean shifted to retiring the tool from the MCP/TUI surface (see B-0011) | resolved |
| B-0002 | How aggressively to de-emphasize standalone binaries | open |
| B-0003 | Why no `run_sql` MCP tool | resolved |
| B-0004 | inspect.json / deep-inspect coverage gaps — superseded 2026-07-14 by the CLI-Reference overlay track (B-0016, #25/#33/#28) | resolved |
| B-0005 | Dude wiki extraction follow-ups — lean (2026-07-14): audit extraction accuracy, then merge into `routeros_search` and retire the dedicated Dude tools | open |
| B-0006 | Device AKA / alias handling | open |
| B-0007 | Special hardware page extraction | open |
| B-0008 | `/app` auto-update pull-vs-cache behaviour | open |
| B-0009 | Future ETL pipeline streamlining — resolved 2026-07-14: CI already extracts from cache consistently; only remaining gap (yt-dlp-in-CI) moved to BACKLOG Inbox | resolved |
| B-0010 | MCP behavioral testing phases 3+ | open |
| B-0011 | Audit the 14-tool MCP surface for consolidation | open |
| B-0012 | Docusaurus manual migration after Confluence retirement | open |
| B-0013 | Steering / skills / rosetta / centrs positioning ladder | open |
| B-0014 | CI is release-workflow-locked, not PR/main-gated — QA cleanup plan | open |
| B-0015 | Unified "explain" static + live across the tikoci trilogy (rosetta/centrs/lsp) | open |
| B-0016 | CLI-Reference overlay: precursor ETL design (issue [#33](https://github.com/tikoci/rosetta/issues/33)); parked 2026-07-12, revisit triggers on #33 | open |
| B-0017 | `/hardware` overlay: device-resolution research (issue [#34](https://github.com/tikoci/rosetta/issues/34); absorbs B-0006/B-0007) | open |
| B-0018 | Product-naming ↔ three-source map: human/MikroTik guide to `device-map.tsv`, parsing tricks, and known `/hardware` gaps (companion to B-0017) | open |
| B-0019 | Hardware overlay Phase 2: surfacing `hardware_catalog`/`device_aliases` in MCP/TUI — design done, [#39](https://github.com/tikoci/rosetta/issues/39) closed; build spawned as [#49](https://github.com/tikoci/rosetta/issues/49)/[#50](https://github.com/tikoci/rosetta/issues/50) | resolved |
| B-0020 | 0.11 retrieval-quality audit | open |
| B-0021 | Off-matrix nomenclature (2B) + `&`-module / derivative-part taxonomy (2C) — decision-support for [#70](https://github.com/tikoci/rosetta/issues/70) | open |
| B-0022 | Runtime SQLite-only dataset exports for local audit and future static hosting — feasibility inventory grounded on the CI artifact; schema/ETL findings spawned as [#95](https://github.com/tikoci/rosetta/issues/95) umbrella (`export-audit`). Re-grounded on rc.99 after [#90](https://github.com/tikoci/rosetta/issues/90)/[#92](https://github.com/tikoci/rosetta/issues/92) landed; export decomposed into E1–E4 with E1 filed as [#101](https://github.com/tikoci/rosetta/issues/101), and the table census produced [#100](https://github.com/tikoci/rosetta/issues/100) | open |

## Done index

Greppable history of merged work. See `tasks/done/T-*.md` for full back-fill of historical wins.

- T-0001 North Star unified `routeros_search`
- T-0002 `routeros_explain_command` shipped as tier-1 read-only bridge
- T-0003 Canonicalizer hardenings H4/H6/H7/H8
- T-0004 DB-wipe guard + extractor test isolation
- T-0005 Version GC for `schema_node_presence`
- T-0006 `routeros_search_tests` + workflow arrows + glossary fixes
- T-0007 "Looks like a command, but args not found" warning
- T-0008 Deleted stale `.npm-publish-checklist.md`
- T-0009 Windows `bunx-smoke` release coverage
- T-0010 Real-client MCP stdio integration test
- T-0013 Dropped `make release` / `make build-release` / `make bump-version`
- T-0028 `make verify` local CI parity target
- T-0029 Promoted contract test + Phase 0 retrieval eval to blocking in release CI
- T-0030 Self-supervised retrieval eval wired into release CI
- T-0031 Split `CLAUDE.md` into narrow instruction files and relocated canonical docs to `MANUAL.md` / `DESIGN.md`
- T-0033 Docusaurus pre-migration grounding pack — B-0012 homework H1–H8 resolved, follow-up tasks proposed
- T-0034 rosetta-id scheme spike — confirmed H7 Option 2 against a live 20-page `/docs` prototype
- T-0035 Docusaurus `/docs` prose extractor — replaced `extract-html.ts` as the default prose source; 360/360 pages live-verified against `llms.txt`
- T-0036 Cut `release.yml` over to `extract-docusaurus.ts`, retired `html_url` and the legacy Confluence release pipeline
