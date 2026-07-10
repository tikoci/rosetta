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
  live `/hardware/<model>` sitemap URLs. The maintainer's working assumption (2026-07-10, not yet
  verified by a real diff) is that the gap is largely **accessories** — e.g. `TR-LR82`-style items —
  that never had a `matrix.csv` row because the matrix is scoped to routers/switches with the matrix's
  own column schema (CPU, architecture, ports, license level), not general hardware.
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
migration was staged (T-0033 research pass before T-0034/T-0035 build). A future task should do a real
diff pass (question 1) first; that result will likely settle questions 2–3 faster than reasoning about
them abstractly, the same way B-0012's H7 identity question got settled by a live prototype (T-0034)
rather than by argument alone. Run **Track A** (identity/inventory) first — **Track B** (capability
surfacing) needs the stable device key it produces — and expect Track B to become its own scoped build
issue rather than riding the same extractor.

## Open questions

See "Open research questions" above. `B-0006` and `B-0007` stay `open` for now as historical record but
should be marked `resolved`/superseded once this briefing's research pass produces a concrete plan that
folds their concerns in.
