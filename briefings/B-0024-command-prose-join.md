---
id: B-0024-command-prose-join
topic: The command↔prose join — should `commands.page_id` stop being a single fuzzy page-grained scalar?
status: open
related_tasks: ["#58", "#61", "#131", "#132", "#100", "#25", "B-0001", "B-0011", "B-0016", "B-0023"]
created: 2026-07-31
last_revisited: 2026-07-31
---

# Question

Rosetta holds RouterOS structure and RouterOS prose in different stores, and joins them through
exactly one column: `commands.page_id`. That column is a **nullable scalar**, **page-grained**, and
produced by a **fuzzy slug-trailing heuristic** (`src/link-ranking.ts`). Every property lookup that
takes a command path passes through it.

Should that join be replaced by one that is *corroborated* (against curated structure), *section-grained*
(B-0023's unit, not the page), and *multi-evidence* (able to say "this page is the reference owner, that
one is a related guide")?

This briefing exists because #58, #61, and #131 have been filed and re-filed as three separate linkage
bugs across three releases, and each fix has moved the symptom rather than closed the class. The
2026-07-31 triage of #131/#132 measured the join directly for the first time; that measurement is below
and it reframes all three.

# What's grounding this

All figures measured 2026-07-31. Extractor findings come from the vendored source Markdown
(`manual/pages/**`) plus running the real `parseProperties()` on it — independent of any DB. Linkage
findings come from repo-root `ros-help.db`, which carries no `meta` table (untrusted per
`local-db-grounding.instructions.md`) but reproduces the v0.11.1 figures in #131 exactly
(1,552 NULL / 23→page 26 / 14→page 344), so it is the same corpus.

## The measurement that reframes #58/#61/#131

Actual `lookupProperty(name, commandPath)` output today:

| Call | Returns | Confidence | Verdict |
|---|---|---|---|
| `auto-update @ /app/add` | `*yes* &#124; *no*` ×2 | **high** | high + wrong |
| `address @ /interface/veth/add` | `"IPv4/IPv6 address"` | **high** | high + wrong |
| `vlan-ids @ /interface/bridge/vlan/add` | correct prose, section `bridge-vlan-table` | **low** | right answer, wrong label |
| `pvid @ /interface/bridge/port/add` | correct page-10 prose ×3, Apps `*integer*` ranked **first** | **low** | right, mislabeled, polluted |

Three consequences, none of which were visible from the issue text alone:

1. **#131's "unreachable / dead data" framing is wrong.** The `pvid` prose *is* returned, with correct
   `section_anchor` values (`bridge-interface-setup`, `port-settings`, `bridge-port-settings`). What is
   broken is the **confidence label** and the **ordering** — not reachability. This materially shrinks
   #131 and turns its proposed acceptance criterion ("resolves HIGH to page 10") into a confidence
   *recalibration*, not a linkage fix.

2. **The extraction bug (#132) is the higher-severity defect.** It is the only one producing
   **high-confidence wrong content**. A mislabeled-but-correct answer degrades trust; a `high` badge on
   `"IPv4/IPv6 address"` (the Type cell, not the description) actively misleads a downstream consumer.

3. **#132 pollutes #131.** `lookupProperty`'s global fallback orders by `pg.title`, so `"Apps"` sorts
   before `"Bridging and Switching"` and the corrupted `pvid = *integer*` row leads **every** unscoped
   `pvid` lookup. Fixing #132 measurably improves the bridge symptom with no linker change at all.

## Why the fuzzy join cannot reach the bridge reference content

`scoreCandidate()` simulated against the real candidates (`src/link-ranking.ts`):

```text
  2000  /interface/bridge/vlan -> 344 VLANs on Wireless     (0 props)   <- wins
     0  /interface/bridge/vlan -> 27  Bridge VLAN Table     (0 props)
     0  /interface/bridge/vlan -> 10  Bridging and Switching (226 props)
  2030  /interface/bridge      -> 26  Bridge IGMP/MLD       (30 props)  <- wins
  2000  /interface/bridge      -> 27  Bridge VLAN Table     (0 props)
     0  /interface/bridge      -> 10  Bridging and Switching (226 props)
```

- `vlans-on-wireless`.startsWith(`vlan`) scores 2 under `segMatch`; `bridge-vlan-table` scores 0. That is
  the whole of #131's first defect.
- Page 26 beats page 27 only on `propCount` (2030 vs 2000).
- **Page 10 scores 0 in every case and no segment-matching tweak reaches it.** `bridging-and-switching`
  versus `bridge` would require stemming, not hyphen-splitting. This is the load-bearing finding: the
  page holding all 226 bridge property rows is *structurally unreachable* by the current ranker, so
  "link bridge to page 10" is not a scorer change — it is new machinery.
- Both pages 10 and 27 **are already candidates** (page 10 mentions `/interface/bridge/vlan` 9×, page 27
  7×). They are being scored to zero, not missed.
- There is **no override/anchor mechanism in `link-commands.ts` today.** The "#62 anchors" (firewall,
  DHCP, WireGuard, VXLAN) cited during triage are not curated anchors; they are cases where slug
  alignment happens to work, plus unit cases in `link-ranking.test.ts`.

## The structural picture

| Store | Authoritative for | Prose |
|---|---|---|
| `schema_nodes` / `commands` (inspect, versioned) | existence per version | none |
| `cliref_*` (version-less overlay, landed #124/#126/#128) | CLI shape, `Package`/`Conditions`/`Syscap`, read-only args | sparse — B-0016 measured 1,657 of 10,118 arg rows |
| `pages` / `sections` / `properties` | — | **the only narrative source** (B-0001's own finding) |

`commands.page_id` is the only bridge between the structure stores and the prose store. Its four
limitations map one-to-one onto the open issues:

| Limitation | Symptom | Issue |
|---|---|---|
| **Scalar** — one page per command | cannot express "page 10 is the reference owner, page 27 is the related guide" | #131 |
| **Page-grained** | cannot target the section that actually documents the property | #131, B-0023 |
| **Fuzzy** | page 10 unreachable at any score; `/ip/dhcp-server address-pool` → `hotspot-captive-portal` | #58 |
| **Lossy / one-directional** | 26.8% of linkable rows linked; prose-only and dotted properties never join | #61 |

# The candidate answer: corroborate instead of scope

`lookupProperty` currently uses `commands.page_id` as a **scope gate**: resolve path → page, then only
look at properties on that page; fall back to a global name search at `low`. That gate is what produces
both failure modes — a wrong page yields `high` + wrong, and a NULL/empty page discards a correct global
answer down to `low`.

The CLI-Reference overlay that landed in #124/#126/#128 supplies the missing piece: `cliref_entries.source_path`
plus `cliref_field_inspect_links` is a **curated, auditable, exact/alias-resolved** command→field-name
index. Verified in the vendored source: `manual/cli-reference/interface__bridge.md` carries `pvid` at
both bridge levels (lines 56 and 1025).

So the join could invert:

- **Corroborate** — ask cliref "does this command path really have a field named `pvid`?" That is a
  curated yes/no, not a slug heuristic.
- **Rank** — use `commands.page_id`, page/section title alignment, and property count as *evidence* for
  ordering, not as a gate.
- **Reject** — a candidate row whose page belongs to an unrelated cliref entry (the Apps `*integer*` row,
  whose entry is `/app`, not `/interface/bridge`) drops out on corroboration.

Applied to the measurement table, this returns the page-10 `pvid` rows at **high** for
`/interface/bridge/port/add`, and drops the Apps row — without any change to `link-commands.ts`.

**Why cliref does not replace `properties`:** B-0016 measured only 1,657 of 10,118 argument rows carrying
prose. The overlay is *structural, not narrative*. That is precisely why it works as the index while
`properties` remains the content — they are complementary, not competing.

**Caveat — untested end to end.** `cliref_entries` is empty (0 rows) in the local `ros-help.db`, so this
was reasoned from B-0016's measured coverage plus the vendored `manual/cli-reference/*` source, not
executed. Confirming it against a DB with the overlay populated is the first homework item.

# Relationship to the other briefings

## B-0023 (page/section normalization) — a second, independent consumer

B-0023 lists **#27 (MCP/TUI surface alignment)** as the consumer of total section coverage. The
command↔prose join is a **second consumer, and a correctness driver rather than a UX one**: the join
wants to target a *section*, because "the page that owns `/interface/bridge`" has no good answer while
"the section that documents `pvid` for bridge ports" does.

Two refinements, neither of which changes B-0023's decision (Option A / `_lead` stands):

- **#131 does not need B-0023.** The bridge property rows already carry correct `section_id` and anchors;
  section granularity is available for this case today. What is missing is a *join* that can use it.
- **B-0023's priority rises**, because it now has two consumers and one of them is a correctness bug
  class rather than a future ergonomics win.

## B-0016 (CLI-Reference overlay) — Q5 gets its first concrete consumer

B-0016 Q5 ("what surfaces to agents, and how") has been open pending something to surface. The
corroborated join is a consumer that is **not** advisory metadata: it uses the overlay as a
correctness input to an existing tool rather than as a new note on a result. That is a stronger
justification for #25's query-behavior half than its current arch-as-advisory framing.

## B-0001 / B-0011 (retire `routeros_lookup_property`) — revisit trigger

B-0001 resolved (2026-07-14) that `lookup_property` should be **retired**, folding exact lookup into
`routeros_get_page` (surface page-extracted properties) and `routeros_command_tree` (point at related
paths). B-0011 carries that as a consolidation candidate.

The 2026-07-31 measurement is a revisit trigger, for two reasons:

1. **Both fold targets sit on the wrong side of the broken join.** `get_page` is page-scoped — it assumes
   the page is the right one. `command_tree` surfaces `page_title`/`page_url` through that same
   `commands.page_id`. Folding the lookup into them does not remove the fuzzy join; it hides it.
2. **`lookupProperty` is the only surface carrying the `high | medium | low` honesty signal**
   (`src/query.ts:1054`), and the measurement shows that signal is currently **miscalibrated in both
   directions** — `high` on corrupted Apps/VETH rows, `low` on correct bridge rows. Neither fold target
   has a way to express that uncertainty, so folding now would launder it.

The resulting sequencing, agreed with the maintainer 2026-07-31: **fix the join, recalibrate confidence,
then decide the surface.** B-0001's retirement lean is not overturned — it is *conditioned*. The
extraction ETL behind the tool was never in question (B-0001 already says so) and still is not.

# Options considered

### A. Corroborated, section-grained join — **current lean**

Demote `commands.page_id` from scope gate to ranking evidence; corroborate candidate property rows
against `cliref_*`; return `section_anchor` as the addressable unit; recalibrate confidence so it
reflects corroboration rather than "did the fuzzy link fire."

- **Pros:** fixes #58 and #131's real half without touching the ranker; makes the confidence signal
  honest, which is the precondition for B-0001/B-0011's retirement decision; uses the overlay that just
  landed rather than building new curation machinery; degrades gracefully where cliref has no entry
  (fall back to today's behavior).
- **Cons:** unproven end to end (cliref empty locally); cliref coverage is not total — 144 of 1,051
  manual nodes do not match inspect, and manual-only entries have no field links, so some commands get
  no corroboration signal at all; needs a decision on what confidence means when cliref is silent.

### B. Curated page-ownership table (the 2026-07-31 triage suggestion)

Hand-curate "page 10 owns the `/interface/bridge` subtree", keyed by stable `rosetta_id`, inherited
recursively through `dir`/`cmd` descendants.

- **Pros:** directly fixes the bridge case; explicit and auditable.
- **Cons:** new machinery that does not exist today; hand-curation does not scale to the 1,552 unlinked
  bridge rows' equivalents corpus-wide; picks page 10 *or* page 27 when the honest answer is "10 for
  reference, 27 for the guide" — i.e. it works around the scalar limitation instead of removing it;
  the curated list has the same "is it closed?" problem B-0016 Q7 already flags for the alias list.

### C. Loosen the ranker (hyphen-component matching)

Split slug segments on `-` and score exact component matches above prefix matches, so `bridge-vlan-table`
beats `vlans-on-wireless`.

- **Pros:** small, unit-testable, fixes the visibly-silly `/interface/bridge/vlan` → *VLANs on Wireless*
  mislink; improves what `get_page`/`command_tree` point a human at.
- **Cons:** **does not fix property lookup** — page 27 has zero property rows, so a scoped lookup finds
  nothing and falls through to the same global result as today. Cannot reach page 10 at all. Risks
  reintroducing #58-class mislinks corpus-wide without a before/after audit.
- **Disposition:** worth doing as a *cosmetic* fix on its own merits (this is what #131 should be
  narrowed to), but must not be sold as fixing the reported problem.

### D. Do nothing; keep the honest `low`

- **Pros:** the correct answer is already returned today for the bridge case.
- **Cons:** leaves `high` + wrong (#132's class) unaddressed once extraction is fixed elsewhere; leaves
  the confidence signal uninterpretable, which blocks B-0001/B-0011 indefinitely.

# Recommended next steps

1. **Land #132 first.** Highest severity (only producer of `high` + wrong), and it removes the Apps row
   that pollutes every global `pvid` lookup. It must also precede #100 — see below.
2. **Narrow #131 to Option C** (ranker fix only), stating explicitly in the issue that it does not fix
   property lookup.
3. **Homework for Option A:** rebuild with `cliref_*` populated and re-run the measurement table. Confirm
   the corroboration step returns page-10 `pvid` at `high` for `/interface/bridge/port/add` and drops the
   Apps row. Report cliref-silent coverage so the "what does confidence mean when cliref has no entry"
   question can be answered with data.
4. **Re-anchor #58 and #61 here** rather than carrying them as independent linkage bugs.
5. Revisit B-0001/B-0011 only after step 3.

# A sequencing constraint discovered alongside this (#132 → #100)

Not part of the join, but found in the same pass and recorded here because it is easy to lose:
`parseProperties()` hardcodes `description: row.cells[1]` (`src/extract-docusaurus.ts:375`). A census of
all 589 property/parameter tables in the vendored corpus:

| Count | Header shape | Current behavior |
|---|---|---|
| 573 | `Property\|Description`, `Parameter\|Description` | correct |
| 5 | `Property \| Description \| ` (ragged trailing) | correct |
| 5 | `Property\|Type\|Default\|Description` | **52 rows column-shifted** (apps 45, veth 7) |
| 2 | `Property\|Type\|Description` | 70 rows yield **nothing** (bold-kebab name gate) |
| 1 | `Parameter\|Description\|Example` | correct (16 rows) |
| 1 | `Feature / Property\|Home\|Basic\|Advanced\|ROSE` | **14 fabricated rows** |
| 1 | `Parameter\|Value` · 1 `Menu\|Parameter names\|Page link` | yield nothing (fine) |

Two findings that are not in #132 as filed:

- **`system-information-and-utilities/device-mode.md:85` produces 14 rows that are not properties at
  all.** A device-mode feature matrix passes the header gate because its first cell reads
  `**Feature / Property**`. Source rows look like `| **Containers** (/container) | No | No | No | Yes |`,
  so `parsePropertyCell` takes `Containers` as the name and `(/container)` as the type annotation, and
  `cells[1]` — the *Home* column — becomes the description. Output includes `Containers` /
  `type="/container"` / `description="No"`, `IPsec` → `"Yes"`, plus `Email`, `Fetch`, `Hotspot`, `PPTP`,
  `SMB`, `Proxy`, `RoMon`, `Scheduler`, `Sniffer`, `ZeroTier`, `Partitions`, `L2TP`. (Only 14 of the 19
  rows survive; multi-word names like `**Bandwidth Test**` fail the kebab gate.) Resolving columns by
  header name *and requiring a Description column* eliminates these for free. The two tables newly
  excluded by that rule already yield zero rows, so there is no regression cost.

  **Why #100's audit did not catch this.** The #100 classification enumerated the 27 tables that pass the
  header gate and yield **zero** properties, then judged each accept/reject — and correctly rejected a
  device-mode table on that basis. But a table producing *wrong* rows is not in the zero-yield set, so it
  was structurally invisible to that audit. "Which property-headed tables yield nothing?" and "which
  property-headed tables yield garbage?" are two different coverage questions, and only the first has ever
  been asked. A census by **header shape** (above) asks the second.
- **#132 must land before #100.** The two `Property|Type|Description` tables in
  `route-selection-and-filtering.md` hold 70 data rows that currently yield zero properties because of
  the name gate #100 targets. If #100 loosens that gate first, those 70 rows ingest with Type-as-description
  — the same bug, 70 more rows.

# Open questions

- **What does confidence mean when cliref is silent?** 144 of 1,051 manual nodes do not match inspect,
  and manual-only entries carry no field links. Is "cliref has no entry for this path" a reason to stay
  at today's behavior, or its own confidence tier?
- **Does the corroborated join subsume the ranker, or coexist with it?** Option A leaves
  `commands.page_id` in place as ranking evidence. If corroboration proves strong enough, is the fuzzy
  link still worth computing at all — and what breaks in `get_page`/`command_tree` if it goes?
- **Where does the "reference owner vs related guide" distinction live** once the scalar limitation is
  acknowledged? A second column, a link table, or a section-level link that makes the question moot?
- **#61's prose-only properties are still out of reach.** Corroboration tells you `/ip/firewall/filter`
  has an `action` field; it does not extract a description from a prose bullet list. Does that stay a
  parser problem, or does the schema surface "known, undocumented" honestly (as #61 asks)?
- Next revisit trigger: #132 landing, or a rebuild with `cliref_*` populated — whichever comes first.
