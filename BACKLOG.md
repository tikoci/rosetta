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
- Benchmark feedback loop: periodically compare retrieval/explain changes against `~/GitHub/bench-routeros-tools`; promote `route-blackhole`, version-new Wi-Fi `ssid=`, and skill-vs-raw-doc packaging into rosetta fixtures when the benchmark corpus stabilizes.
- Future `routeros_validate_command`: carry explicit static-vs-runtime provenance and include a bare-flag `blackhole` regression fixture because `/console/inspect` can accept forms that RouterOS runtime rejects.
- TUI longer wishlist: tab completion, persistent history (`~/.rosetta/browse_history`), export (JSON/CSV/Markdown), audit views, bookmarks. None individually picked up — promote one to an issue if a real need surfaces (the former TUI umbrella #27 closed 2026-10-04; promote individual items directly).
- Rung-1 steering skill: a skill encoding the `llms.txt → .md → cli-reference` workflow (per B-0013), possibly wrapping the one-shot CLI idea tracked in B-0015. Cross-repo (`routeros-skills` or repo-local per the centrs#150 pattern) — promote once centrs#150's onboarding pilot lands.
- `device_detail: "brief" | "full"` arg on `routeros_search` — let an agent pull fuller device data inline and skip a second `routeros_device_lookup` call. Deferred from Phase 2A ([#49](https://github.com/tikoci/rosetta/issues/49)) to keep it shippable/budget-safe; recorded in B-0019 feedback #3. Promote to an issue if a real need surfaces.
- Doc → device cross-referencing: `routeros_get_page` "references devices"/"references pivots (switch chips)" block; main-doc prose as a test corpus for free-form device surfacing + a scope probe for how often devices are mentioned. Routed to `briefings/B-0007-special-hardware-pages.md` (Track B); downstream of Phase 2A ([#49](https://github.com/tikoci/rosetta/issues/49)).
- One-shot CLI mirroring the MCP tools (`bunx @tikoci/rosetta routeros_search '…' --limit 5`, `T-0032`): the underlying need behind the closed #27 umbrella is a more useful CLI. Shape lives in B-0015; promote to one concrete issue when the 0.12 surface work starts (after #54's parity table).
- Extractor rebuild isn't atomic: an insert error mid-rebuild leaves a wiped DB, and the naive fix (wrap in a transaction) silently re-enables FK enforcement because `PRAGMA foreign_keys` is a no-op inside a transaction. Moved here from the closed #95 umbrella. Separate failure mode [#178](https://github.com/tikoci/rosetta/issues/178) is fixed: per-version extraction failures now fail the build (#179). That fail-closed release behavior does not make local rebuilds atomic.
- `routeros_command_tree` path ergonomics: requires exact slash-delimited REST-like paths (e.g. `/ip/address/add/address`) and rejects natural forms like `ip address`; shape is tightly bound to `inspect.json`'s parts, some of which (e.g. `page_title`/`page_url`/`dir_role`/`data_type`/`_arch`/`completion`, often all `null`) may not carry their weight. Surfaced while reviewing B-0004 (2026-07-14), which is otherwise superseded/resolved — not yet scoped as its own issue.

- Manual doc-changes watcher: Docusaurus extraction has landed, so the old prerequisite is satisfied. Decide whether RSS-driven refresh adds value before scheduling it; reverify the feed before implementation.

## Triggers

Items waiting on a specific external event. Not tracked as issues because the wait is indeterminate. When the trigger fires, open an issue.

| Trigger | Item |
|---------|------|
| `schema_nodes._package` population | When restraml emits package provenance in deep-inspect output. |
| MCP Registry publish automation | When CI OIDC auth is configured. Add publish step to `release.yml` and sync `server.json` version from tag. |
| OCI armv7 support | When Bun armv7 target and MikroTik `/app` armv7 support both exist. |
| Copilot context provider via `lsp-routeros-ts` | When LSP integration matures enough to provide doc context via MCP or direct DB queries. |
| Cross-DB federation with forum archive | When forum archive is stable and a classifier/plugin point is ready. |
| Local usage analytics | When we need real query-shape data. Keep opt-in (`ROSETTA_LOG_USAGE=1`) and local-only. |
| Video extraction retry | At each scheduled transcript refresh — re-run consistent-fail videos after 48–72h gaps; add to `known-bad.json` after repeated failures. |
| LSP consumer artifacts | When `lsp-routeros-ts` is ready for static manifests. The path→URL/title half is now [#173](https://github.com/tikoci/rosetta/issues/173) (publish `rosetta export` output); a `verbs.json` manifest (#5 H4) would ride the same publishing path. |
| bench-routeros-tools merge | When `agents/grounded-data-collection-agents` and the pending Claude matrix work land, review benchmark reports for stable external-eval fixtures and decide whether to promote a rosetta task. |
| Overlay-as-base path vocabulary (B-0024 step 8) | When `centrs`' `explain` canonicalization work settles whether the CLI-Reference path vocabulary can host inspect's verbs without a new alias layer. Until then rosetta keeps the overlay beside `schema_nodes`, not under it. Do not preempt with a rosetta-local alias scheme. |

Fired 2026-10-20: **versioned manual** — `/docs/7.24/` and `/docs/7.25/` now serve `llms.txt` + `.md`, and the default tree declares itself 7.26 (development), not stable. Delivered: [#187](https://github.com/tikoci/rosetta/issues/187) (stamp the ingested manual version) and [#188](https://github.com/tikoci/rosetta/issues/188) (per-version CLI Reference as a published dataset for centrs). Remaining: [#186](https://github.com/tikoci/rosetta/issues/186) (per-version prose).

---

## Active work

The bounded next stable release is tracked in
[#204](https://github.com/tikoci/rosetta/issues/204). The `0.12 — MCP surface`
milestone is a longer-term theme, not a requirement to finish every member before
0.12.0. The 0.11.3 release tracker and milestone are closed.

Tracked in [GitHub Issues](https://github.com/tikoci/rosetta/issues) since 2026-07-10 (migration: [#18](https://github.com/tikoci/rosetta/issues/18)). The commands below need an authenticated [`gh` CLI](https://cli.github.com/); without it, the [Issues tab](https://github.com/tikoci/rosetta/issues) shows the same thing. List it live:

```sh
gh issue list                        # everything open
gh issue list --label agent-ready    # pick-up-now queue
gh issue list --label umbrella       # theme tracking issues
gh issue list --milestone "0.12 — MCP surface"  # longer-term surface theme
```

## Briefings index

Grounded research and decision notes. Open items are ongoing thinking; resolved items are decisions on the record.

| ID | Topic | Status |
|----|-------|--------|
| B-0001 | Should `routeros_lookup_property` grow broad FTS query mode? — resolved 2026-07-14: no, lean shifted to retiring the tool from the MCP/TUI surface (see B-0011). Revisit trigger 2026-07-31: retirement **conditioned** on fixing the command↔prose join first — both fold targets sit on the wrong side of it (see B-0024) | resolved |
| B-0002 | How aggressively to de-emphasize standalone binaries — resolved 2026-10-04: README is bunx-only, MANUAL keeps binaries for no-Bun/air-gapped use | resolved |
| B-0003 | Why no `run_sql` MCP tool | resolved |
| B-0004 | inspect.json / deep-inspect coverage gaps — superseded 2026-07-14 by the CLI-Reference overlay track (B-0016, #25/#33/#28) | resolved |
| B-0005 | Dude wiki extraction follow-ups — lean (2026-07-14): audit extraction accuracy, then merge into `routeros_search` and retire the dedicated Dude tools | open |
| B-0006 | Device AKA / alias handling | open |
| B-0007 | Special hardware page extraction | open |
| B-0008 | `/app` auto-update pull-vs-cache behaviour | open |
| B-0009 | Future ETL pipeline streamlining — resolved 2026-07-14: CI already extracts from cache consistently; only remaining gap (yt-dlp-in-CI) now tracked on [#21](https://github.com/tikoci/rosetta/issues/21) | resolved |
| B-0010 | MCP behavioral testing phases 3+ | open |
| B-0011 | Audit the 14-tool MCP surface for consolidation. 2026-07-31: the `routeros_lookup_property` fold is **preconditioned** on B-0024 — fix the join, recalibrate confidence, then decide the surface. 2026-10-04: premise moved (CLI Reference now carries descriptions); the fold is B-0025's B-vs-D question, pending cross-repo planning with centrs/lsp | open |
| B-0012 | Docusaurus manual migration after Confluence retirement | open |
| B-0013 | Steering / skills / rosetta / centrs positioning ladder | open |
| B-0014 | CI is release-workflow-locked, not PR/main-gated — QA cleanup plan. Resolved 2026-10-04: `qa.yml` (reusable, called by Release), `test.yml` on PRs, branch protection, coverage reporting (`V-coverage-reported`) and the `next` channel all shipped | resolved |
| B-0015 | Unified "explain" static + live across the tikoci trilogy (rosetta/centrs/lsp) | open |
| B-0016 | CLI-Reference overlay: precursor ETL design ([#33](https://github.com/tikoci/rosetta/issues/33)); 2026-07-20 extraction experiment answered join-key + parsing → scoped extractor issue [#124](https://github.com/tikoci/rosetta/issues/124) cut, landed via [#126](https://github.com/tikoci/rosetta/issues/126)/[#128](https://github.com/tikoci/rosetta/issues/128). The stable-at-build Q3 premise is superseded: #191 stamps the declared manual version and #188 stores/exports multiple CLI Reference trees; #25 retains per-answer provenance and arch-fallback decisions; Q5 (agent surfacing) got its first concrete consumer 2026-07-31 — the corroborated join in B-0024 | open |
| B-0017 | `/hardware` overlay: device-resolution research (issue [#34](https://github.com/tikoci/rosetta/issues/34); absorbs B-0006/B-0007) | open |
| B-0018 | Product-naming ↔ three-source map: human/MikroTik guide to `device-map.tsv`, parsing tricks, and known `/hardware` gaps (companion to B-0017) | open |
| B-0019 | Hardware overlay Phase 2: surfacing `hardware_catalog`/`device_aliases` in MCP/TUI — design done, [#39](https://github.com/tikoci/rosetta/issues/39) closed; build spawned as [#49](https://github.com/tikoci/rosetta/issues/49)/[#50](https://github.com/tikoci/rosetta/issues/50) | resolved |
| B-0020 | 0.11 retrieval-quality audit — decision record for #53; Bug Ledger children all closed (2026-10-04) | resolved |
| B-0021 | Off-matrix nomenclature (2B) + `&`-module / derivative-part taxonomy (2C) — decision-support for [#70](https://github.com/tikoci/rosetta/issues/70) | open |
| B-0022 | Runtime SQLite-only dataset exports for local audit and future static hosting — feasibility inventory grounded on the CI artifact; schema/ETL findings spawned as [#95](https://github.com/tikoci/rosetta/issues/95) umbrella (`export-audit`). Re-grounded on rc.99 after [#90](https://github.com/tikoci/rosetta/issues/90)/[#92](https://github.com/tikoci/rosetta/issues/92) landed; export decomposed into E1–E4 with E1 filed as [#101](https://github.com/tikoci/rosetta/issues/101), and the table census produced [#100](https://github.com/tikoci/rosetta/issues/100) | open |
| B-0023 | Page/section normalization — make section coverage total (lead `_lead` fragment) so page prose is sliceable. Decision 2026-07-16 (Option A); **implemented in [#105](https://github.com/tikoci/rosetta/pull/105)**. Consumers: [#27](https://github.com/tikoci/rosetta/issues/27) ergonomics, and the command↔prose join in B-0024 (correctness), which consumes total coverage while its own key is still open | resolved |
| B-0024 | The command↔prose join — `commands.page_id` is the only bridge between the structure stores and the prose store, and it is a fuzzy, page-grained scalar. Root-cause pass behind [#131](https://github.com/tikoci/rosetta/issues/131)/[#132](https://github.com/tikoci/rosetta/issues/132); re-anchors [#58](https://github.com/tikoci/rosetta/issues/58) and [#61](https://github.com/tikoci/rosetta/issues/61). Steps 3–5 **closed the query side**: section alignment is a ranking signal not a key (table granularity dead, proximity the only live key candidate), the confidence tiers now grade the row, and the residual `high`-on-thin-evidence class is 24 rows. Step 6 **moved the question**: half the prose↔schema gap is read-only fields and single-architecture coverage, so the prior question to "what is the missing key" is "what is the missing row" — see `DESIGN.md` → "What each store is authoritative for". #58/#61 closed 2026-10-04 (answered via the CLI Reference, B-0025); still open for menus the overlay describes poorly | open |
| B-0025 | Which store answers "what does argument X at menu Y mean" now that MikroTik is moving property tables into the CLI Reference (#169/#170). Census on next.114: only 46% of settable overlay fields are described; 819 manual-below-`high` answers win over an exact overlay row (101 of them over a _described_ one — the firewall filter/mangle class); 1,288 blank overlay matches count as "documented." Options A–D. **Decided 2026-10-04:** ship B (described overlay beats manual below `high`), `no-description` for blank overlay matches, three Block D budgets, and a per-release census. Dotted names shipped (#172). 2026-10-04 review: keep B for now; B-vs-D and the `lookup_property` retirement wait for cross-repo planning (0.12); next step is measuring the 69 `manual / high` rows that have a described overlay alternative. #58/#61 closed, #100 re-grounded | open |
| B-0026 | Antenna/RF data triage for [#190](https://github.com/tikoci/rosetta/issues/190): plots are not in brochures (verified by render) but as legacy product-page attachments in three shapes (pattern PDFs, CST `.txt`, `.ant`); modern gear has none (frozen backfill). FCC exhibits sometimes carry vendor antenna datasheets, CE never. Proposes `device_documents` with `rf_content` tags + pattern tables, folded into `routeros_device_lookup` (no new tool), interpretation in a skill | open |
| B-0027 | DB size / command-version retention: 390 MB DB is 76% `command_versions`; 25 identical same-minor snapshots; last-patch-per-minor → ~184 MB; deep-inspect floor is policy not code, bump saves extraction cost not shipped MB; lean is last-patch-per-minor + prev-LT→current-LT deep-inspect window, still thinking | open |

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
