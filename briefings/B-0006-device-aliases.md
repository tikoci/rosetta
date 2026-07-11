---
id: B-0006-device-aliases
topic: Device AKA / alias handling for renamed models
status: open
related_tasks: []
created: 2026-05-02
last_revisited: 2026-05-02
---

> **2026-07-10:** superseded in scope by `briefings/B-0017-hardware-overlay-device-resolution.md`
> (issue [#34](https://github.com/tikoci/rosetta/issues/34)), which reframes this as a three-way
> identity problem once `manual.mikrotik.com/hardware` is added as a source.
>
> **2026-07-11 — reactivated as the SELECT-side home.** The `device_aliases` table this briefing
> proposed **shipped** in PR #36 (built by `src/extract-hardware-catalog.ts` from the three sources;
> 772 alias rows). So the "table or not, DB or JSON" open questions below are answered: **DB table,
> built at extract time.** What remains, and now lands here, is the *query → device* SELECT side —
> turning a user string into one or more device codes/variants. That's the natural sibling of the
> canonical *matching* helpers added for the /hardware overlay (`canon`/`canonNoRev`/`canonForms` in
> `src/assess-hardware.ts`, PR #37 / `B-0018`). Track A (identity/inventory) and Track B
> (capability surfacing, now in `B-0007`) are the other two legs.

# SELECT-side / `&`-aware matching (2026-07-11)

The overlay work solved *matching a /hardware page to a device*; the open problem here is *matching a
query string to a device*, which has extra structure the alias table doesn't yet exploit:

- **`&`-compound awareness.** A matrix code like `RBLtAP-2HnD&R11e-LTE7` is a base board + an installed
  module. `routeros_search()` / `routeros_device_lookup` should be able to answer "which devices ship
  (or can ship) an `R11e-LTE7`?" — i.e. search *into* the compound, and know that a device *contains* a
  module. The canonical helpers already collapse the surface variance; the SELECT side needs to also
  index the components, not just the whole code.
- **The alias builder still records shared-base / bogus-accessory collisions.** `extract-hardware-catalog.ts`
  builds aliases from every matrix subcode + hardware link + www code, so shared `&`-bases
  (`d53g-5hacd2hnd-tc` → Chateau LTE6-US + LTE12) and shared accessory links (`acsmaufl`, `acrpsma`
  antennas) collide; it keeps one and logs the rest in an `aliasCollisions` ledger (90 as of 2026-07-11,
  see `B-0018`). The matcher already has the fixes to avoid these (the shared-subcode guard and
  `BOGUS_PRODUCT_TOKENS`); folding the same discipline into the *alias* builder is SELECT-side work that
  belongs here, not in the /hardware matcher.
- **Misses log.** This briefing is the home for the ~5+ documented false-empty lookups that justify hand
  aliases (answering the old open question — a dedicated appendix here, not `BACKLOG.md`).

## Original question (renamed-model aliases)

Should rosetta build an alias table for renamed device models (e.g. `hex 2024` → `hEX refresh`), and if so, when? *(Answered above: yes — `device_aliases` shipped in PR #36.)*

## What's grounding this

- `routeros_device_lookup` is intentionally heuristic: handles exact name/code, LIKE, FTS, slug-normalized fallback, superscript normalization, disambiguation notes.
- Renamed-model aliases can still miss. This is documented in `DESIGN.md` as an ongoing concern, not a solved problem.
- The fix shape is straightforward: table of `{alias → canonical_product_name}` consulted before fallback.

## Why not just build it now

- The cost of misses is mostly recoverable (the user retries with another phrasing).
- The maintenance cost of an alias table is real — each new MikroTik product naming change adds rows.
- We don't have telemetry to size the problem.

## Trigger to act

Build the table only when **real false-empty lookups appear**. Each failed lookup gets recorded with: user query, expected product, source evidence (forum post, docs URL, MikroTik product page). Once we have ~5+ documented misses, the alias table earns its keep.

## Open questions

- Where do we record the misses? `BACKLOG.md` Inbox would work; a dedicated `briefings/B-0006-misses.md` appendix is cleaner.
- Should the table live in the DB (new `device_aliases` table) or as a JSON file extracted at build time?
