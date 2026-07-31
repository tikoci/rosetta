---
id: B-0024-command-prose-join
topic: The command↔prose join — `commands.page_id` is a page-level proxy for a key that does not exist
status: open
related_tasks: ["#58", "#61", "#131", "#132", "#100", "#25", "B-0001", "B-0011", "B-0016", "B-0023"]
created: 2026-07-31
last_revisited: 2026-07-31
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
  multi-valued, so the scalar limitation disappears. **Measured:** 76.1% conditional precision and a
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
It covers **3,223 of 4,587** property rows (70.3%); the other 1,364 carry names inspect has never
heard of and are unscorable by construction — largely #61's territory.

## The verdict

**Option A is a strong ranking signal and not a key.** It does discriminate on the families that
motivated #131 and #58 — but it is silent on about half the corpus, and silence is not a key.

| Measure (linker's current extraction rules) | Result |
|---|---|
| Property rows whose own section names any menu path | 3,122 / 4,587 (**68.1%**) |
| ... same, page-grained (what the linker uses today) | 4,440 / 4,587 (96.8%) |
| Property-owning sections naming no menu path at all | 200 / 468 (**42.7%**) |
| Scorable rows whose section names an **accepting** path | 1,660 / 3,223 (**51.5%**) |
| ... exactly one such path (unambiguous) | 1,446 (44.9%) |
| **Conditional** precision — of rows whose section names *any* path | 1,660 / 2,181 (**76.1%**) |
| Mean candidate paths per fragment — section vs page | **1.0 vs 6.4** (6.5× narrower) |

The two numbers that matter together: **76.1% conditional precision but only 68.1% coverage.** When a
section names a path, that path is usually the right one — the dominant failure mode is *silence*,
not misalignment. That is the opposite of the failure mode the fuzzy page ranker has, and it is why
this composes as a tier rather than replacing anything.

**A cascade recovers most of the loss.** Section-first, page-fallback, over scorable rows:

| Tier that resolved the row | Rows |
|---|---|
| section names an accepting path | 1,660 (51.5%) |
| fell back to the page | 1,221 (37.9%) |
| unresolved by either | 342 (**10.6%**) |

## Where it is still too coarse

- **A section is shared.** 63.6% of property rows sit in a section holding 11+ properties; five
  sections hold 353 rows between them. Section alignment can never distinguish two properties in the
  same section — it is a *fragment* verdict applied to every row inside.
- **The `/ip/settings` class is real and quantified.** Of 433 (section, path) pairs where the section
  owns scorable properties, **115 (26.6%)** are paths that accept *none* of them — a genuine menu,
  mentioned in passing, unrelated to the properties beside it. Against that, 184 pairs (42.5%) accept
  90–100%. So the signal is bimodal: mostly excellent or entirely spurious, which is exactly the
  shape a support-ratio filter can exploit.
- **"The menu accepts this name" is weak evidence on its own.** Only 36.9% of scorable rows have a
  name accepted at exactly one menu corpus-wide; **21.0% have names accepted at 26+ menus**
  (`comment`, `disabled`, `name`). For those rows acceptance is nearly free and must not be read as
  belonging. This is the measured form of the rule already recorded above: *do not label a result
  `high` merely because the requested field exists.*

## Two extraction defects found while measuring — they affect the linker shipping today

Both are in `link-commands.ts`'s path extraction, now factored out to `src/menu-paths.ts` so the
census and the linker cannot drift apart, with the current behaviour anchored in `menu-paths.test.ts`.

1. **Bare top-level menus are invisible.** `MENU_PATH_RE` requires a *second* segment, so `/certificate`,
   `/queue`, `/user` are never extracted — a page whose only mention is the bare menu is never a
   candidate for it. Cost, measured (`TOP_LEVEL=1`): coverage 68.1% → **70.5%**, section-tier precision
   51.5% → **53.2%**, unresolved 10.6% → 9.6%. Real but modest; it is a linker bug independent of this
   briefing.
2. **`normalizeMenuPath` fabricates pseudo-paths.** Mapping spaces to slashes turns
   `/certificate/import file-name=x` into `/certificate/import/file-name`, which is not a menu and can
   never match. `link-commands.ts` already walks such a path back to the nearest real `dir` when
   building candidates, so the linker is not misled — but any *new* consumer of the extractor must do
   the same walk deliberately. That is why `resolveToDir` is an explicit, tested option rather than a
   detail buried in the linker.

## Table granularity — closed

The one-family check above generalizes. Across all **562** property-bearing tables, a table's own path
set is **never** wider than (33) or disjoint from (0) its section's; **495 name no path at all**. A
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

# Step 4 — the rank/confidence contract this supports

Stated now because step 3 bounds it. Tiers for a command-scoped property lookup, in order:

| Tier | Requires | Reachable share of scorable rows |
|---|---|---|
| `high` | the candidate row's **own section** names the requested menu exactly, and inspect confirms that menu accepts the name | ≤ 51.5% (upper bound; exact-menu alignment is a subset) |
| `medium` | the section names an **ancestor** of the requested menu, or only the **page** aligns | ~37.9% via the page tier |
| `low` | name-only global fallback — no path evidence anywhere | ~10.6% + all 1,364 unscorable rows |

Three rules the measurement forces:

1. **Field existence never sets the tier.** CLI-Reference / inspect validation answers "is this a real
   field", a fact about the *query*. It may only *confirm* a tier reached by path alignment, and may
   demote (a section-aligned path that does not accept the name is suspect), never promote.
2. **Ubiquitous names cannot reach `high` on acceptance.** For the 21.0% of rows whose name is accepted
   at 26+ menus, acceptance carries no information; the tier must rest on alignment alone.
3. **Silence is `low`, not `medium`.** 42.7% of property-owning sections name no path. Treating absent
   evidence as partial evidence is precisely the miscalibration that made the pre-#132 `high` labels
   misleading.

Open for the design pass: whether a per-(section, path) **support ratio** filter (drop paths accepting
none of their section's properties — 26.6% of pairs) should gate the `high` tier, and how "reference
owner vs related guide" is expressed once a row can align to more than one menu.

# Relationship to the other briefings

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
   (`src/query.ts:1054`), and pre-fix it was miscalibrated in both directions. Neither fold target
   can express that uncertainty.

**Sequencing agreed with the maintainer 2026-07-31: fix the join, recalibrate confidence, then
decide the surface.** The lean is *conditioned*, not overturned; the extraction ETL behind the tool
was never in question.

# Recommended next steps

1. ~~**Land #132.**~~ **Done — PR #133** (header-name column resolution; 52 rows corrected, 14
   fabricated rows removed). It also removed the Apps row that polluted every global `pvid` lookup.
2. **Narrow #131 to Option C** (ranker fix only), stating in the issue that it does not fix property
   lookup.
3. ~~**Validate Option A corpus-wide.**~~ **Done — see "Step 3 result" above.** Verdict: adopted as a
   ranking signal, rejected as a key. Census committed at `src/eval/command-prose-join.ts`. The
   sub-questions as originally posed, and what they returned:
   - **Fragment coarseness** → confirmed as the limiting factor. 63.6% of rows sit in sections of 11+
     properties; 26.6% of (section, path) pairs are spurious.
   - **Table granularity** → **dead end, closed.** No table names a path its section lacks; 495 of 562
     name none. The finer structural fragment does not exist.
   - **Proximity feasibility** → needs new extraction-time provenance. No line/offset column exists on
     `sections`, `page_tables`, `page_table_rows`, or `properties` — only `sort_order`.
   - **Coverage** → 68.1% of rows (70.5% if bare top-level menus are matched); the prose-only guess was
     right.
   - **Precision** → 76.1% conditional. Two extraction defects found in the process, both recorded above.

   The predicted branch is the one that happened: coarseness dominates, so **Option A is a ranking
   signal rather than a key, and the key question reopens** — now with proximity as the only live
   candidate, and its cost known (new provenance, not a new query).
4. **Design the rank/confidence contract** — drafted above from the step-3 bounds. Remaining: decide the
   support-ratio gate and the reference-owner-vs-guide representation, then implement against
   `lookupProperty`'s `high | medium | low`.
5. **Re-anchor #58 and #61 here** rather than carrying them as independent linkage bugs.
6. Revisit B-0001/B-0011 only after 4.
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
  precise enough (76.1% conditional), not fine enough (42.7% barren sections, 63.6% of rows sharing a
  section with 10+ others).** Both predicted failure modes are real; coverage is the larger one. It is
  a ranking signal. Table granularity, floated as the alternative, is closed.
- ~~**What is `high` allowed to mean?**~~ **Drafted in step 4 above** — exact section↔menu alignment plus
  inspect confirmation, never field existence alone, never for a name accepted at 26+ menus. What
  remains is whether the support-ratio filter gates it.
- **Where does "reference owner vs related guide" live** once the scalar limitation is acknowledged?
  A second column, a link table, or a section-level link that makes the question moot? Still open, and
  now the main design question, since section alignment is naturally multi-valued.
- **Is proximity worth its provenance cost?** The only live candidate for an actual key. Requires
  capturing source position at extraction time so a property row can be joined to the nearest menu path
  preceding it. Unmeasured — it cannot be measured from a shipped DB, only from the vendored source.
- **#61's prose-only properties remain out of reach.** Section alignment needs a section; corroboration
  needs a field name. Neither extracts a description from a prose bullet list on
  `common-firewall-matchers-and-actions`. The census puts a number on the adjacent gap: **1,364 rows
  (29.7%)** carry names inspect has never heard of and cannot be validated at all.
- Next revisit trigger: the step-4 design pass landing, a decision on proximity provenance, or any
  rebuild that changes the cliref counts away from 228/1,051/10,118.
