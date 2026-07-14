---
id: B-0021-off-matrix-nomenclature-derivative-parts
topic: Naming the current/legacy device split (2B) and the &-module / derivative-part taxonomy (2C)
status: open
related_tasks: []
created: 2026-07-13
last_revisited: 2026-07-13
---

# B-0021 — off-matrix nomenclature + derivative-part taxonomy

Decision-support for **issue #70** (Phase 2B/C). #70 is the committed work item; this briefing
holds the grounding and the naming/scheme rationale so the issue body stays a spec, not an essay.
Two threads:

- **2B — nomenclature.** What do we *call* the current-vs-legacy device split so an agent (and the
  search ranker) can reason about it? `matrix` / `catalog` are internal source names that tell an
  agent nothing.
- **2C — the `&`-module tentacles.** "Module" is not one kind of thing. A device's `&<subcode>`
  can be a MikroTik-sold module, a MikroTik embedded-only module, or a **third-party** (Quectel/etc)
  modem that MikroTik never sells or documents as a product. And the same "derivative part of a
  device" shape covers SFP optics and fans. This decides which of that is in-scope for #70 vs. spun out.

## Grounding (probes, 2026-07-13)

### Matrix is the *current* set; off-matrix is mostly legacy

Joining `matrix.csv` product codes and the off-matrix `/hardware` set against the `discontinued`
boolean on `mikrotik.com/product` pages (`ros-www-assessment.json.products[].discontinued`):

| Cohort | active | discontinued | % discontinued |
|---|---|---|---|
| www products matching a **matrix** code | 74 | **0** | **0%** |
| www products with **no** matrix code (off-matrix) | 99 | 115 | 54% |
| off-matrix `/hardware` **`kind = device`** (resolved www_code) | 3 | 60 | **~95%** |

Not one matrix device maps to a discontinued product; off-matrix devices are overwhelmingly EOL.
So "matrix = current core device" is empirically safe (recorded in `DESIGN.md` → Product matrix CSV).
The `discontinued` flag is a **real, per-product** signal for the 288 www-linked products — not
something to invent — but it's absent for matrix devices with no www match (82/156) and for
off-matrix pages with no www product.

### `&`-subcodes are three different things

27 matrix codes contain `&`, over 18 distinct subcodes. Classifying each subcode against the www
product / notFound lists:

- **MikroTik-sold module (has a www product page): 2** — `R11e-LR8G`, `R11e-LR9G`.
- **www-notFound (fetched, no product page): 16**, which split by code shape into:
  - **Third-party modems (Quectel):** `RG520F-EU`, `EG18-EA`, `EG12-EA`, `RG650E-EU`, `EG06-A`,
    `EG120K-EA`, `BG770A`, `BG77r2`, `EC200A-EUr2/r3` — `EG`/`EC`/`RG`/`BG` are Quectel families.
    MikroTik ships these inside devices but never sells/pages them as its own products.
  - **MikroTik embedded-only modules:** `R11e-LTE7` (+`r2`/`r3`), `R11e-LR2`, `KNe`, `SXTsq` —
    MikroTik `R11e-*`/`KNe` codes with no standalone product page.

So the honest module taxonomy has **three** buckets, and only one of them (2 subcodes) has a
MikroTik product source at all.

## 2B — recommended nomenclature

Retire `matrix` / `catalog` as *user/agent-facing* names (keep them only as internal provenance).
Name things by what the agent reasons about:

- **Row-level lifecycle field: `legacy_hardware` (boolean).** `false` = part of the current core set
  (all matrix devices, plus off-matrix products www marks active); `true` = discontinued or
  otherwise not-current. Derivation: matrix membership → `false`; www `discontinued=true` → `true`;
  off-matrix active www product → `false`; no signal → default `true` (an off-matrix page we can't
  even find a live product for is almost certainly old — the ~95% base rate supports this) **or**
  a distinct `unknown`, maintainer's call. Keep the precise www `discontinued` boolean as the
  provenance `legacy_hardware` is derived from; expose `legacy_hardware` as the single agent-facing
  bit so callers don't juggle "matrix membership AND discontinued AND …".
  - *Why `legacy_hardware`, not `discontinued`, as the exposed field:* it's deliberately coarser.
    We have precise `discontinued` only for www-linked products; for a bare matrix device we know
    "current" but not a per-device EOL date. `legacy_hardware` claims exactly what we can defend
    ("not the current core set") without overstating precision we don't have.
