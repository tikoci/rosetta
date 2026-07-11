---
id: B-0017-hardware-overlay-device-resolution
topic: manual.mikrotik.com /hardware overlay — device identity/alias resolution across sources
status: open
related_tasks:
  - "#28"
  - "#34"
created: 2026-07-10
last_revisited: 2026-07-10
---

# Question

Before `/hardware` (240+ Docusaurus pages) can be ingested as an overlay on rosetta's existing `devices`
data, how should devices that appear under different names/slugs/model-numbers across `matrix.csv`, the
www product pages, and `/hardware` get resolved to one canonical identity?

Resolving that stable identity is also the prerequisite for a second goal this briefing carries:
surfacing per-device **capabilities** (switch chip, L3HW, VRF, HW QoS, PTP…) and resolving them both
from feature-support doc lists and from free-form user text. The two goals are split into **Track A —
device identity/inventory (the enabler)** and **Track B — device-capability surfacing (the payoff)** in
the research questions below, so a future agent can run them as separate passes.

This is explore/research-shaped, not build-shaped yet — per the umbrella issue
[#28](https://github.com/tikoci/rosetta/issues/28), `/hardware` was left as "(spawn) hardware overlay"
with no real spec. Absorbs and supersedes the still-open `B-0006` (device AKA/alias) and `B-0007`
(special hardware page extraction) — both were already circling this problem from the matrix.csv/www
side; `/hardware` reframes it as a three-way (not two-way) reconciliation problem.

## What's grounding this

- **`/hardware` has more entries than `matrix.csv`, not the same set with a different shape.**
  `matrix.csv`-driven `devices` covers ~144 products. B-0012's 2026-07-07 surface inventory counted 240
  live `/hardware/<model>` sitemap URLs. The maintainer's working assumption (2026-07-10) was that the
  gap is largely **accessories** — e.g. `TR-LR82`-style items — that never had a `matrix.csv` row. **A
  real diff pass (2026-07-10, see "Track A research findings" below) shows accessories are only one of
  at least four causes, and not the dominant one** — series-grouping pages and legacy/EOL devices
  dropped from the current matrix account for at least as much of the gap.
- **Slugs/names may not line up across three sources, not two.** `matrix.csv` product names, www product
  page slugs (`mikrotik.com/product/<slug>`), and `/hardware/<model>` slugs are three independently
  maintained naming surfaces. `data-source-naming-product-matrix.instructions.md` already documents that
  matrix/product-code/slug/doc-reference names vary and matching stays heuristic — this briefing extends
  that known problem to a third source rather than introducing a new one.
- **B-0012's existing research on `/hardware` as a Docusaurus source** (H1, H2, H6 — see
  `briefings/B-0012-docusaurus-manual-migration.md`):
  - `/hardware` is a genuine second Docusaurus docs-plugin instance (`id:"hardware", path:"hardware"`),
    backed by real Markdown source (`@site/hardware/**/*.md`), but structurally excluded from
    `docusaurus-plugin-llms`'s walk (it only walks `docs/`, unscoped to other plugin instances) — so no
    `.md`/`llms.txt` coverage today, unlike `/docs`.
  - `search-doc.json`'s flattened `content` field **does** cover all 3,851 `/hardware/*` search-doc
    entries (safety warnings, regulatory text, package contents) as a legitimate stopgap plain-text
    source, at the cost of losing table structure (same tradeoff `matrix.csv` already accepts for its own
    structured fields).
  - Two viable extraction paths were left open, not decided: a real HTML/Markdown parser against
    `/hardware/<model>` pages, or the `search-doc.json` text fallback for a first pass.
- **`B-0006` (device AKA/alias)**: proposed a `{alias → canonical_product_name}` table, gated behind "5+
  documented false-empty lookups" — written before `/hardware` was known to exist as a source, so its
  trigger condition undercounts the real alias surface now in view.
- **`B-0007` (special hardware pages)** — *reframed by the maintainer 2026-07-10*: flagged Confluence-era
  pages (Switch Chip Features, Marvell Prestera, Peripherals) with device-keyed tables not surfaced in
  `properties`/`devices`. `/hardware` does **not** subsume these — they solve a different problem.
  B-0007's real value is mapping **switch chip → device** so a chip's capabilities/limits surface *when
  looking at a device* (and the reverse). That "surface a capability with the device" need extends beyond
  the switch chip to other device-specific dimensions — L3HW, VRF, HW QoS, PTP. This is the device
  *capability* axis (**Track B** in the research questions), complementary to the identity/inventory axis
  — not something the per-device `/hardware` install/safety pages replace.
