---
id: B-0017-hardware-overlay-device-resolution
topic: manual.mikrotik.com /hardware overlay — device identity/alias resolution across sources
status: open
related_tasks:
  - "#28"
created: 2026-07-10
last_revisited: 2026-07-10
---

# Question

Before `/hardware` (240+ Docusaurus pages) can be ingested as an overlay on rosetta's existing `devices`
data, how should devices that appear under different names/slugs/model-numbers across `matrix.csv`, the
www product pages, and `/hardware` get resolved to one canonical identity?

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
- **`B-0007` (special hardware pages)**: flagged Confluence-era pages (Switch Chip Features, Marvell
  Prestera, Peripherals) with device-keyed tables not surfaced in `properties`/`devices`, gated behind a
  similar "watch for misses" trigger. `/hardware` may make some of these moot (if the same chip/port data
  now lives in the Docusaurus `/hardware` pages) or may be an entirely separate concern — not yet checked.
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
code:

1. **Real inventory diff.** Enumerate all 240 `/hardware/<model>` sitemap slugs against `matrix.csv`
   product names/rows. How many have no plausible `matrix.csv` match at all (candidate accessories)? How
   many match cleanly? How many are ambiguous (plausible but not exact)? This is the same discipline
   B-0012 H3 applied to CLI-Reference (full census, not a sample) — do the same here before designing a
   schema.
2. **Naming/slug reconciliation.** For the "plausible match" set, catalog the actual slug/name deltas
   (case, punctuation, model suffixes, marketing vs. model-number names) so the alias table's shape is
   informed by real data, not guessed patterns.
3. **Identity model.** Should devices grow the same `rosetta_id`-style separate-column pattern B-0012 H7
   settled on for pages (`videos.video_id`/`dude_pages.slug` precedent — a synthetic integer PK plus an
   indexed natural-key column), or does the existing `devices.id` (AUTOINCREMENT) plus a new
   `device_aliases` table (one row per alias, FK to canonical `devices.id`) fit better? H7's reasoning
   for pages may or may not transfer — devices already have a synthetic PK today, unlike pages before the
   Docusaurus migration.
4. **Extraction mechanism.** HTML/Markdown parser against live `/hardware/<model>` pages, or
   `search-doc.json` flattened-text as a first pass (per B-0012 H2/H6)? Depends partly on how much
   structured data (vs. prose) the accessory-only pages actually need — a spec question, not just an
   engineering one.
5. **Overlap with B-0007's special hardware pages.** Does `/hardware`'s per-device page content
   supersede the Confluence-era Switch Chip Features/Marvell Prestera/Peripherals pages, or are they
   genuinely different data (per-device installation/safety info vs. per-chip capability tables)? Check
   before assuming one subsumes the other.
6. **Trigger/scope for the alias table specifically.** Does the BACKLOG switch-chip case count as one of
   B-0006's "5+ documented misses," or does `/hardware`'s existence change B-0006's trigger condition
   entirely (i.e., building the overlay *is* the trigger, since it structurally requires resolving
   aliases across three sources rather than waiting for misses to accumulate)?

## Current lean

Research/explore phase, not actionable as a build task yet — consistent with how B-0012's `/docs`
migration was staged (T-0033 research pass before T-0034/T-0035 build). A future task should do a real
diff pass (question 1) first; that result will likely settle questions 2–3 faster than reasoning about
them abstractly, the same way B-0012's H7 identity question got settled by a live prototype (T-0034)
rather than by argument alone.

## Open questions

See "Open research questions" above. `B-0006` and `B-0007` stay `open` for now as historical record but
should be marked `resolved`/superseded once this briefing's research pass produces a concrete plan that
folds their concerns in.
