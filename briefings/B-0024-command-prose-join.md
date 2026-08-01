---
id: B-0024-command-prose-join
topic: The command↔prose join — `commands.page_id` is a page-level proxy for a key that does not exist
status: open
related_tasks: ["#58", "#61", "#131", "#132", "#100", "#25", "B-0001", "B-0011", "B-0016", "B-0023"]
created: 2026-07-31
last_revisited: 2026-08-01
---

# Question

Rosetta holds RouterOS structure and RouterOS prose in different stores. A `properties` row has
`page_id`, `section_id`, and `source_table_row_id` — **no** column identifying the command it
documents. `commands.page_id` is the only thing standing in for that missing key, and it is a
nullable **scalar**, **page-grained**, and produced by a **fuzzy slug-trailing heuristic**
(`src/link-ranking.ts`).

What should the real key be, and can it be built from data that already ships?

This briefing exists because #58, #61, and #131 have been filed and re-filed as three separate
linkage bugs across three releases, and each fix has moved the symptom rather than closed the class.

# What's grounding this

Two different sources, deliberately:

- **Extractor findings** come from the vendored source Markdown (`manual/pages/**`) plus running
  the real `parseProperties()` on it — independent of any DB.
- **DB findings** are measured on the CI release artifact **`v0.11.2-alpha.109`**
  (`schema_version` 11, `source_commit` `4cd7413` = current `main`), synced via `make db-sync` per
  `local-db-grounding.instructions.md` — not a local rebuild and not the repo-root DB.

That artifact already ships the CLI-Reference overlay: **228** `cliref_pages`, **1,051**
`cliref_entries`, **10,118** `cliref_fields`, **931** stored `cliref_entry_schema_links`, and
**13,036** rows through the computed `cliref_field_inspect_links` view.

> **Provenance note.** An earlier draft called the repo-root DB "untrusted, no `meta` table". That
> was a wrong check — the provenance table is **`db_meta`**, and it reports the repo-root DB as
> exactly `v0.11.1` / `e00bc69` / schema 10. There was never any need to infer corpus identity from
> matching aggregate counts. Use `db_meta`, and prefer the synced CI artifact regardless.

## Pre-fix baseline: what the join returned before #132

**These four rows are the v0.11.1 baseline, measured before the #132 parser fix landed** (PR #133).
The first two are *corrected* by that fix; they are retained because they are what made the
confidence signal's behaviour legible:

| Call | Returned (pre-fix) | Confidence | Verdict |
|---|---|---|---|
| `auto-update @ /app/add` | `*yes* &#124; *no*` ×2 | **high** | high + wrong — **fixed by #132** |
| `address @ /interface/veth/add` | `"IPv4/IPv6 address"` | **high** | high + wrong — **fixed by #132** |
| `vlan-ids @ /interface/bridge/vlan/add` | correct prose, section `bridge-vlan-table` | **low** | right answer, wrong label |
| `pvid @ /interface/bridge/port/add` | correct page-10 prose ×3, Apps `*integer*` ranked **first** | **low** | right, mislabeled, polluted |

Three consequences, none visible from the issue text alone:

1. **#131's reachability claim, stated precisely.** The issue is right that the bridge properties are
   unreachable *through `commands.page_id` / command-grounded lookup* — that join is genuinely
   absent. What the measurement adds is that the rows remain **globally discoverable**: the
   same-name fallback returns the page-10 prose with correct section anchors, at `low`. That
   fallback is useful recovery, **not** evidence that those rows document the requested command.
   The defect is the missing join; the confidence label and the ordering are how the absence
   surfaces. (An earlier draft of this briefing over-corrected to "the framing is wrong" — that
   overstated it.)