- **BACKLOG.md Inbox — switch-chip → device resolution** (2026-07-10 entry): a real session needed ~6
  tool calls to resolve an L3-hardware-offloading release note listing 9 switch-chip IDs to device
  models, because `devices.cpu` conflates the management CPU with the switch ASIC and the only
  authoritative chip→model source is a single doc table, not a queryable field. Filed as "relates to
  B-0006/B-0007; promote to an issue... if the `switch_chip` column lands or another chip→device question
  recurs" — this briefing is that promotion, and reframes the fix as one instance of the same general
  device-identity problem rather than a one-off column.
- **The user's fresh framing (2026-07-10, not previously recorded anywhere):** `/hardware` should be
  treated like any other overlay source, not specially — but it actually surfaces *more* devices than
  `matrix.csv` (accessories), and may use yet another alias/slug distinct from both www-extract device
  slugs and product friendly names/model numbers. This points at needing real **device-resolution
  logic**: a device-aliases table so variant name/model/slug forms resolve back to one canonical device,
  something like a `rosetta_device_id` — because there can be www-only devices, `/hardware`-only devices,
  or the same device present in both sources under different slugs.

## Open research questions

This briefing is explicitly upstream of an extractor spec — the goal is answering these, not writing
code. The questions split into two intertwined tracks that a future agent can run as **separate passes**:

- **Track A — device identity, inventory & what `/hardware` surfaces** (the enabler). Resolve the
  three-way join and settle a stable device key before designing any schema.
- **Track B — device-capability surfacing** (the payoff). Once a device has a stable key to hang facts
  on, surface per-device capabilities (switch chip, L3HW, VRF, HW QoS, PTP…) and resolve them in both
  directions. Track B depends on Track A's identity work, so run identity/diff first; Track B is the
  strongest candidate to become its **own scoped build issue** rather than riding the same extractor.

### Track A — identity, inventory & `/hardware` content

1. **Real inventory diff.** Enumerate all 240 `/hardware/<model>` sitemap slugs against `matrix.csv`
   product names/rows. How many have no plausible `matrix.csv` match at all (candidate accessories)? How
   many match cleanly? How many are ambiguous (plausible but not exact)? This is the same discipline
   B-0012 H3 applied to CLI-Reference (full census, not a sample) — do the same here before designing a
   schema.
2. **Naming/slug reconciliation, and the "weird slug" catalog.** For the "plausible match" set, catalog
   the actual slug/name deltas (case, punctuation, model suffixes, marketing vs. model-number names) so
   the alias table's shape is informed by real data, not guessed patterns. Treat recurring **second-order
   patterns** as their own signal worth tracking: marketing suffixes reused across products (e.g.
   `refresh`), Unicode in friendly names (superscripts in `hAP ax²`/`ax³`), and space/slash handling. A
   slug that manifests "weirdly" is an early indicator of a device that will be hard to match — and the
   same catalog is what later powers **free-text → device canonicalization in `routeros_search`**
   (identifying a device from unstructured user text is the downstream payoff of this alias work, even
   though it isn't a task to solve now).
3. **Identity model — pick a *stable, agent-persistable* device key.** The load-bearing requirement is
   stability across re-extracts: agents (and downstream tooling) may persist whatever id rosetta returns,
   so an AUTOINCREMENT `devices.id` is disqualifying as the *exposed* identity — its value can shift
   between extracts, and an agent inventing its own (`rosetta-device#92`) is worse. Whatever device we
   return should always carry a **hopefully-immutable** natural key that rosetta can later resolve back to
   the same device. Slugs are the natural candidate (MikroTik rarely changes them) — but the diff pass
   must weigh two complications:
   - There may now be **two slugs** per device (manual `/hardware/<slug>` and www `/product/<slug>`),
     plus a model number and a friendly name. Different surfaces may want different forms — model# for
     precision, friendly name for humans, a "preferred slug" for MCP/CLI output.
   - MikroTik **does** rename products (`hEX` → `hEX refresh`), so "slug == immutable" isn't guaranteed.
     That may force a rosetta-curated-but-stable canonical key with every observed slug/name/model# as an
     *alias* row pointing to it, rather than blessing one source's slug as the PK. Whether that needs a
     dedicated `device_id`/`rosetta_id`-style column (B-0012 H7 precedent — synthetic PK plus indexed
     natural key) or just a `device_aliases` table keyed off a chosen stable slug is exactly what
     questions 1–2 should settle empirically. Either way, keep the AUTOINCREMENT PK internal and never
     expose it.
4. **Do accessories even fit the `devices` shape?** If the 240-vs-144 gap is largely accessories
   (antennas, PSUs, cables, LTE modules), those rows have none of `devices`' router/switch columns (CPU,
   architecture, ports, license level). The diff pass should decide whether the overlay extends `devices`
   with schema-light rows, adds a separate `hardware`/`accessories` table, or scopes accessories out
   entirely — an identity *and* schema question, not just a join.
