---
id: B-0007-special-hardware-pages
topic: Extracting device-specific tables from special hardware pages
status: open
related_tasks: []
created: 2026-05-02
last_revisited: 2026-05-02
---

> **2026-07-10:** superseded in scope by `briefings/B-0017-hardware-overlay-device-resolution.md`
> (issue [#34](https://github.com/tikoci/rosetta/issues/34)), which asks whether
> `manual.mikrotik.com/hardware`'s per-device pages supersede these Confluence-era pages or are a
> genuinely separate concern (open question there, not yet resolved).
>
> **2026-07-11 — reactivated as the Track B home.** B-0017's device-identity work (Track A) shipped
> as `hardware_catalog` + `device_aliases` (PR #36) with the matcher fixes and reviewable map in
> PR #37 (see `briefings/B-0018-product-naming-three-source-map.md`). That gives Track B — **surfacing
> per-device capabilities** (switch chip, L3HW, VRF, HW QoS, PTP, and resolving them from feature-support
> tables *and* free-form user text) — the stable device key it was gated on. Rather than keep growing
> B-0017, that research lands **here**: this briefing was always about extracting device-keyed capability
> tables that `properties`/`devices` don't surface, which is exactly Track B. B-0017 keeps the identity
> rationale; new capability-surfacing research goes below.

# Track B — device-capability surfacing (2026-07-11)

The device-identity foundation is in place (stable `hardware_catalog.rosettaDeviceId`, `device_aliases`
resolution). Track B is the payoff layer on top: given a resolved device, answer capability questions.

- **Sources:** the Confluence-era special pages named below (Switch Chip Features, Marvell Prestera,
  Bridging and Switching, Peripherals) plus any device-keyed tables on `manual.mikrotik.com/hardware`
  pages. The open "generic page-tables extractor vs per-page extractors" question below still applies.
- **Resolution both ways:** capability tables → device (a chip row lists the models that carry it), and
  free-form user text → capability (an agent asking "does CCR2004 do L3HW?").
- **Related but out of scope here:** matching a *query string* to a device is the SELECT side, tracked in
  `B-0006`; radio-band capability for `&R11e-*` modem modules is a self-contained tangent parked in
  `B-0018`'s undone-work list. Track B is about non-radio silicon/feature capabilities.

## Original question (device-keyed tables) — still the concrete first step

Several hardware-specific HTML pages (Switch Chip Features, Marvell Prestera, Bridging and Switching, Peripherals) contain device-specific tables that aren't surfaced in `properties` or `devices`. Worth extracting?

## What's grounding this

- The pages exist in the Confluence export.
- Tables are device-keyed (rows per chip / port profile), unlike `confluenceTable` "Property | Description" pairs.
- `extract-properties.ts` is property-shaped only.

## Trigger to act

Watch for user-visible misses: agents asking "what switch chip is in CCR-X?" returning nothing useful from existing tools. If those misses become a pattern, it's worth a dedicated extractor.

## Doc → device cross-referencing (routed here from #39, 2026-07-12)

Maintainer feedback on #39 (Phase 2 hardware surfacing) parked a related idea here because it's the
"free-form text → device/pivot" direction Track B already owns:

- **`routeros_get_page` gains a "references devices" (and "references pivots" — e.g. switch chips) block.**
  Recursively scan main-doc prose for device/alias/chip mentions and link them to `hardware_catalog` /
  `device_aliases` rows, so a doc page surfaces the concrete devices it talks about.
- **Main docs as a test corpus, two ways:** (1) they're a realistic stress test for how well the
  Phase 2 alias/fuzzy resolver surfaces devices from unconstrained prose (the actual Phase 2 deliverable,
  per its opening); (2) counting how often devices are *actually mentioned* in main docs scopes whether a
  doc→device index is worth building at all — the "trigger to act" evidence this briefing already asks for.
- **Sequencing:** downstream of Phase 2 (#39 → the alias resolver must exist first) and of a decision on
  the generic page-tables extractor below. Not `agent-ready`; research/scoping first. Promote to an issue
  once the Phase 2 resolver lands and a mention-frequency probe shows the payoff.

## Open questions

- Would a generic "page tables" extractor (one row per `<table>` in pages, structured) cover this and other future cases more cheaply than per-page extractors?
- What precision does prose device-mention detection need before a "references devices" block helps more than it misleads? (An over-eager match that links every "hAP" mention is noise; the alias table's exact-normalized keys are the conservative starting point.)