2. **The extraction bug (#132) was the higher-severity defect**, because it was the only one
   producing **high-confidence wrong content**. A mislabeled-but-correct answer degrades trust; a
   `high` badge on `"IPv4/IPv6 address"` (a Type cell) actively misleads.

3. **#132 was polluting #131.** The global fallback orders by `pg.title`, so `"Apps"` sorted before
   `"Bridging and Switching"` and the corrupted `pvid = *integer*` row led **every** unscoped `pvid`
   lookup. Fixing #132 improved the bridge symptom with no linker change at all.

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

- `vlans-on-wireless`.startsWith(`vlan`) scores 2 under `segMatch`; `bridge-vlan-table` scores 0.
- Page 26 beats page 27 only on `propCount` (2030 vs 2000).
- **Page 10 scores 0 in every case and no segment-matching tweak reaches it.**
  `bridging-and-switching` versus `bridge` would require stemming. The page holding all 226 bridge
  property rows is *structurally unreachable* by the current ranker.
- Both pages 10 and 27 **are already candidates** (page 10 mentions `/interface/bridge/vlan` 9×,
  page 27 7×). They are scored to zero, not missed.
- There is **no override/anchor mechanism in `link-commands.ts`.** The "#62 anchors" (firewall,
  DHCP, WireGuard, VXLAN) are cases where slug alignment happens to work, plus unit cases in
  `link-ranking.test.ts`.

## The structural picture

| Store | Authoritative for | Prose |
|---|---|---|
| `schema_nodes` / `commands` (inspect, versioned) | existence per version | none |
| `cliref_*` (version-less overlay, landed #124/#126/#128) | CLI shape, `Package`/`Conditions`/`Syscap`, read-only args | sparse — B-0016 measured 1,657 of 10,118 field rows |
| `pages` / `sections` / `properties` | — | **the only narrative source** (B-0001's own finding) |

Four limitations of the stand-in key, mapping onto the open issues:

| Limitation | Symptom | Issue |
|---|---|---|
| **Scalar** — one page per command | cannot express "page 10 is the reference owner, page 27 is the related guide" | #131 |
| **Page-grained** | cannot target the section that documents the property | #131 |
| **Fuzzy** | page 10 unreachable at any score; `/ip/dhcp-server address-pool` → `hotspot-captive-portal` | #58 |
| **Lossy / one-directional** | 26.8% of linkable rows linked; prose-only and dotted properties never join | #61 |

# What the CLI-Reference overlay can and cannot do

The complete crosswalk is a two-hop join, and both hops matter:

```text
cliref_entries.source_path                     -- verbatim heading path, normalized only
  -> cliref_entry_schema_links (STORED)        -- carries the exact | alias resolution decision
     -> schema_nodes.path                      -- the inspect command coordinate
cliref_fields.name  (entry_id -> cliref_entries)
  -> cliref_field_inspect_links (COMPUTED VIEW) -- zero-to-many field -> inspect `arg` nodes
     -> schema_nodes.path
```

Only the **entry** link is stored, because it carries the non-derivable exact/alias decision; field
links are a view so they cannot go stale against a rebuilt `schema_nodes` (B-0016).

**What it proves.** Verified on the artifact — the view yields `/interface/bridge/add/pvid`,
`/interface/bridge/set/pvid`, `/interface/bridge/port/add/pvid`, `/interface/bridge/port/reset/pvid`.
So `(`/interface/bridge/port/add`, `pvid`)` is a real, curated field.

**What it cannot do — and this is the correction that reshaped this briefing.** That result is a
**boolean about the query**, not about a candidate row. Every globally-found property named `pvid`
gets the identical answer:

| property id | page | section | corroboration says |
|---|---|---|---|
| 486 | 10 Bridging and Switching | Bridge Interface Setup | field exists ✓ |
| 541 | 10 Bridging and Switching | Port Settings | field exists ✓ |
| 609 | 10 Bridging and Switching | Bridge Port Settings | field exists ✓ |
| 1474 | 38 **Apps** | Properties | field exists ✓ |

There is no relational edge to break the tie: `properties` has no `entry_id` / `field_id` /
`schema_node_id`, and `cliref_entries.page_id` references **`cliref_pages`**, a different page store
from `properties.page_id -> pages`. An earlier draft claimed corroboration could promote the bridge
rows and reject the Apps row. **It cannot.** Confirmed empirically on `v0.11.2-alpha.109`.

The rule that follows: **do not label a result `high` merely because the requested field exists.**
High confidence needs evidence that *the returned prose row* documents that field, or the design
launders the same ambiguity it set out to fix.

# Options considered

### A. Fragment-grained path extraction as the candidate key — **measured: a ranking signal, not a key**

Extract RouterOS menu paths from each **section's** text (not each page's, as `link-commands.ts`
does today) and use path alignment *of the candidate row's own fragment* as the discriminating
evidence. B-0023's total section coverage — landed in PR #105 — is what makes every property row
reachable from an addressable fragment.

Measured on `v0.11.2-alpha.109`, for the four `pvid` candidates — **every** path each section's text
contains, with the `isRouterOsPath()` verdict, not just the convenient ones:

| Section | Page | Rows sharing it | Paths in its own text |
|---|---|---|---|
| `Port Settings` (147) | 10 | 26 | `/interface/bridge/port/set`, `/interface/bridge/port`, ~~`/virtual-private-networks/eoip`~~ |
| `Bridge Port Settings` (168) | 10 | 4 | `/interface/bridge/port` |
| `Bridge Interface Setup` (140) | 10 | **49** | `/interface/bridge`, `/interface/bridge/host`, **`/ip/settings`**, ~~`/firewall-and-quality-of-service/packet-flow-in-routeros`~~ |
| `Properties` (666) | 38 Apps | 14 | ~~`/authentication-authorization-accounting/certificates`~~ (no menu path) |

(~~struck~~ = rejected by `isRouterOsPath()`, whose first segment must be a known top-level menu.)

It discriminates on this family — the Apps section carries no `/interface/bridge` signal at all, so
the row that pollutes today's lookup drops out. **But the same artifact shows the granularity is too
coarse to call this a row-level key:**

- **`/ip/settings` survives the filter.** `ip` is in the top-level allowlist (`src/link-commands.ts:82`),
  so it is accepted as a real menu path even though it has nothing to do with `pvid`. The doc-slug
  filter catches relative links; it does not catch a genuine but unrelated menu mention.
- **A section is shared by every property in it.** All **49** rows under `Bridge Interface Setup`
  inherit that section's entire path set, `/ip/settings` included. Section-grained alignment is a
  *fragment*-level signal being used as a *row*-level one.

- **Pros:** built from data that already ships; reuses `link-commands.ts`'s existing extraction and
  `isRouterOsPath()`; degrades to today's behaviour when a fragment mentions no path; naturally
  multi-valued, so the scalar limitation disappears. **Measured:** 75.6% conditional precision and a
  6.5× narrower candidate set than page granularity.
- **Cons:** the coarseness above, now quantified — **42.7%** of property-owning sections name no menu
  path (the guess that this is common on prose-only pages was right, and it is the dominant failure
  mode), and a section is shared by every property in it, so it can never separate two rows under the
  same heading. See "Step 3 result" below.
- **A table-grained key is *not* the nearer key — checked, and it is the same key.** An earlier draft
  suggested `properties.source_table_row_id` → `page_table_rows` → `page_tables` as a strictly finer
  fragment. On `v0.11.2-alpha.109` it is not: section 140's 49 properties all point into **one**
  table (id 70, 49 data rows, zero properties without a `source_table_row_id`), its `source_heading`
  is the bare text `Bridge Interface Setup` with no path in it, and the paths inside its own
  `raw_markdown` are the *same set* the section yields — `/interface/bridge` ×2,
  `/interface/bridge/host`, and `/ip/settings`. Table granularity collapses onto section granularity
  here and cannot improve this example.

  What would actually help is **positional**, not structural: the `/interface/bridge` submenu context
  precedes the table in the source, and the discriminating signal is proximity to the property's own
  row — a *nearest-preceding-menu-path* join. That needs source-position provenance the schema does
  not carry today. (An earlier draft said `page_tables` and `page_table_rows` "retain line spans".
  They do not — the only ordering column on either is `sort_order`, and `properties` carries none at
  all. Verified against `v0.11.2-alpha.109`; the census prints the full column lists so this cannot be
  asserted from memory again.) Treat it as a candidate requiring new provenance, not an existing key
  to switch to.
- **CLI-Reference's role here is secondary but real:** it validates `(requested path, name)` — that
  the field exists at all — which is what distinguishes "no prose found for a real field" (#61's
  honest "known, undocumented") from "no such field". It does **not** rank candidates.

### B. Curated page-ownership table

Hand-curate "page 10 owns the `/interface/bridge` subtree", keyed by stable `rosetta_id`, inherited
recursively through `dir`/`cmd` descendants.

- **Pros:** directly fixes the bridge case; explicit and auditable.
- **Cons:** new machinery; hand-curation does not scale corpus-wide; picks page 10 *or* page 27 when
  the honest answer is "10 for reference, 27 for the guide"; has the same "is the list closed?"
  problem B-0016 Q7 already flags for the alias list.

### C. Loosen the ranker (hyphen-component matching)

Split slug segments on `-` and score exact component matches above prefix matches, so
`bridge-vlan-table` beats `vlans-on-wireless`.

- **Pros:** small, unit-testable; fixes the visibly-silly `/interface/bridge/vlan` → *VLANs on
  Wireless* mislink; improves what `get_page`/`command_tree` point a human at.
- **Cons:** **does not fix property lookup** — page 27 has zero property rows. Cannot reach page 10.
  Risks reintroducing #58-class mislinks without a corpus-wide before/after audit.
- **Disposition:** worth doing as a *cosmetic* fix on its own merits (this is what #131 is narrowed
  to), but it must not be sold as fixing the reported problem.

### D. Do nothing; keep the honest `low`

- **Pros:** the correct answer is already returned for the bridge case.
- **Cons:** leaves the confidence signal uninterpretable, which blocks B-0001/B-0011 indefinitely.

# Step 3 result — Option A measured corpus-wide (2026-07-31)

Measured by `src/eval/command-prose-join.ts` on **`v0.11.2-alpha.109`** (schema 11, `source_commit`
`4cd7413`), the same artifact as the rest of this briefing. The census is committed so this is
re-checkable rather than trusted: `DB_PATH=… bun run src/eval/command-prose-join.ts`.

**The oracle.** An inspect `arg` row `/interface/bridge/port/add/pvid` means the menu
`/interface/bridge/port` accepts `pvid`. That is what "the aligned path is right" is scored against.
It covers **3,316 of 4,587** property rows (72.3%); the other 1,271 carry names inspect has never
heard of and are unscorable by construction — largely #61's territory.

## The verdict

**Option A is a strong ranking signal and not a key.** It does discriminate on the families that
motivated #131 and #58 — but it is silent on about half the corpus, and silence is not a key.

| Measure (linker's current extraction rules) | Result |
|---|---|
| Property rows whose own section names any menu path | 3,122 / 4,587 (**68.1%**) |
| ... same, page-grained (what the linker uses today) | 4,440 / 4,587 (96.8%) |
| Property-owning sections naming no menu path at all | 200 / 468 (**42.7%**) |
| Scorable rows whose section names an **accepting** path | 1,661 / 3,316 (**50.1%**) |
| ... exactly one such path (unambiguous) | 1,446 / 3,316 (**43.6%**) |
| **Conditional** precision — of rows whose section names *any* path | 1,661 / 2,197 (**75.6%**) |
| Mean candidate paths per fragment — section vs page | **1.0 vs 6.4** (6.5× narrower) |

The two numbers that matter together: **75.6% conditional precision but only 68.1% coverage.** When a
section names a path, that path is usually the right one — the dominant failure mode is *silence*,
not misalignment. That is the opposite of the failure mode the fuzzy page ranker has, and it is why
this composes as a tier rather than replacing anything.

**A cascade recovers most of the loss.** Section-first, page-fallback, over scorable rows:

| Tier that resolved the row | Rows |
|---|---|
| section names an accepting path | 1,661 (50.1%) |
| fell back to the page | 1,234 (37.2%) |
| unresolved by either | 421 (**12.7%**) |

## Where it is still too coarse

- **A section is shared.** 63.6% of property rows sit in a section holding 11+ properties; five
  sections hold 353 rows between them. Section alignment can never distinguish two properties in the
  same section — it is a *fragment* verdict applied to every row inside.
- **The `/ip/settings` class is real and quantified.** Of 446 (section, path) pairs where the section
  owns scorable properties, **128 (28.7%)** are paths that accept *none* of them — a genuine menu,
  mentioned in passing, unrelated to the properties beside it. Against that, 184 pairs (41.3%) accept
  90–100%. So the signal is bimodal: mostly excellent or entirely spurious, which is exactly the
  shape a support-ratio filter can exploit.
- **"The menu accepts this name" is weak evidence on its own.** Only 37.0% of scorable rows have a
  name accepted at exactly one menu corpus-wide; **20.8% have names accepted at 26+ menus**
  (`comment`, `disabled`, `name`). For those rows acceptance is nearly free and must not be read as
  belonging. This is the measured form of the rule already recorded above: *do not label a result
  `high` merely because the requested field exists.*

## Two extraction defects found while measuring — they affect the linker shipping today

Both are in `link-commands.ts`'s path extraction, now factored out to `src/menu-paths.ts` so the
census and the linker cannot drift apart, with the current behaviour anchored in `menu-paths.test.ts`.

1. **Bare top-level menus are invisible.** `MENU_PATH_RE` requires a *second* segment, so `/certificate`,
   `/queue`, `/user` are never extracted — a page whose only mention is the bare menu is never a
   candidate for it. Cost, measured (`TOP_LEVEL=1`): coverage 68.1% → **70.5%**, section-tier precision
   50.1% → **51.8%**, unresolved 12.7% → 11.7%. Real but modest; it is a linker bug independent of this
   briefing.
2. **`normalizeMenuPath` fabricates pseudo-paths.** Mapping spaces to slashes turns
   `/certificate/import file-name=x` into `/certificate/import/file-name`, which is not a menu and can
   never match. `link-commands.ts` already walks such a path back to the nearest real `dir` when
   building candidates, so the linker is not misled — but any *new* consumer of the extractor must do
   the same walk deliberately. That is why `resolveToDir` is an explicit, tested option rather than a
   detail buried in the linker.

## Table granularity — closed

The one-family check above generalizes. Across all **562** property-bearing tables, a table's own path
set is identical to its section's in 33 cases and narrower in 34, and **never** wider (0) or disjoint
(0); **495 name no path at all**. A
table-grained key can therefore only ever *lose* information relative to the section. **Option A at
table granularity is dead**, and the finer structural fragment this briefing went looking for does not
exist in the shipped schema. The remaining candidate is positional (proximity), which needs new
extraction-time provenance.

## The motivating families do resolve

| Case | Section | Verdict |
|---|---|---|
| `pvid` (#131) | 147 `Port Settings`, 168 `Bridge Port Settings` (page 10) | **exact** `/interface/bridge/port` |
| `pvid` (#131) | 140 `Bridge Interface Setup` (page 10) | ancestor-only (`/interface/bridge`, plus the spurious `/ip/settings`) |
| `pvid` (#131) | 666 `Properties` (page 38 Apps) | **no signal** — the polluting row drops out |
| `vlan-ids` (#131) | 606 `Bridge VLAN Table` (page 10) | **exact** `/interface/bridge/vlan` |
| `address-pool` (#58) | 2600 `DHCP Server Properties` (page 233) | **exact** `/ip/dhcp-server` |
| `address-pool` (#58) | 107/142 HotSpot, 3405 IPsec | **no signal** — today's mislink targets drop out |

Both reported defects are discriminated correctly, including the negative cases. That is what promotes
Option A from hypothesis to *adopted signal* — while the 42.7% of barren sections is what keeps it from
being the key.

# Step 4 — the rank/confidence contract — implemented 2026-07-31

Shipped in `src/property-confidence.ts`, consumed by `lookupProperty` (`src/query.ts`).

## What the label used to mean

`high` = "the scoped branch ran"; `low` = "it didn't". The label described **which SQL executed**, not
what the row knows. Every property on a linked page was equally `high`; a correct row reached by the
global fallback was always `low`.

## The candidate set had to move too

Grading alone is not enough, and the first cut of this work got that wrong. While the scoped branch
still *selected* the rows, the fuzzy link kept its veto: `/interface/bridge/host` links to the IGMP
snooping page, which happens to document its own `vid`, so the lookup returned two `medium` rows from
that page and never even graded the `high` **Static Entries** section that names
`/interface/bridge/host` outright. Same for `/interface/wifi/provisioning` + `radio-mac`. A tier
system that only ranks what a bad link already admitted cannot survive the mislink case it was built
for.

So the candidate set is now every row with the name, graded with page alignment determined **per
row**. The link keeps exactly one job — conferring the `medium` page tier on rows with no path
evidence of their own. To stop that widening results in the common case, off-page rows must earn
their place: once the linked page contributes anything, an off-page row survives only if its tier is
at least as good as the best the linked page offers. A correct link therefore returns what it always
did, and only rows that match or beat it widen the answer.

Widening the set exposed a second problem that grading does not solve either, caught in review. Tiers
are menu-level, so a ubiquitous name is legitimately `high` on several pages at once: `name` at
`/interface/ethernet` grades `high` on the Ethernet, Bonding and PoE-Out pages, because each of those
sections is genuinely about a menu that takes it. With ties broken by page title, `Bonding` won, and
`explainCommand` reported `/interface/ethernet set name=ether2` as "Name of the bonding interface" —
a *worse* answer than before the change, on a query the old scoped branch handled correctly. So
within a tier, linked-page rows sort first. The page link is weak evidence, but it is still evidence,
and it is exactly the right thing to break a tie the section evidence cannot.

## Tiers as implemented

| Tier | Requires |
|---|---|
| `high` | the row's **own section** names the requested menu, that menu is the one the section is *about* (see support gate), and the command tree does not contradict it |
| `medium` | the section names a **neighbouring** menu (ancestor at depth ≥ 2, or any descendant); or names the menu only as a cross-reference; or only the **page** aligns |
| `low` | nothing but the property name ties the row to the menu |

Unscoped lookups (no `commandPath`) stay `medium` throughout: there is no menu to align to, so the
tier would be answering a different question.

Measured by the census itself — `src/eval/command-prose-join.ts` replays `lookupProperty`'s candidate
set and filter and grades every candidate with the shipped `gradeRow`/`supportedPaths`, so these
figures are regenerable rather than asserted. Over the 14,832 (menu, property-name) pairs the command
tree says are real, 115,926 row labels compared (`absent` = the row was not returned at all):

| Transition | Rows | Share |
|---|---:|---:|
| `low` → `low` | 76,963 | 66.4% |
| `absent` → `absent` | 33,521 | 28.9% |
| `high` → `medium` | 2,295 | 2.0% |
| `high` → `high` | 1,054 | 0.9% |
| `low` → `medium` | 1,105 | 1.0% |
| `low` → `high` | 835 | 0.7% |
| `absent` → `high` | 80 | 0.1% |
| `absent` → `medium` | 73 | 0.1% |

**31.5% of the labels that shipped as `high` survive.** 1,940 rows escape a wrongly-`low` label, and
**153 rows the old candidate set suppressed outright are now returned with evidence** — 80 of them
`high`. The `low` population dominates because most (menu, name) pairs have no prose section naming
the menu at all: the 42.7% barren-section result, seen from the query side.

## The three rules, and how they landed

1. **Field existence never sets the tier.** Confirmed as designed. It may demote an aligned row whose
   menu rejects the name; it can never promote.
2. **Ubiquitous names cannot reach `high` on acceptance.** No separate check was needed — rule 1 makes
   it structural, since *nothing* reaches `high` on acceptance. Recorded here so it is not re-added as
   a redundant guard.
3. **Silence is `low`, not `medium`.** Implemented literally.

## The support gate — the open question, answered

Step 3 left open whether a per-(section, path) support ratio should gate `high`. **It must.** The
retrieval eval caught it immediately: without a gate, `/ip/firewall/filter` + `action` returned
`high` on the *bridge*-firewall section, which cites `/ip/firewall/filter` in one sentence while
documenting `/interface/bridge/filter`. Naming is not aboutness.

The gate: of the menus a section names, `high` requires the requested one to be among those accepting
the **most of that section's own property names**. Ties keep both (a menu and its submenu are often
equally supported). Two zeroes are distinguished, and the distinction is the gate's whole content:
when the command tree has never heard of any of the section's property names it cannot judge, so every
named menu stays eligible — silence must not demote; when it knows those names and no named menu takes
any of them, that is evidence *against* every candidate and none is eligible. A section naming exactly
one menu is scored like any other, since that is precisely where a lone passing mention has no
competitor to be measured against and is most likely to be mistaken for authority.

The blunter alternative was measured and rejected: rejecting any section that names more than one
unrelated menu retains **42.4%** of the alignments naming alone would accept, versus **84.4%** for the
support gate, and its losses
are overwhelmingly correct alignments killed by a single incidental cross-reference
(`/interface/macvlan` losing to a mention of `/ip/settings`).

Still open: how "reference owner vs related guide" is expressed once a row legitimately aligns to more
than one menu. The tie-keeping above is a placeholder, not an answer.

# Step 5 — how thin is the evidence under the labels that survived? (2026-08-01)

Step 4 measured how many labels *changed*. This asks a different question about the same population:
of the 1,969 rows the shipped grader calls `high`, what is the exact match actually made of? Measured
by the same census on the same artifact (`v0.11.2-alpha.109`), so the two sections are directly
comparable.

The question exists because `resolveToDir` — added so `/certificate/import file-name=x` counts as
evidence for `/certificate` — walks *any* deeper mention back to its nearest real menu. A section that
never names a menu can therefore supply **exact-match** evidence for it, which is the strongest tier.

| Evidence for the exact match | Rows | Share of `high` |
|---|---:|---:|
| the section names the menu itself | 1,581 | **80.3%** |
| only a deeper path collapsed onto it (`resolveToDir`) | 388 | **19.7%** |

## The failure mode this exposes, and how small it is

The collapse is usually doing exactly what it was built for: the overlay calls the name a settable
`Argument` at the menu itself for **196 of the 388** (50.5%) — a section showing `/interface/veth/add`
or `/iot/wiliot/set` genuinely is about that menu.

The failure mode is narrower: a section documenting a **command's output** claims to be about the
command's **menu**. `/interface/wifi` + `ssid` is the clean instance, and it is a *marquee* query:

```text
high    Wi-Fi 6/7 :: Scan command             :: The extended service set identifier of the AP.
medium  Wi-Fi 6/7 :: Network                  :: The wireless network name (ESSID).
medium  Wi-Fi 6/7 :: Configuration properties :: The name of the wireless network, aka the (E)SSID.
```

- §"Scan command" names only `/interface/wifi/scan`, which collapses to `/interface/wifi` → exact → `high`.
- §"Network" names `/interface/wifi/network` → descendant → `medium`.
- §"Configuration properties" — the actual settable table, 18 properties — names only
  `/interface/wifi/cap`, which accepts none of them → zero support → page tier → `medium`.

So the read-only scan output outranks the configuration prose. The overlay confirms the diagnosis
independently: `interface/wifi/scan · ssid` is a **`Read-only Argument`**, `interface/wifi · ssid` is a
settable **`Argument`**.

**Corpus-wide, the confirmable class is 24 rows (6.2% of the collapsed set, 1.2% of all `high`)** — 16
of them with settable-at-menu corroboration as well. That is the honest size: visible and legitimate,
but not a crisis.

## The cheap fix is measurably the wrong one

The obvious cheap rule — don't let a read-only verb (`print`/`monitor`/`export`/`scan`/`find`/`get`/
`check`) collapse — was measured rather than assumed:

| Rows it would demote | Overlay says settable at the menu anyway (wrong) | Overlay says read-only there (right) |
|---:|---:|---:|
| 147 | **54** | **0** |

Verb shape and read-only-ness do not coincide *anywhere* in this corpus. Plenty of sections name only
`M/print` while documenting M's own settable properties (`Rule Table` via
`/interface/ethernet/switch/rule/print`), and every row the blunt rule would demote for the right
reason is already caught by the precise signal. **`field_kind` is the signal; the verb is not** — the
same shape as step 4's support-gate-vs-exclusivity comparison, and the same verdict.

## Disposition

**Recorded, not built.** A `field_kind`-aware demotion is rule-1-shaped (acceptance may demote, never
promote) and would be correct, but it costs `menu-paths.ts` returning collapse provenance plus a new
`cliref` dependency inside `property-confidence.ts`, for 24 rows. The better trigger is extraction:
if a future pass records read-only-ness on `properties` rows — which the overlay already knows per
command — the demotion becomes a local check with no new join. Revisit if a rebuild moves the 24
materially, or if the reference-owner-vs-guide design touches `menu-paths.ts` anyway.

# Step 6 — the other half of the join: do the two stores share a *vocabulary*? (2026-08-01)

Steps 3–5 all asked which **menu** a property row belongs to. This asks whether `properties` and the
inspect command tree agree on what an attribute is **called** — because a perfect menu join still
cannot align prose with schema if the name join fails underneath it. Measured by
`src/eval/vocabulary-alignment.ts` on the same artifact.

The result reorders the agenda: **the name gap is mostly not a naming problem.**

## Prose → schema: why the tree cannot see 1,271 rows

The CLI-Reference overlay is the referee, because it is the only store that distinguishes a settable
`Argument` from a `Read-only Argument` and is version-less rather than one device's dump.

| Why the tree cannot see it | Rows | Share of the gap |
|---|---:|---:|
| overlay: **read-only only** | 670 | **52.7%** |
| unknown to the overlay too | 309 | 24.3% |
| overlay: **settable only** | 280 | **22.0%** |
| overlay: both kinds | 12 | 0.9% |

Two distinct mismatches, neither of which is about spelling:

- **Kind (52.7%).** inspect `arg` rows are *settable arguments*. A documented output column —
  `rx-packets`, `last-seen`, `signal-strength-ch1` — can never appear there no matter how good the
  join is. The corpus documents read-only state extensively; the schema store models only settable input.
- **Coverage (22.0%).** The field is settable *somewhere*, just not on the device this tree was dumped
  from. It clusters exactly where you would predict: **CRS1xx/2xx switches 191 settable rows**,
  L3 Hardware Offloading 14, QoS 25. And `/interface/ethernet/poe` has **0** rows in `commands` at
  all — the PoE-Out property rows have no menu to join to at any granularity, so no amount of ranking
  or proximity work reaches them.

That second row is **#25's "arch as advisory" half, finally with a number attached**, arriving from a
direction nobody was looking: not "CHR has no Wi-Fi so tool output is empty", but "one architecture's
dump silently defines the vocabulary the whole join is scored against."

## Schema → prose: the "known, undocumented" population, counted

Of **2,720** distinct argument names, 1,616 (59.4%) have a property row somewhere with that name and
**1,104 (40.6%) have none anywhere in the corpus**. This is the number #61 has wanted since its
2026-07-12 reframe. It is deliberately generous — a name counts as documented if *any* page uses it,
regardless of menu — so it is an upper bound on how much prose could ever be attached. Menu-aligned,
it can only be worse (step 3).

## Dotted names: ambiguity, not absence

244 argument names are dotted (`channel.frequency`, `security.authentication-types`). **Zero** are
documented under the full dotted name; **150** are documented under the bare leaf. But the dotted model
explains only **4** of the 1,271 unmatched rows, because those leaves are usually *also* plain arguments
at some other menu — so they already read as `known`.

So #61's BL-3 is real but its shape is the opposite of how it was filed: the descriptions **exist**, and
the defect is that one prose row silently stands in for several distinct attributes. That is an
*ambiguity* bug in the same family as everything else in this briefing, not a missing-content bug. The
overlay is a third vocabulary that settles it cleanly for neither: 218 of its field names are dotted, of
which 103 match a dotted argument name.

## What this changes

1. **The CLI-Reference overlay is the vocabulary bridge, and inspect is not.** Not because it is bigger
   — inspect has 36,099 `arg` rows to the overlay's 10,118 fields — but because it is complementary
   *precisely where inspect is blind*: it carries `field_kind` (the 52.7%) and is version-less and
   hardware-independent (the 22.0%). B-0016's Q5 asked what the overlay is *for*; this is a second,
   sharper answer than "advisory metadata", and a stronger one than step 4's bounded `(path, name)`
   validation.
2. **Proximity is no longer the only thing gating alignment, and may not be the first thing.** It
   answers *which menu*; it does nothing for a read-only field the schema store has no row for, or for a
   switch-chip menu the dump never contained. Roughly half the prose→schema gap is untouched by any
   menu-join improvement.
3. **`arg`-only is the modelling decision to revisit.** The recurring question in this briefing has been
   "what is the missing key". Step 6 suggests the prior question is *what is the missing **row***: the
   schema store models settable input for one architecture, and the corpus documents settable input,
   read-only state, and hardware variants for all of them. A key cannot join to a row that does not exist.

## B-0023 (page/section normalization) — implemented; now the substrate

B-0023's lead-fragment work **landed in PR #105** (`940458c`), so section coverage is already total
and `LEAD_ANCHOR` ships. This briefing does not raise its priority — it consumes its output.

B-0023 named #27 (MCP/TUI surface alignment) as the consumer of total coverage. Option A is a
**second consumer, and a correctness one**: "which page owns `/interface/bridge`?" has no good
answer (page 10 holds 226 property rows but is a section index; page 27 has the right name and zero
properties), while "which *section* documents `pvid` for bridge ports?" does. The remaining work is
the command↔prose join itself — which fragment/proximity signal identifies the right row is B-0024's
open question, not more section-coverage work.

## B-0016 (CLI-Reference overlay) — Q5 gets a bounded answer

Q5 ("what surfaces to agents, and how") gains a consumer that is not advisory metadata — but a
**bounded** one, per the section above. The overlay validates `(path, name)`; it does not rank prose.
That is still a stronger justification for #25's query-behavior half than the arch-as-advisory
framing alone, and it is honest about the limit.

## B-0001 / B-0011 (retire `routeros_lookup_property`) — revisit trigger

B-0001 resolved (2026-07-14) that `lookup_property` should be retired, folding exact lookup into
`routeros_get_page` and `routeros_command_tree`. Two reasons that is not yet decidable:

1. **Both fold targets sit on the wrong side of the missing key.** `get_page` is page-scoped — it
   assumes the page is right. `command_tree` surfaces `page_title`/`page_url` through the same fuzzy
   `commands.page_id`. Folding does not remove the bad join; it hides it.
2. **`lookupProperty` is the only surface carrying the `high | medium | low` signal**
   (`src/property-confidence.ts`), and pre-fix it was miscalibrated in both directions. Neither
   fold target can express that uncertainty.

**Sequencing agreed with the maintainer 2026-07-31: fix the join, recalibrate confidence, then
decide the surface.** The lean is *conditioned*, not overturned; the extraction ETL behind the tool
was never in question.

Step 4 sharpens reason 2 rather than removing it. The signal is now real — it grades the row instead
of the branch — which makes it *more* costly to drop, not less. Folding into `get_page` /
`command_tree` still has nowhere to put a per-row tier. The decision is now genuinely available: the
question is no longer "is the confidence meaningful" but "does either fold target want to carry it".

# Recommended next steps

1. ~~**Land #132.**~~ **Done — PR #133** (header-name column resolution; 52 rows corrected, 14
   fabricated rows removed). It also removed the Apps row that polluted every global `pvid` lookup.
2. ~~**Narrow #131 to Option C**~~ **Done 2026-08-01.** #131's body now scopes it to the hyphen-component
   ranker fix, states explicitly that it does not fix property lookup (page 27 has zero property rows;
   page 10 scores 0 at any tweak), requires a corpus-wide before/after link diff, and routes the
   reachability half here. Retitled to match.
3. ~~**Validate Option A corpus-wide.**~~ **Done — see "Step 3 result" above.** Verdict: adopted as a
   ranking signal, rejected as a key. Census committed at `src/eval/command-prose-join.ts`. The
   sub-questions as originally posed, and what they returned:
   - **Fragment coarseness** → confirmed as the limiting factor. 63.6% of rows sit in sections of 11+
     properties; 28.7% of (section, path) pairs are spurious.
   - **Table granularity** → **dead end, closed.** No table names a path its section lacks; 495 of 562
     name none. The finer structural fragment does not exist.
   - **Proximity feasibility** → needs new extraction-time provenance. No line/offset column exists on
     `sections`, `page_tables`, `page_table_rows`, or `properties` — only `sort_order`.
   - **Coverage** → 68.1% of rows (70.5% if bare top-level menus are matched); the prose-only guess was
     right.
   - **Precision** → 75.6% conditional. Two extraction defects found in the process, both recorded above.

   The predicted branch is the one that happened: coarseness dominates, so **Option A is a ranking
   signal rather than a key, and the key question reopens** — now with proximity as the only live
   candidate, and its cost known (new provenance, not a new query).
4. ~~**Design the rank/confidence contract.**~~ **Done and implemented — see "Step 4" above.**
   `src/property-confidence.ts` grades each row against the requested menu; `lookupProperty` orders
   best tier first. The support-ratio gate is **in** (the eval caught the false `high` it prevents).
   Reference-owner-vs-guide remains open, with tie-keeping as the placeholder.
5. ~~**Re-anchor #58 and #61 here**~~ **Done 2026-08-01.** Both carry a post-step-4 comment re-running
   their original symptoms on `v0.11.2-alpha.109`. What that re-run established, beyond the
   re-anchoring:
   - `/ip/dhcp-server lease-time` and `address-pool` now resolve `high` to the right DHCP sections, with
     the DHCPv6 siblings demoted to `medium` and the HotSpot/IPsec `address-pool` rows filtered out —
     #58's "HIGH to the wrong page" symptom is gone at both the link and the rank.
   - `/ip/ipsec/peer exchange-mode` returns the right prose at `medium` and **cannot** reach `high`: its
     section names no menu path at all. That is the 42.7% barren-section result showing up as a
     user-visible ceiling, not a bug.
   - `/ip/firewall/filter action`/`chain` and `/routing/bgp/connection distance` are unchanged and
     unchangeable by ranking — #61's territory. Grading did improve their *labels* (the bridge-firewall
     rows sit at `medium` via the support gate; the wireless `distance` rows stay `low`).
   - Neither is *fixed* at the source: `commands.page_id` still points `/interface/bridge/vlan` at page
     344 and leaves `/routing/bgp/connection` NULL. Grading stops that from mattering for retrieval.
6. Revisit B-0001/B-0011 — now unblocked, see above.
7. **Fix the two extractor defects** (bare top-level menus; document `resolveToDir` as the required walk
   for new consumers) — independent of the join, and they improve today's linker. Landing the top-level
   fix changes `commands.page_id` output, so it needs a before/after link diff, not just unit tests.

# A sequencing constraint discovered alongside this (#132 → #100)

Not part of the join, but found in the same pass. `parseProperties()` previously hardcoded
`description: row.cells[1]`. A census of all 589 property/parameter tables in the vendored corpus:

| Count | Header shape | Behavior before #133 |
|---|---|---|
| 573 | `Property\|Description`, `Parameter\|Description` | correct |
| 5 | `Property \| Description \| ` (ragged trailing) | correct |
| 5 | `Property\|Type\|Default\|Description` | **52 rows column-shifted** (apps 45, veth 7) |
| 2 | `Property\|Type\|Description` | 70 rows yield **nothing** (bold-kebab name gate) |
| 1 | `Parameter\|Description\|Example` | correct (16 rows) |
| 1 | `Feature / Property\|Home\|Basic\|Advanced\|ROSE` | **14 fabricated rows** |
| 1 | `Parameter\|Value` · 1 `Menu\|Parameter names\|Page link` | yield nothing (fine) |

Two findings that were not in #132 as filed:

- **`system-information-and-utilities/device-mode.md:85` produced 14 rows that are not properties at
  all.** Source rows look like `| **Containers** (/container) | No | No | No | Yes |`, so
  `parsePropertyCell` took `Containers` as the name and `(/container)` as the type, and `cells[1]` —
  the *Home* column — became the description. (Only 14 of 19 rows survived; multi-word names like
  `**Bandwidth Test**` fail the kebab gate.) #133 resolves columns by header name **and requires a
  Description column**, which removes these.

  **Why #100's audit did not catch it.** The #100 classification enumerated the 27 tables that pass
  the header gate and yield **zero** properties, then judged each accept/reject — correctly rejecting
  a device-mode table on that basis. A table producing *wrong* rows is not in the zero-yield set, so
  it was structurally invisible. "Which property-headed tables yield nothing?" and "which yield
  garbage?" are two different coverage questions, and only the first had ever been asked. A census by
  **header shape** asks the second.

- **#132 had to land before #100.** The two `Property|Type|Description` tables in
  `route-selection-and-filtering.md` hold 70 rows that yield nothing today because of the name gate
  #100 targets. Had #100 loosened that gate first, those rows would have ingested with
  Type-as-description.

# Open questions

- ~~**Is fragment-grained path extraction precise *and fine* enough to be the key?**~~ **Answered: no —
  precise enough (75.6% conditional), not fine enough (42.7% barren sections, 63.6% of rows sharing a
  section with 10+ others).** Both predicted failure modes are real; coverage is the larger one. It is
  a ranking signal. Table granularity, floated as the alternative, is closed.
- ~~**What is `high` allowed to mean?**~~ **Answered and implemented in step 4 above** — exact
  section↔menu alignment, the menu the section is *about* rather than one it cites, never field
  existence alone, never for a name accepted at 26+ menus. The support-ratio gate is in.
- **Where does "reference owner vs related guide" live** once the scalar limitation is acknowledged?
  A second column, a link table, or a section-level link that makes the question moot? Still open, and
  now the main design question, since section alignment is naturally multi-valued.
- **Is proximity worth its provenance cost?** The only live candidate for an actual key. Requires
  capturing source position at extraction time so a property row can be joined to the nearest menu path
  preceding it. Unmeasured — it cannot be measured from a shipped DB, only from the vendored source.
- **#61's prose-only properties remain out of reach.** Section alignment needs a section; corroboration
  needs a field name. Neither extracts a description from a prose bullet list on
  `common-firewall-matchers-and-actions`. The census puts a number on the adjacent gap: **1,271 rows
  (27.7% of 4,587)** carry names inspect has never heard of — **decomposed in step 6**: 52.7% are
  read-only fields the `arg`-only model cannot represent, 22.0% are settable fields absent from this
  architecture's dump, 24.3% are unknown to the overlay too.
- **Should the schema store model read-only state and multiple architectures?** Step 6's finding
  reframes the whole briefing: half the prose→schema gap is a *missing row*, not a missing key. This is
  the question B-0001/B-0011 and the MCP-surface refactor should be sequenced behind, ahead of
  proximity.
- **Should a `high` label distinguish "this section documents the menu" from "this section documents a
  command *of* the menu"?** Measured in step 5: 19.7% of `high` rests on collapsed evidence, of which a
  confirmable 24 rows are the section-documents-output failure. The signal exists (`cliref_fields.field_kind`)
  and the cheap proxy (verb shape) is measurably wrong. Open as a *cost* question, not a *feasibility* one.
- Next revisit trigger: a decision on proximity provenance, an extraction pass that could carry
  read-only-ness onto `properties` rows, or any rebuild that changes the cliref counts away from
  228/1,051/10,118.