5. **Extraction mechanism + content structuring.** HTML/Markdown parser against live `/hardware/<model>`
   pages, or `search-doc.json` flattened-text as a first pass (per B-0012 H2/H6)? Beyond the mechanism,
   the ETL should **organize the page body, not dump it**:
   - `/hardware` pages appear to share large boilerplate sections (safety warnings, FCC/EU regulatory
     text, package contents) — possibly identical across pages, possibly with subtle deltas (unverified).
     Surfacing these by default just bloats agent context with things a model already knows. Ideally the
     ETL separates by `##` section so the **quick-start / core** content is the default, and
     safety/regulatory prose is gated behind an explicit MCP tool arg (opt-in fetch).
   - Hunt for device-unique **factoids** that *are* worth surfacing because they deviate from the norm.
     Clearest example: a non-default management IP — some devices ship on `192.168.188.1` instead of the
     near-universal `192.168.88.1` (see `manual.mikrotik.com/hardware/sxt-kit-series`; seems concentrated
     in LTE/5G products). Surface the IP specifically *when it isn't* `192.168.88.1`.
   - The **volume** of a page's non-boilerplate content is itself a signal: a `/hardware` page carrying
     real detail (vs. an IoT device's near-empty boilerplate page) flags a device worth richer treatment.
6. **Trigger/scope for the alias table specifically.** Does the BACKLOG switch-chip case count as one of
   B-0006's "5+ documented misses," or does `/hardware`'s existence change B-0006's trigger condition
   entirely (i.e., building the overlay *is* the trigger, since it structurally requires resolving aliases
   across three sources rather than waiting for misses to accumulate)?
7. **Provenance when a device is in both sources.** When www and `/hardware` both describe a device but
   disagree on a field, which source wins, and is per-field provenance recorded (cf. `db-meta-stamping`)?
   A gap not in view before `/hardware` became a third source.

### Track A research findings (2026-07-10, exhaustive pass)

Question 1 (inventory diff) and the structural half of question 5 (extraction mechanism) are now answered
by a **committed, re-runnable script** — `src/assess-hardware.ts` (mirrors `assess-html.ts`'s "splunk the
structure before designing a schema" role for the Confluence corpus). It fetches all 239 live `/hardware`
pages' rendered HTML (`/hardware/<slug>.md` 404s — confirmed live, unlike `/docs` — so this parses HTML
with `linkedom`, not raw Markdown), caches them under `manual/pages/hardware/*.html` (gitignored, same
convention as `manual/pages/docs/`), and writes a full per-page census to the **committed**
`ros-hardware-assessment.json` (mirrors `ros-html-assessment.json`'s precedent for committing derived
structural-assessment artifacts). Re-run any time with `bun run src/assess-hardware.ts` (live) or
`--from-cache` (offline, re-analyze cached HTML). This supersedes the original eyeballed slug-diff pass
below with an exhaustive, code-verified one — the four-cause breakdown still holds, but with exact counts.

**Key discovery driving the method:** most single-device `/hardware` pages' "Specifications" section links
directly to `mikrotik.com/product/<code>` — e.g. `manual.mikrotik.com/hardware/cap`'s Specifications
section links `mikrotik.com/product/RBcAP2nD`, which is *exactly* `matrix.csv`'s Product code value for
`cAP`. That link is a far more reliable cross-reference than slug-guessing. But it isn't uniform: some
pages link a **www-style slug instead of the real code** (`manual.mikrotik.com/hardware/cap-ac` links
`mikrotik.com/product/cap_ac`, not a product code at all) — a fourth naming surface, confirming Q3's
"there may now be two slugs, not one" concern empirically. The script therefore matches in two tiers per
page — exact product-code match first, then a slug-normalized fallback (reusing the `+`→`-plus-` and
superscript→`-<digit>` rules from the original pass) — and **unions both tiers' results** rather than
short-circuiting on the first hit. That union step mattered in practice: `rb1100-series` carries two
product links, `RB1100Dx4` (code-matches `"RB1100AHx4 Dude Edition"`) and `rb1100ahx4` (only
slug-matches plain `"RB1100AHx4"`) — an early short-circuiting version of the script silently dropped the
plain variant, caught and fixed before these numbers were finalized.

**Exhaustive results (239 `/hardware` pages, 156 current `matrix.csv` rows):**

| Bucket | Pages | Meaning |
|---|---|---|
| `matched-by-code` | 33 | Product-code link hits `matrix.csv` "Product code" directly |
| `matched-by-slug` | 103 | Link or page slug hits a slugified matrix name/code |
| `unmatched` | 84 | Has product link(s), neither tier hit — legacy/EOL candidate |
| `no-product-link` | 19 | No `mikrotik.com/product/*` link at all — accessory/info-page/linkless-series candidate |

Coverage the *other* direction is better than the original assumption suggested: only **14 of 156**
current `matrix.csv` rows have **no** `/hardware` page match at all (`ATL LTE18 kit`, `Chateau LTE12
(2025)`, `CubeSA 60Pro ac`, `FTC21-ups`, `KNOT Embedded LTE4` [+ Global], `LAMP 5G R16`, `LHGG LTE7 kit`,
`LtAP LTE7 kit`, `R11e-LTE7`, `ROSE Data server (RDS)`, `SXT LTE7 kit`, `SXT SA5 ac`, `SXTsq Embedded LTE4
Global`) — i.e. **91% of current products have a resolvable `/hardware` page**, mostly recent LTE-kit
bundles and one very-recent product (`Chateau LTE12 (2025)`) whose page likely hasn't shipped yet or uses
a shape the two-tier match doesn't cover.

**Series pages (30 of 239, confirmed exact count) are not uniform.** Breaking them down by the same
buckets: most resolve to `matched-by-code`/`matched-by-slug` with **5 confirmed resolving to more than one
current matrix row** (true multi-device grouping, e.g. `rb1100-series` → `RB1100AHx4` +
`RB1100AHx4 Dude Edition`) — but **10 of the 30 series pages carry zero product links at all**
(`ccr1036-12g-4s-series`, `ccr1036-8g-2s-plus-series`, `crs-series`, `crs125-24g-1s-series`,
`ltap-kit-series`, `mant-series`, `r11e-series`, `sxt-kit-series`, `sxtsa-series`, `wap-series`) and **6
resolve to product links that hit nothing in the current matrix** (`lhg-kit-series`, `mtp250-series`,
`nray-series`, `wap-60g-series`, `wap-ac-kit-series`, `wap-kit-series` — entire discontinued series). The
link-based method **undercounts** true series membership even when it does resolve: `basebox-series`
covers BaseBox 2/5/6 live but carries only one product link (`RB912UAG-5HPnD-OUT`, matching BaseBox 5
only) — confirmed by re-reading the live page content, not just the link set. **Series-page membership
cannot be fully derived from product links alone**; a future extraction pass needs a second signal (page
prose, or a real product-code/spec table if one exists on these pages) to enumerate members completely.

**The `no-product-link` bucket (19 pages) splits cleanly into two different problems**, not one:
`compliance` (confirmed non-device — generic regulatory content, no product links, no title matching any
device) plus 8 more single-device pages with no Specifications-link at all (`dynadish-6`, `g1040a-60wn`,
`lhg-lite60`, `lhg-xl-2`, `ltap-lr8-lte6-kit`, `pwr-line`, `pwr-line-ap`, `sxt-2` — real but likely
legacy/thin pages using an older page template) — versus the 10 linkless series pages above, which are a
schema problem (need member enumeration), not an accessory problem.

**Non-default management IP factoid, generalized beyond the one known case.** The user's `sxt-kit-series`
example (`192.168.188.1`) is real but not isolated: **11 pages** carry a genuine subnet deviation (not
just a second same-subnet address like `.88.2`/`.88.3`, which ~60 pages mention incidentally in
multi-port setup instructions and is *not* a deviation worth surfacing). The real `192.168.188.1` cluster
is `atlgm-and-eg18-ea`, `atlgm-and-rg520f-eu`, both `knot-embedded-lte4-*` pages, `lhg-kit-series`,
`lhg-lte18-kit`, `lhgg-lte6-kit`, `sxt-kit-series`, `sxtsq-embedded-lte4` — **every one of these is an
embedded-LTE/5G-modem product**, confirming the user's "concentrated in LTE/5G products" hunch exactly
and tying it specifically to the *embedded modem's own management interface*, not the router itself. Two
more genuine outliers: `intercell` (`192.168.200.100`/`.200.200`) and `woobm-usb` (`192.168.4.1/.2/.5` —
an out-of-band USB dongle, where a distinct subnet is expected by design, not a factoid worth surfacing).

**Boilerplate-vs-core is confirmed, not just suspected.** Across 239 pages, `Safety Warnings` appears on
215 (90%), `Operating system support` on 212 (89%), and every regulatory heading (FCC, Canada/ISED, UKCA,
Eurasian Conformity, CE, Mexico, Ukraine) appears on 85–135 pages each — near-universal, near-identical
boilerplate. Median word count is 1,656 (real substantive content, not mostly-empty pages), supporting
Q5's original lean: default output should be the quick-start/core sections, with regulatory/safety text
gated behind an explicit opt-in.

### Track A research findings (2026-07-10, second pass — www spec pages + cross-mention)

The maintainer explicitly pushed back on moving to schema "decisions" yet, and reframed
`ros-hardware-assessment.json` as the thing being *iteratively filled out* — asking for two concrete
follow-ups before any schema call: (a) what fields exist on the www product page for devices `/hardware`
surfaced that `matrix.csv` doesn't carry, since that's presumably where real specs live; (b) a recursive
pass over `/hardware` body content for cross-references (other slugs/titles/product codes, CPU/switch-chip
mentions) so later schema/MCP/TUI decisions don't hit surprises. Both are done, with a real (not assumed)
answer to (a) that reframes what `/hardware` actually is.

**`/hardware` pages are thin install/compliance manuals, not spec sheets — the real specs live on
`mikrotik.com/product/<code>`.** 106 of 239 `/hardware` pages have zero `<table>` elements at all, and a
single-device page's "Specifications" `<h2>` section is typically one sentence linking out to the www
product page rather than containing spec data itself (confirmed by reading `hex-poe.html`'s rendered
Specifications section directly — it's a link, nothing else). The actual structured spec fields — CPU,
switch chip, RAM, PoE budget, certification, temperature range — live in a clean `<li>` key/value list on
the **www** product page, not `/hardware`. This is the answer to "what fields does www have for the
devices `/hardware` unlocked that aren't in matrix.csv": the same field set as every other device, because
it's the same page template regardless of matrix.csv coverage.

A new committed script, **`src/assess-www.ts`** (`make assess-www`, cached to `manual/pages/www/*.html`,
gitignored same as `manual/pages/hardware/`), fetches `mikrotik.com/product/<code>` for the union of every
matrix.csv product code and every distinct product-link token any `/hardware` page carries — 401 candidate
codes — and extracts: the key/value spec list, a `Discontinued` status badge, and a `compareProductsTrigger`
id (occasionally carries a hardware-revision suffix the declared code doesn't, e.g. `CCR1016-12G` →
`CCR1016-12Gr2` — a minor observation, not pursued further). Output is **`ros-www-assessment.json`**
(committed, same convention as the `/hardware` artifact).

**Results: 236 of 401 candidates resolved (165 404s), 68 confirmed `Discontinued`.** Field frequency across
the 236 found pages gives a real schema signal instead of a guess:

| Field | Coverage | Read |
|---|---|---|
| Product code, Suggested price | 100% | universal |
| MTBF, Certification | 95%, 90% | near-universal |
| CPU, Architecture, Size of RAM | 82% each | present whenever the device has its own OS/CPU (absent for passive accessories) |
| PoE in | 67% | most, not all |
| 10/100/1000 Ethernet ports | 63% | most, not all |
| Switch chip model | 52% | roughly half — **not a safe non-null column**, confirming Track B Q1's premise that chip data needs its own optional slot, not a `devices.cpu` overload |
| Wireless 2.4/5 GHz standards, chip model, etc. | ~30% each | wireless-only family, a clearly separate field group |
| SFP ports | 14% | switch/router-only |

This is a much stronger basis for a future schema than the current `matrix.csv`-derived `devices` table
alone — a genuinely useful "what fields exist for the non-matrix devices" answer, and it argues for
grouping fields (core/CPU, power, ports, wireless, compliance) rather than one flat row shape, since
coverage drops off sharply outside the universal core.

**The `Discontinued` flag independently validates the `unmatched` bucket — mostly.** Cross-checking the 84
`unmatched` `/hardware` pages (has product link(s), none hit current `matrix.csv`) against `Discontinued`
status: **58 are confirmed discontinued** (the legacy/EOL hypothesis holds), but **26 resolve to a www page
that is *not* discontinued** — active current products `matrix.csv` simply doesn't carry. Reading that list
by hand splits it further:
- The clear majority are genuine accessories outside `devices`' router/switch shape — SFP/media
  converters (`S-31DLC20D`, `S-3553LC20D`), GPS/LoRa/antenna hardware (`GPeR`, `TG-BT5-IN/OUT`,
  `TG-LR82/92`, `mtp250-*`), PoE adapters (`GESP+POE-IN`, `UP1302C-12`), an Ethernet extender (`GPEN11`),
  a UPS module (`FTC21`), a media converter (`RBFTC11`) — confirms accessories are real, just not the
  dominant cause (per the first pass).
- **A handful are a matching-heuristic gap, not a true coverage gap** — worth flagging directly since it
  revises the "14 matrix rows with no `/hardware` match" number from the first pass: `rose-data-server`
  (→ `RDS2216-2XG-4S+4XS-2XQ`) and both `knot-embedded-lte4-*` pages (→ `EG25-G&KNe`) *do* have a
  `/hardware` page and an active www product, but the code linked doesn't textually match `matrix.csv`'s
  own code for `ROSE Data server (RDS)` / `KNOT Embedded LTE4` / `KNOT Embedded LTE4 Global` — the two-tier
  `classify()` in `assess-hardware.ts` doesn't yet try matching through www's *declared* "Product code"
  field as a third tier. That would resolve 3 of the 14 "no match at all" rows; not implemented this pass
  (scoping call, not a decision — see "Current lean").
- `chateau-lte12`/`chateau-lte6` both resolve their only product link to `mANT LTE 5o` (an antenna
  accessory), not the Chateau device itself — a genuine methodological gotcha: **not every product link on
  a page is that page's own primary device**; some are cross-sell/accessory links embedded in prose. Filed
  as a caveat, not fixed — would need distinguishing "the Specifications-section link" from "any product
  link anywhere on the page," which the current extractor doesn't do.

**Recursive cross-mention pass (within `/hardware` body text) — mostly a negative result, and an
instructive one.** `assess-hardware.ts` now also scans each cached page's article text for any other
matrix.csv product code not already captured as a link (`findMentionedCodes` in the source), specifically
to try to enumerate the 10 linkless series pages' members from prose instead of links. **It came back
almost empty** — only 2 of 10 linkless series pages produced any hit, and one of the two was a false
positive: `wap-series`'s only hit (`RBcAPL-2nD`, "cAP lite") turned out to be a hardcoded product code
inside a **copy-pasted CE Declaration of Conformity boilerplate paragraph** that doesn't match the page's
actual subject — a real gotcha confirming why this signal is kept as a separate `mentionedCodes` /
`inferredMatrixNames` field in the JSON rather than merged into the authoritative `matchedMatrixNames`. Net
conclusion: **`/hardware` body prose does not name series members in an extractable way**; enumerating a
linkless series page's members will need a different signal entirely — most likely the www side (a
product-family/category listing), not `/hardware` — future work, not resolved here. A weaker
`mentionsLifecycleKeyword` flag (regex for replace/successor/discontinued/end-of-life) was also added for
completeness; it mostly fires on generic marketing copy ("a single Audience unit might replace several
other routers") rather than genuine successor pointers — noted but not load-bearing.

**"Refresh" / replacement-SKU tracking — grounded, and it's simpler than it first looked.** The maintainer
flagged that "refresh" products are real replacement SKUs with new specs, not aliases, and worth tracking
what they replace. Checked concretely via `hEX` vs `hEX refresh`: **both are already separate `matrix.csv`
rows** (`hEX` → `RB750Gr3`, MIPS, 880 MHz, 256 MB RAM vs. `hEX refresh` → `E50UG`, ARM, 950 MHz, 512 MB
RAM, RouterOS v7) — not a data gap at all, just MikroTik's own naming convention for a successor SKU. What
*isn't* available anywhere checked: a structured "this replaces/is replaced by `<code>`" field. The
`Discontinued` badge exists (68 confirmed instances) but carries no pointer to a successor — checked the
HTML immediately around the badge on `CCR1016-12G`'s page and found nothing but a "Discontinued" span, no
related-product link. So replacement tracking, if wanted, would have to be **inferred** (name-prefix
similarity, or a hand-curated mapping) rather than extracted — exactly the kind of "primer for known tough
cases, processed out-of-band" the maintainer floated as a possibility. Not built this pass; flagged as a
real future option, not a decision made now.

**Requested-code vs. www's own declared "Product code" — quantifies the naming-surface problem instead of
citing one example.** Of 236 resolved www pages, **174 show a mismatch** between the code/slug used to
request the page and the page's own declared "Product code" field. Splitting that: **52 are punctuation/
encoding-only** (`CCR1009-7G-1C-1Splus` → `CCR1009-7G-1C-1S+`, `&amp;` HTML-entity vs. `&`, underscore vs.
none — cosmetic, not a real naming-surface problem) but **122 are genuinely different strings**
(`audience` → `RBD25G-5HPacQD2HPnD`, `cap_ac` → `RBcAPGi-5acD2nD`) — the www-slug-as-fake-code pattern
first spotted on one page (`cap_ac`) is confirmed as systemic, not an outlier, at roughly half of all
resolved candidates. This is strong grounding for Q3's "there may now be two slugs, not one" concern and
for treating a `device_aliases`-style table as necessary rather than optional once Track A reaches a
schema decision.

**Still open (not resolved by this pass):**

- The two-tier match is heuristic, not authoritative — `matched-by-slug` in particular can false-positive
  on a coincidental slug collision (none observed, but not proven absent at 103 matches).
- The 10 linkless series pages and the 84 `unmatched` pages have not been individually verified as
  legacy/EOL vs. some other cause — that classification is inferred from "has product link(s) but none
  hit the current matrix," which is a strong but not certain signal.
- Questions 3 (identity model), 4 (do accessories fit `devices`?), 6 (alias-table trigger), and 7
  (provenance) are unaffected by this pass and still need a decision. This pass sharpens question 4:
  series-page membership (especially the 10 linkless + `basebox-series`-style undercounted ones) is
  clearly a **schema** problem (one page → many devices) distinct from the accessory-fit question it was
  originally framed as.
- Extraction mechanism (question 5) now has a sharper, revised default: HTML parsing via `linkedom` is
  still right, but the *target* shifts — `/hardware` is the install/compliance/quick-start source, **www
  product pages are the spec source**. A real extractor for device capability fields (CPU, switch chip,
  RAM, ports, PoE, wireless) should read `mikrotik.com/product/<code>`, not try to mine specs out of
  `/hardware`, which mostly doesn't have them (106/239 pages, zero tables). `/hardware` still matters for
  the install/safety/quick-start content and, per Q5's original framing, the boilerplate-vs-factoid split.
- The classify() three-way join (`/hardware` link → matrix.csv code, `/hardware` slug → matrix.csv slug)
  is provably incomplete on its own: at least 3 of the 14 "no `/hardware` match" matrix rows (`ROSE Data
  server (RDS)`, both `KNOT Embedded LTE4` rows) actually do have a page, reachable only through www's own
  declared "Product code" — a third tier (`classify()` extended to also check `ros-www-assessment.json`'s
  declared codes) would close this gap. Not implemented — a small, well-scoped follow-up once Track A's
  identity model (question 3) is settled, so the fix targets the final key shape rather than the interim
  one.
- The 26 "unmatched-but-active" pages (see above) mean matrix.csv is missing some current products
  outright, not just failing to link to legacy ones — worth factoring into question 4's accessory-fit
  decision, since a few of those 26 (`ROSE Data server (RDS)`, the `KNOT Embedded LTE4` pair) are full
  router-shaped devices matrix.csv already has *rows* for, just unreachable by the current link logic —
  distinct from the antenna/SFP/PoE-adapter accessories in the same bucket that genuinely don't fit
  `devices`' shape.
- No structured "replaces/replaced by" field exists anywhere checked (www or `/hardware`) — if replacement
  tracking is wanted, it needs either inference (name-prefix matching, e.g. `hEX` ↔ `hEX refresh`) or a
  hand-curated mapping, not extraction. Left as a real option, not decided.

### Track B — device-capability surfacing

1. **Switch-chip → device mapping, and other per-device capability dimensions.** The switch chip is the
   most important case (B-0007), but the same "surface a capability *with* the device" need covers L3HW,
   VRF, HW QoS, and PTP. Where should the chip→device (and capability→device) mapping live so it's
   queryable — a `switch_chip` column on `devices`, a capability join table, or an extraction from the
   special-hardware/capability doc tables? `devices.cpu` conflates the management CPU with the switch ASIC
   today, which is why the BACKLOG session needed ~6 calls to resolve 9 chip IDs to models. Part of this
   pass is a small census of *which* "special pages" in the docs actually map back to devices, so the
   full set is known and considered rather than assumed to be switch-chip-only.
2. **Reverse resolution: capability → device list, resolved at tool-call time.** Several core doc pages
   list *which devices/chips support a feature* (L3HW offload, PTP, VRF…). Can rosetta resolve those
   device lists to concrete models *before returning* from a tool call, so an agent answering "does an
   RB5009 support PTP / L3HW?" doesn't have to chain several lookups? This spans core `/docs` pages and
   `routeros_search` behavior — beyond `/hardware` itself — and is the strongest candidate for its own
   scoped build issue once Track A supplies stable device keys to resolve against.

## Current lean

Research/explore phase, not actionable as a build task yet — consistent with how B-0012's `/docs`
migration was staged (T-0033 research pass before T-0034/T-0035 build), and consistent with the
maintainer's explicit 2026-07-10 steer that mapping/data-gathering should continue before any schema
"decision" gets made. Question 1 (inventory diff) is **exhaustively answered** by `src/assess-hardware.ts`
+ `ros-hardware-assessment.json`: the 240-vs-156 gap is real, understood in kind and in exact count, which
**overturns** the original "largely accessories" working assumption. Question 5 (extraction mechanism) is
now **answered with a correction**: `linkedom`-based HTML parsing is right, but the target for spec/
capability data is `mikrotik.com/product/<code>` (`src/assess-www.ts` + `ros-www-assessment.json`, 236
products, ~30-40 spec fields, field-frequency census informing which fields are core-vs-optional), not
`/hardware` — `/hardware` turned out to be install/compliance/quick-start content, largely without spec
tables at all. That leaves questions 3 (identity model), 4 (series-page schema + accessory fit), 6
(alias-table trigger), and 7 (provenance) as the real remaining decisions — none made this pass, by design.

**Two forward-looking architecture notes raised by the maintainer, deliberately not acted on yet** (real
options for whoever picks up the schema/ETL work, not commitments):

- An eventual ETL might use a **stripped-down/revised version of these assessment JSONs**, plus small
  **custom override files persisted in-repo** for known-hard cases (e.g. the www-slug-vs-code mismatches,
  or a hand-curated refresh/replacement map) — i.e. `ros-hardware-assessment.json`/`ros-www-assessment.json`
  as durable *inputs* to a future extractor, not just one-off research artifacts. Both are already
  structured and re-runnable (`make assess-hardware` / `make assess-www`, `--from-cache` for offline
  iteration) so this is a live option, not a rewrite.
- An **intermediate structured format (JSON/TOML) between raw source and SQL** may be worth it in the ETL
  itself, separate from direct `.md`-to-SQL, so data quality can be checked at that intermediate stage
  before it lands in the DB — consistent with how `assess-*.ts` already stages through JSON rather than
  writing straight to SQLite. Not decided; noted as aligned with the existing project pattern
  (`extract-*.ts` → DB is the current norm, but nothing here blocks an intermediate stage for this
  specific, unusually messy source).

Run the rest of **Track A** to a decision before **Track B** (capability surfacing), which needs the
stable device key Track A produces and remains the strongest candidate for its own scoped build issue
rather than riding the same extractor.

## Open questions

See "Open research questions" above. `B-0006` and `B-0007` stay `open` for now as historical record but
should be marked `resolved`/superseded once this briefing's research pass produces a concrete plan that
folds their concerns in.
