---
id: B-0016-cli-reference-overlay-design
topic: Precursor ETL design for the manual.mikrotik.com CLI-Reference overlay
status: open
related_tasks:
  - "#25"
  - "#28"
  - "#33"
  - "#124"
created: 2026-07-10
last_revisited: 2026-07-20
---

# Question

What exact shape should the CLI-Reference overlay ETL take — table/columns, join key, quasi-provenance
format, and parsing approach — so the ETL half of issue
[#25](https://github.com/tikoci/rosetta/issues/25) can move from "blocked" to a scoped, agent-ready
extractor task?

This briefing exists because issue #25 currently bundles two different kinds of work: (1) ingesting
CLI-Reference data (an ETL problem) and (2) changing `routeros_command_tree`/`routeros_explain_command`
fallback behavior to use that data (a query-core problem). The maintainer flagged this directly on #25
(2026-07-10): *"ETL of /hardware and /cli-reference is needed before this issue can be worked - should
like have issues and/or briefing on the precursor work. Issue correct, but the ETL part of it deserves
its own thinking before tool changes."* This briefing is that precursor thinking for the CLI-Reference
half. `B-0017` covers the parallel `/hardware` half.

## What's grounding this

All of the following is already-verified research, not new — this briefing's job is to turn it into a
concrete extractor spec, not to re-derive it:

- `briefings/B-0012-docusaurus-manual-migration.md` H3 ("CLI Reference survey") did a full 236-page
  census: 223/236 pages have `<ArgTable>`, 69/236 have a `**Package:**` field (19 distinct package
  values), 41/236 have `**Conditions:**` (arch tokens like `!smips` mixed with build-feature flags like
  `BFD_AUTHENTICATION`), 18/236 have `**Syscap:**` (including explicit `chr`/`nochr` markers CHR-based
  `/console/inspect` cannot self-report), 1,150 argument rows carry inline enum values, 397 carry
  `[min .. max]` ranges, 293 carry `alt { ... }` composite/alternative rows. No version-provenance field
  exists anywhere in the 236 pages.
- B-0012 Option D's "overlay sketch": treat parsed CLI-Reference as a **version-less enrichment overlay**
  keyed by command path (+ argument name). Where a path/arg matches restraml `deep-inspect.json` data,
  attach the CLI-Reference URL and manual-only facts (`Conditions`, `Syscap`, human description) to the
  versioned record. Where it doesn't match, keep it as a manual-only row with explicit provenance. Never
  let the overlay assert version facts — it has no version to assert.
- `command-versions-vs-presence.instructions.md`: `command_versions` (full history) and
  `schema_node_presence` (GC'd active-head view) are deliberately separate concepts — an overlay table
  must not collapse into either; it's a third, version-less thing.
- `data-source-naming-product-matrix.instructions.md`: precedent for "don't assume canonical naming
  across sources, keep matching heuristic" — likely applies to command-path matching too if CLI-Reference
  paths ever diverge from `deep-inspect.json` paths (not yet observed, but not verified absent either).
- restraml's `enrich-openapi.ts` already reads rosetta's `ros-help.db` to enrich its own OpenAPI output
  (B-0012 H5) — any new overlay table/column rosetta adds is a potential new input for restraml too,
  worth a heads-up once the shape is settled (same channel as
  [tikoci/restraml#85](https://github.com/tikoci/restraml/issues/85)).
- T-0035's extractor pipeline (`src/extract-docusaurus.ts`) already solved sitemap/`llms.txt` discovery
  and per-page `.md`/`.mdx` fetch with count-check validation (`V-docusaurus-docs-count`) — the
  CLI-Reference overlay extractor should reuse that plumbing, not reinvent discovery.

## Findings — 2026-07-20 extraction experiment

A throwaway extractor + coverage diff were run to answer questions 2 and 4 with data instead of
assumption. Both scripts live at `experiments/cliref-extract.ts` and `experiments/cliref-diff.ts`:
they import nothing from `src/`, write their own `experiments/cliref.db`, and open `ros-help.db`
read-only. TSV output lands in `experiments/out/` (gitignored, regenerable). Diff baseline was
`ros-help.db` @ release `v0.11.1`, synced via `make db-sync` — not a local rebuild.

### Corpus shape

**228 pages → 1,051 command nodes → 11,066 argument rows.** Both totals are asserted against the raw
Markdown (`**Type:**` marker count; `<ArgTableRow>` count) and the extractor throws on mismatch, so a
silent under-parse cannot pass.

The 236 sitemap URLs resolve to 228 real pages: 7 are Docusaurus **generated category stubs**
(`/interface/`, `/ip/hotspot/`, `/ipv6/nd/`, `/system/console/`, `/system/package/`, `/system/script/`,
`/tool/graphing/`) with no Markdown source — `.md`, `/index.md`, and `/.md` all 404 (verified
2026-07-20) — plus the section landing page. Their absence is navigation structure, not a fetch failure.

Per-page counts independently reproduce B-0012 H3's census (41 pages with `Conditions`, 18 with
`Syscap`, 19 distinct `Package` values; 67 vs H3's 69 pages with `Package`, the delta explained by H3
counting over the 236-URL denominator). Per-**node** the same fields are much denser: 417 `Package`,
186 `Conditions`, 46 `Syscap` markers, since one page stacks many commands. Any overlay must key these
to the node, not the page.

### Parsing (answers question 4)

A hardened regex was sufficient — **no MDX/JSX parser needed**. Three edge cases had to be handled and
are the ones a reimplementation will hit again:

1. **Command nesting is by heading level, h1–h6.** Top-level commands (`# app`) sit at h1, colliding
   with the page title's h1, so the MDX preamble (title / blurb / `import` lines / `---` rule) must be
   split off before heading-walking.
2. **`<ArgTableRow>` values span newlines** (`typ="object { composite { ,  }\n }"`), so rows cannot be
   matched line-by-line.
3. **Fenced code blocks contain false headings.** `routing/id` embeds a CLI `print` transcript whose
   row-number column header is a bare `#` line, which parses as a command path. Notably *upstream has
   this bug too*: that garbage line is the page's actual `<h1>`, so **`title` from the page h1 is not
   trustworthy — `toc_name` from `llms.txt` is** (it is also the only source of sidebar labels like
   `caps-man` → "Caps Man", which are not derivable from the slug).

### Join-key robustness (answers question 2)

**The join is not 1:1.** The manual leaks internal RouterOS module names into heading paths that do not
exist in the real CLI:

| Manual heading | Real path |
|---|---|
| `caps-man/acl/access-list` | `/caps-man/access-list` |
| `caps-man/cfg/configuration` | `/caps-man/configuration` |
| `caps-man/controller/manager` | `/caps-man/manager` |

24 of the 144 otherwise-unmatched nodes are this artifact. Spurious segments observed: `remoteap` (4),
`controller` (2), `qos` (2), and one each of `acl`, `cfg`, `chancfg`, `dpathcfg`, `ifaceactual`,
`ratescfg`, `rule`, `seccfg`, `sta`, `poe`, `easymesh`, `route`, `serial-interface`, `ddns`, `ifaces`,
`queues`. The list is small enough to handle but is **not** derivable from a general rule, and no
guarantee exists that it is closed — a future doc rebuild could add more.

This is the finding that most constrains the schema: the overlay needs a normalization step **and** must
store the raw heading path alongside the resolved path, so aliasing is auditable rather than a silent
rewrite. It also echoes `data-source-naming-product-matrix.instructions.md`'s "keep matching heuristic,
don't assume canonical naming" precedent, which the briefing had flagged as *likely* applicable — it is.

### What the overlay actually adds (the payoff)

Node coverage: 907/1,051 manual nodes match inspect; 144 do not (24 aliases + **120 genuinely absent**).
In the other direction 4,819 inspect nodes are standard verbs the manual deliberately omits (confirming
the "lossy vs inspect" framing), plus 146 non-verb inspect-only nodes.

Argument coverage, of 10,118 `Argument`/`Read-only Argument` rows (`Flag` rows excluded — see below):

- **3,852 read-only arguments with no inspect equivalent at all.** Spot-checked: `/ip/address`'s
  `actual-interface` and `vrf` appear nowhere in `schema_nodes`. `/console/inspect` exposes only
  settable args per verb, making read-only state a *categorical* blind spot. This is the single largest
  additive win and was not anticipated in H3.
- **120 command menus absent from inspect** — `interface/bridge/msrp/*` (build-flag `MSRP_ENABLE`),
  `interface/ethernet/poe/*`, `interface/ethernet/switch/acl/*`, `disk` RAID. 94 of the 144 unmatched
  nodes carry an explicit `Package`/`Conditions`/`Syscap` value stating *why* a CHR cannot see them.
- **541 settable args on menus inspect does have**, concentrated exactly where hardware gating predicts:
  `interface/wifi` (129), `interface/wifi/configuration` (104), `interface/ethernet/switch/port` (54),
  `caps-man/interface` (51), `routing/bgp` (42). CHR has the package but no radio.
- 948 `Flag` rows (print-output flag letters, `X` = disabled) have **no inspect concept by
  construction** — scoring them as "missing" would overstate coverage, so the diff reports them apart.
- 364 arguments carry their own per-argument `syscap`, distinct from the node-level gate.

Caveat on prose value: only **1,657 of 10,118** argument rows have a non-empty description. The overlay's
value is overwhelmingly *structural* (existence, gating, type) rather than *narrative*.

### Strawman schema that survived the experiment

Three tables, `cliref_`-prefixed, standalone rather than columns on `schema_nodes` — which is
question 1's option (a), and the experiment gives it two independent reasons beyond the
versions-vs-presence separation principle: read-only args and `Flag` rows have no `schema_nodes` row to
hang a column off at all, and the alias problem means the join key itself needs storage.

```text
cliref_pages (slug PK, url, toc_name, title, toc_group, node_count, arg_count)
cliref_nodes (node_id PK, slug FK, path_raw, path_resolved, heading_level, type,
              package, conditions, syscap, …)
cliref_args  (arg_id PK, node_id FK, path_resolved, table_kind, name, raw_type, mandatory,
              unsettable, syscap, description, …)
```

`path_raw` is the verbatim heading path; `path_resolved` is the normalized join key (see
"Join-key robustness"). Storing both is what keeps alias resolution auditable rather than a silent
rewrite — the same pair named in #124's acceptance criteria.

`raw_type` is stored **unparsed** on purpose — enums (`enum (a | b)`), ranges (`num { 0..7 }`), and
composites (`composite { , }`) are a separate pass, deliberately not blocking the structural work.

## Recommended next steps

1. ~~**Cut a scoped extractor issue**~~ **Done 2026-07-20 → [#124](https://github.com/tikoci/rosetta/issues/124)**
   (`agent-ready`, ETL only). The alias-normalization table and the raw-vs-resolved path pair are named in
   its acceptance criteria, and a `VALIDATION.md` V-row bounding the unmatched-node count addresses Q7.
2. **Keep #25's query-behavior half separate.** Nothing here argues for changing
   `routeros_command_tree`/`routeros_explain_command` yet — question 5 is still open, and the read-only-arg
   finding may change what the right surface is.
3. **Defer type parsing** to its own pass once the structural overlay is auditable.
4. **Heads-up to restraml** once the table shape is settled, per the `enrich-openapi.ts` channel noted
   above — the read-only-argument set is directly relevant to OpenAPI response schemas, which is a
   stronger reason to notify than existed when this briefing was written.

## Open design questions

Questions 2 and 4 are **answered** by the 2026-07-20 experiment above; 1 has a defended strawman.
The rest still need answers before the ETL half of #25 is spec-settled enough for `agent-ready`:

1. ~~**Table shape.**~~ **Decided 2026-07-20: three standalone `cliref_*` tables**, not columns on
   `schema_nodes`. The experiment gave two reasons beyond the version-less/versioned separation principle
   (`command_versions` vs `schema_node_presence`): read-only args and `Flag` rows have no `schema_nodes`
   row to hang a column off at all, and the alias problem means the join key itself needs storage
   (`path_raw` + `path_resolved`). The rejected columns-on-`schema_nodes` alternative would have risked the
   concept-collapse the versions-vs-presence instruction warns against. See "Strawman schema" above; the
   remaining tradeoff inside the three-table design (the extra join at query time) is accepted. Open
   sub-question folded into Q9 below: whether `Flag` rows share `cliref_args` or get their own table.
2. ~~**Join key robustness.**~~ **Answered 2026-07-20: no, not 1:1.** 24 nodes carry a spurious internal
   module segment (`caps-man/acl/access-list` → `/caps-man/access-list`). Needs a normalization step plus
   a stored raw-vs-resolved path pair. See "Join-key robustness" above.
3. **Quasi-provenance format.** #25 proposes text like *"applies to stable; current stable at import time
   was X.Y"* — needs an exact column (or JSON shape) and a defined source for "current stable at import
   time" (restraml's own version detection? a live `/system/package/update` style check? hardcoded at
   extraction time?).
4. ~~**Parsing approach.**~~ **Answered 2026-07-20: hardened regex suffices, no MDX parser.** Three edge
   cases must be handled: preamble/title h1 collision, newline-spanning `typ=` values, and false headings
   inside fenced code blocks. See "Parsing" above.
5. **What surfaces to agents, and how.** `Conditions`/`Syscap`/`Package` are manual-only facts
   `/console/inspect` can't produce (B-0012 H3, point 3: `nochr`/`chr` as an explicit example). Do these
   show up as advisory notes on `routeros_explain_command`/`routeros_command_tree` results, a new field,
   or only via the CLI-Reference URL pointer? This is where the ETL question and #25's query-behavior
   question meet — the overlay's shape should be decided with the consuming shape in mind, even though
   the query-behavior change itself stays out of scope here.
6. **Coverage gaps.** 12/228 pages have no `<ArgTable>` at all (text-only; H3 counted 13/236 on the
   larger denominator) — what does the overlay do for those (skip, or store the manual URL/description-only
   row)? Sharper now that node-level counts exist: **193 of 1,051 nodes have zero arguments**, so the
   argument-less case is normal at node granularity, not a rare page-level exception.

### New open questions raised by the experiment

7. **Is the alias list closed?** 19 spurious path segments were observed, but nothing guarantees a future
   docs rebuild won't add more. Does the extractor hard-fail on an unrecognized unmatched path, or record
   it as manual-only and let the count drift? Failing loud matches the repo's crash-early stance but will
   break extraction on upstream edits; a `VALIDATION.md` row on the unmatched-node count may be the better
   instrument.
8. **How should read-only arguments surface?** The 3,852 read-only args are the overlay's biggest
   addition and have no `schema_nodes` counterpart, so they are not an *enrichment* of anything — they are
   new rows. That partly reframes question 5: the overlay is not purely advisory metadata on existing
   records. Relevant to restraml too (OpenAPI response schemas).
9. **Do `Flag` rows belong in the same table as arguments?** They currently share `cliref_args`
   discriminated by `table_kind`, but they are print-output flag letters, not arguments — a different
   concept sharing a shape. Splitting them costs a table; keeping them risks a consumer treating `X` as a
   settable argument.
10. **Does the page `title` field earn its place?** It is untrustworthy (upstream h1 bug, see "Parsing")
    and `toc_name` is strictly better. Keeping it is defensible only as provenance for detecting upstream
    fixes.

## Current lean

**Lean, as of 2026-07-20:** a standalone three-table `cliref_*` overlay (question 1, now decided),
normalized join key with the raw heading path retained (`path_raw` + `path_resolved`), types stored
unparsed. The scoped extractor issue is cut ([#124](https://github.com/tikoci/rosetta/issues/124));
questions 3 (provenance format) and 5 (agent surfacing) remain genuinely open and do not block it.
Question 5 in particular is now better answered *after* the overlay exists and can be inspected, since
the read-only-argument finding changed what there is to surface.

Still deliberately unresolved: the briefing stays `open` until #124's extractor lands and is validated
**and** question 3 has an answer — the issue-cut gate is already cleared.

## Open questions

See "Open design questions" above. Questions 1, 2, and 4 are settled; 3, 5, 6 and new questions 7–10
remain. Next revisit trigger: #124 landing, or any upstream docs rebuild that changes the page count away
from 228.