- **Search/scope knob: `include_legacy` (boolean, default `false`)** — replaces the opaque
  `scope = matrix | catalog` enum floated in #70-B. Reads directly against the row field: default
  keeps the core ~156-device experience; `include_legacy=true` opens the wider universe. Still must
  reconcile with #50's `category=` filter (don't ship two competing scope args — see #70).

Naming is a judgement call; `legacy_hardware`/`include_legacy` is the recommendation, but the test
is "does the name tell an agent what it filters?" — anything passing that beats `matrix|catalog`.

## 2C — the `&`-module tentacles: split simple from messy

There are two very different jobs hiding in "surface the `&` module," and they should not block each
other:

1. **The mechanical `&`-cross-link (simple, self-contained → keep in #70-C).** When a resolved
   device's code contains `&<subcode>`, surface the subcode's identity + a link. `assess-hardware.ts`
   already splits matrix codes into `subCodes`; the cross-link is just "expose that split with
   whatever identity we have." This is independent of everything below and is genuine input to 2B
   (an off-matrix module row is a valid link target).
2. **The derivative-part *taxonomy + sourcing* (messy, research → out of #70).** Deciding what each
   part *is* and where its data comes from:
   - `module-mikrotik` — MikroTik-sold, has a www/`hardware` page (2 LoRa subcodes today).
   - `module-embedded` — MikroTik `R11e-*`/`KNe`/`SXTsq` used in devices, no standalone page.
   - `modem-thirdparty` — Quectel/etc; **no MikroTik source will ever exist.** A curated map is the
     only honest home (strawman `third-party-modules.toml` / `non-mikrotik-modules.toml`, same
     pattern as `hardware-www-map.toml` / `device-exceptions.toml`: subcode → vendor, model,
     datasheet URL, note). This is exactly the "compatible but not-MikroTik-shipped" overlap
     `B-0007` already flags for special pages.
   - **SFP optics** — SKU'd MikroTik products (available from `mikrotik.com/sitemap.xml`), linked
     from device/special pages; "derivative data about a device" (which optics a port takes) rather
     than a bundled `&` module. Distinguish **sold** vs **merely compatible/supported**.
   - **Fans / PSUs / other per-model parts** — the `accessory` kind, but device-*keyed* ("fan for
     this model"), which the flat `accessory` bucket doesn't capture.

**Recommendation:** #70-C ships only job 1 (the mechanical cross-link). Job 2 is a design concern
that overlaps `B-0007` (special/compatible-module pages) and the `&R11e-*` radio-band tangent parked
in `B-0018`'s undone-work list; it lives here as research until it earns its own issue. Don't bloat
#70 with the third-party-modem sourcing or the SFP/fan derivative-part schema.

## Open questions

- `legacy_hardware` default for the no-signal off-matrix page: coarse `true`, or a third `unknown`
  state? A three-state field is more honest but complicates the search filter; the ~95% EOL base rate makes
  coarse `true` defensible.
- Does the derivative-part taxonomy warrant a `part_kind` sub-classification on `hardware_catalog`
  (`module-mikrotik` / `module-embedded` / `modem-thirdparty` / `sfp` / `psu` / `fan`), or is a
  curated map per third-party class enough? Leaning: keep `kind` as-is (device/accessory/module/
  series-or-doc) and carry the finer split as curated data, promoting to a column only if a consumer
  needs `WHERE part_kind = …`.
- SFP source: `mikrotik.com/sitemap.xml` gives the SKU list, but the **device ↔ supported-optic**
  edges are the valuable/hard part and may only live in special-page tables (`B-0007` territory).

## Cross-references

- **#70** — the committed Phase 2B/C issue this briefs; 2B nomenclature and the #70-C scope line
  point here.
- **`B-0007`** — special/compatible-module pages; the `modem-thirdparty` and "supported-not-sold"
  overlap.
- **`B-0018`** — three-source product-naming map; parks the `&R11e-*` modem radio-band tangent.
- **`DESIGN.md` → Product matrix CSV** — the "matrix = current core set" assumption note.
