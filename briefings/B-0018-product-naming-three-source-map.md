---
id: B-0018-product-naming-three-source-map
topic: How rosetta maps MikroTik product naming across /hardware + matrix + www — a human/MikroTik-readable guide to the device→URL map, its parsing tricks, and known source gaps
status: open
related_tasks:
  - "#34"
created: 2026-07-11
last_revisited: 2026-07-13
---

# Purpose & audience

This briefing exists so a **human** (the maintainer, or someone at MikroTik) can understand and audit how
rosetta reconciles MikroTik product naming **without** reading `src/assess-*.ts`, `B-0012`, and `B-0017`
end-to-end. B-0017 is the deep research log (the *why* and the dead ends); this is the standing *what it
does now / how to check it* companion. If the two disagree, this file's "current state" wins for the
mapping mechanics; B-0017 keeps the historical reasoning.

The underlying need: a MikroTik product shows up under **three different names** depending on where you
look, and prompting the MCP to hunt for mapping errors is slow and unreliable. So rosetta joins the three
naming surfaces into a couple of small, diffable tables that a person can eyeball, and fails CI when they
drift. This doc is the map's legend.

## What's grounding this

- Generators: `src/assess-hardware.ts` (matrix ↔ /hardware matcher), `src/assess-www.ts` (www product
  scrape), `src/build-device-map.ts` (the join + drift gate + audit view).
- Committed data: `device-map.tsv`, `hardware-unmatched.tsv`, `device-exceptions.toml`,
  `ros-hardware-assessment.json`, `ros-www-assessment.json`, `matrix/2026-07-07/matrix.csv`.
- Anchor tests: `src/assess-hardware.test.ts` (one test per parsing trick below).
- Prior research: `B-0017` (device-identity resolution), `B-0012` (Docusaurus manual migration).
- Live counts are authoritative via `routeros_stats`; numbers below are as of 2026-07-11 and may drift.

## The three naming surfaces

A single MikroTik SKU can carry three unrelated-looking identifiers:

| Surface | Example identifier | What it is | Naming shape |
|---------|-------------------|------------|--------------|
| **matrix.csv** | `RBLtAP-2HnD&R11e-LTE7` | The product-matrix export — rosetta's canonical device inventory (~156 rows). | Terse board/order codes; `&` joins a base board to an installed module; `+`/`-`/case vary. |
| **/hardware** | `manual.mikrotik.com/hardware/ltap-lte7-kit` | The new Docusaurus hardware pages (~239 sitemap URLs, B-0012). | Lowercase hyphenated *slugs*, often the friendly marketing name, sometimes with the code appended. |
| **www product** | `mikrotik.com/product/ltap_lte7_kit` | The marketing product page. | Lowercase underscored slugs; usually the friendly name; specs table carries a "Product code". |

The three sets are **not** the same devices with different spelling. `/hardware` has *more* pages than
matrix has rows (series/index pages, accessories, legacy/EOL devices), and some matrix devices have no
`/hardware` page at all. Reconciling them is a three-way join, not a rename.

## How rosetta joins them → the tables

```text
matrix.csv ──┐
             ├─► assess-hardware.ts ─► ros-hardware-assessment.json ─┐
/hardware ───┘   (canonical matcher)                                 │
                                                                     ├─► build-device-map.ts ─► device-map.tsv
www ─────────►   assess-www.ts ────► ros-www-assessment.json ────────┘        │                (156 devices → URLs)
                 (scrape specs)                                                ├─► hardware-unmatched.tsv
                                                          device-exceptions.toml ┘                (100 /hardware pages
                                                          (12 curated odd-balls)                    with no matrix row)
```

- **`assess-hardware.ts`** matches each `/hardware` page to matrix rows by canonical code, then slug,
  then a regulatory Model-column table (in that precedence). Output: `ros-hardware-assessment.json`.
- **`assess-www.ts`** scrapes `mikrotik.com/product/<code>` pages into `ros-www-assessment.json`.
- **`build-device-map.ts`** joins both onto matrix, one row per device. Anything it can't resolve by
  rule must be listed in `device-exceptions.toml` or CI fails. It emits two artifacts and a drift gate.

## The parsing "tricks" (and where they hint at source-data problems)

These are the canonicalization steps that let one SKU's three names collapse to one key. Each is anchored
by a test in `src/assess-hardware.test.ts`. Where a trick exists **only** to paper over inconsistent
source data, that's flagged — it's a candidate to fix upstream rather than in rosetta forever.

1. **Full `&`-compound matching (P1).** `RBLtAP-2HnD&R11e-LTE7` is a *base board* (`RBLtAP-2HnD`) plus an
   installed *module* (`R11e-LTE7`). The matcher canonicalizes and matches the **whole** compound, not
   just the split halves, so kit slugs like `atlgm-and-eg18-ea` resolve. *Source note: the `&` convention
   is MikroTik's; see "base-device modelling" below for where it should become queryable metadata.*
2. **Punctuation/case/`+`/`&` canonicalization (P2).** `canon()` lowercases and folds `+`→`plus`,
   `&`→`and`, then strips non-alphanumerics; `canonNoRev()` additionally drops trailing `rN`
   revision/`NNN` suffixes. So `RB5009UPr+S+IN`, `rb5009upsin`, and `RB5009UPr+S+IN r2` share a key.
3. **Precedence `code > slug > table` + cross-page suppression (P3).** Regulatory Model-column tables on
   a page list *every* variant covered by that filing, so a naive table match binds unrelated SKUs (e.g.
   Chateau LTE7/LTE12 → `chateau-lte6-us`). Code and slug matches win over table matches, and once a page
   claims a device by code/slug, other pages' table-only claims on it are dropped. *Source note: the
   Model-column over-listing is a `/hardware` page-authoring artifact.*
4. **Bogus-link filter (P4).** Some `/hardware` pages link a placeholder www product (`qm_x`,
   `lora_antenna_kit`, …); `BOGUS_PRODUCT_TOKENS` drops these so they don't become false www matches.
   *Source note: these are broken links on `/hardware` pages — worth reporting upstream.*
5. **Shared-base guard.** A base code that appears in more than one matrix row (`computeSharedSubCodes()`)
   is excluded from code/table matching, so a shared base like `D53G-5HacD2HnD-TC` can't make
   `chateau-lte6-us` claim `Chateau LTE12 (2025)`.

## The data artifacts & their fields

### device-map.tsv — one row per matrix device

The forward view: "for this device, where are its pages?" Regenerate with `make device-map`.

| Column | Meaning | Sourced from |
|--------|---------|--------------|
| `name` | matrix "Product name" (the human name) | matrix.csv |
| `code` | matrix order/board code | matrix.csv |
| `category` | device category (Switches, LTE products, …) | the matched /hardware page's sidebar category |
| `resolution` | how the row resolved — `auto`, or an exception class (below) | build-device-map.ts |
| `hw_url` | `/hardware` page URL (blank = no page) | matcher, or exception `hardware_slug` |
| `www_url` | www product URL (blank = none found) | www scrape, or exception `www_code` |
| `needs_review` | blank when `auto`; else the exception class needing a human eye | build-device-map.ts |
| `note` | maintainer note (exceptions only) | device-exceptions.toml |

### device-exceptions.toml — the curated odd-balls

The genuine non-1-to-1 cases the matcher can't reach. Each `[key]` is a matrix "Product name". The
**class** names *which side is missing / why*, so you can tell rosetta's mapping gaps from MikroTik's
source-data gaps:

| class | Meaning | Which URL is blank |
|-------|---------|--------------------|
| `curated-alias` | Both pages exist but under a marketing name no rule reaches; slug+code are hand-verified. | neither (our-side mapping) |
| `no-hardware-page` | MikroTik publishes no `/hardware` page for this SKU (their doc gap). `www_code` given if www exists. | `hw_url` |
| `no-www-product` | No `mikrotik.com/product` page could be located. `hardware_slug` given if `/hardware` exists. | `www_url` |
| `accessory` | A user-installable module (LTE/LoRa/wireless miniPCIe), not a standalone device. | usually `hw_url` |

As of 2026-07-11: 12 exceptions — 5 `curated-alias`, 6 `no-hardware-page`, 1 `accessory` (`R11e-LTE7`).
(`no-www-product` remains a valid class but is currently unused — `SXTsq 5 ax` moved to `curated-alias`
once its www slug `sxtsq_5ax` was confirmed.)

### hardware-unmatched.tsv — /hardware pages with no matrix device

The reverse view, so the "why isn't this page in the map?" set is auditable instead of invisible.
102 pages as of 2026-07-13 (was 100 on 2026-07-11; not a drift gate, so small counts move between
audits — see below). Columns: `slug, category, is_series, cause, url, mentioned_codes`. A row here
is usually one of:

- a genuine **non-device** — `Accessories`/`Antennas`/`Interfaces` (e.g. `gper`, `mqs`, `mant-series`);
- a **series/index** page (`is_series = yes`) that fronts several real devices;
- a legacy/**EOL** device dropped from the current matrix;
- **or a real device missing from matrix.csv** — the audit-worthy case (see "matrix gaps" below).

## How to audit the mapping

1. `make device-map` — regenerates both TSVs and runs the drift gate. Clean exit = every matrix device
   resolves by rule or a live curated exception.
2. Open `device-map.tsv`, sort/scan the `needs_review` column — every non-blank row is a curated call you
   can double-check against the two URLs.
3. Open `hardware-unmatched.tsv`, filter `category` to the device-ish buckets (LTE/Ethernet/Wireless);
   anything there that *is* a current product is a matrix gap to file.
4. Spot-check URLs: both `hw_url` and `www_url` should return HTTP 200. (The 12 exception www codes were
   HTTP-checked 2026-07-11.)
5. `bun test src/assess-hardware.test.ts` — the parsing tricks are anchored; a regression trips here.

## Data-quality checks, fragility & "future failures"

- **Drift gate (blocking):** `make device-map-check` exits non-zero if (a) a matrix device stops
  auto-resolving and isn't in `device-exceptions.toml`, or (b) a curated exception goes stale (the device
  now auto-resolves, or its matrix row vanished). This is the "fail CI so a human reviews the change"
  mechanism. **Not yet wired into a CI workflow** — see undone work.
- **Anchor tests:** `src/assess-hardware.test.ts` locks current matcher behaviour so refactors are safe.
- **Fragility / likely future failures:**
  - The matcher reads committed JSON (`ros-hardware-assessment.json`, `ros-www-assessment.json`). If those
    aren't re-run after a matrix or `/hardware` refresh, the map silently reflects stale scrapes. `make
    assess-hardware assess-www device-map` is the refresh order.
  - `hardware-unmatched.tsv` is **not** a drift gate — MikroTik adds/retires `/hardware` pages routinely,
    so gating on its count would be noise. It's an audit artifact only.
  - New `&`-compound modules or a new revision-suffix style could slip past canonicalization; add a test
    when one appears.
  - `SXTsq 5 ax` has an unresolved www slug — a placeholder in the map until confirmed.

## Known `/hardware` source gaps (feedback for MikroTik)

MikroTik is actively building out `manual.mikrotik.com`, so these are collected as constructive feedback,
not rosetta bugs. All are grounded in the artifacts above.

- **The whole LTE7 series is missing from `/hardware`.** The CAT6→CAT7 refresh (LtAP LTE7, SXT LTE7,
  Chateau LTE7 ax — see the [news131 blog](https://manual.mikrotik.com/blog/news131)) swapped in the
  `&R11e-LTE7` module, but the LTE7-kit SKUs have no `/hardware` pages (`LtAP LTE7 kit`, `LHGG LTE7 kit`
  are `no-hardware-page` in the exceptions; their www products *do* exist). Likely cause (hypothesis): the
  Docusaurus `/hardware` build sourced from the `help.mikrotik.com` UM Confluence space, and the LTE7
  regulatory/hardware info lived only in **per-model PDFs** on cdn.mikrotik.com (e.g.
  `QG_R11e-LTE7_260241.pdf`) that the migration scripts didn't glob — so the LTE7 content was "hidden" in
  PDFs and got skipped. The stray `QG`/`qm_x` placeholder links on some pages may be the same PDF-glob
  logic misfiring. **Suggested fix upstream:** add an `R11e-LTE7` entry to `/hardware/r11e-series`
  (or a dedicated page) since it's a valid SKU with a www product.
- **`R11e-LTE7` (and the R11e module family) has no `/hardware` page** despite a www product
  (`mikrotik.com/product/r11e_lte7`). Other `R11e-*` modules are similarly absent from *both* `/hardware`
  and matrix (see "matrix gaps").
- **Broken placeholder www links** on some `/hardware` pages (`qm_x`, `lora_antenna_kit`, `acsmaufl`, …)
  — filtered by `BOGUS_PRODUCT_TOKENS`, but they're real broken links worth fixing.
- **Regulatory Model-column over-listing** — pages list every variant a filing covers, which is
  technically fine but forces rosetta's cross-page suppression to avoid false binds.
- **Recent-SKU lag** — `Chateau LTE12 (2025)`, `LAMP 5G R16` have www products but no `/hardware` page yet.

## Undone work (tracked here, not yet issues)

Ordered roughly by leverage. Promote to GitHub issues when picked up; this section is the holding pen so
B-0017 doesn't keep absorbing scope.

1. **✅ Drift gate wired into CI on every PR — shipped in PR #41 (2026-07-11)** (`.github/workflows/test.yml`
   "Device map drift gate" step, also rehearsed in `qa.yml`'s `device-map` scope). Scope is deliberately
   coherence-only: `make device-map-check` validates the *committed* snapshot (device-map.tsv,
   hardware-unmatched.tsv, device-exceptions.toml, both assessment JSONs) against each other, no network.
   `make assess-hardware` / `make assess-www` (the live-fetch re-scrape of manual.mikrotik.com /
   mikrotik.com) deliberately stay manual/local — see the comment in `test.yml` above the drift-gate step.
1a. **✅ Scheduled live-refresh — `.github/workflows/device-map-refresh.yml`.** Runs
    `make assess-hardware assess-www device-map` live on a weekly cron (+ manual dispatch). It *detects*
    drift, it doesn't fix it: when the regenerated artifacts differ from committed (or a device no longer
    resolves without a `device-exceptions.toml` entry), it fails the run (red check + scheduled-failure
    notification), uploads the regenerated artifacts, and opens/refreshes one tracking issue with the diff —
    so upstream changes (new/moved/removed `/hardware` or www pages) surface without a human remembering to
    re-run the "How to audit" steps by hand. Fixing it is the normal flow: regenerate locally, review per
    "How to audit" below, and open a standard PR (which runs the required `device-map-check` gate). It files
    an issue rather than an auto-PR because a PR pushed with the default `GITHUB_TOKEN` can't trigger
    `test.yml`, so it could never satisfy `main`'s required `test` check.
2. **✅ `hardware_catalog` + `device_aliases` schema/ETL — shipped in PR #36** (`src/extract-hardware-catalog.ts`).
   `device-map.tsv` stays as the human-reviewable artifact; the DB overlay answers the same joins for the MCP.
3. **Matrix gaps — devices in `/hardware` but not matrix.csv.** Audit `hardware-unmatched.tsv`'s
   device-category rows (e.g. `ltap-lr8-lte6-kit`, various CCR/CRS/Chateau/Cube slugs) and decide which are
   real current products the matrix export dropped. Also the **`R11e-*` module family** has ~12 www
   products (`R11e-2HPnD`, `R11e-5HacD`, `r11e_lr8g`, `r11e_lte6`, …) with no matrix rows — a `matrix-gap`.
4. **`&`-aware SELECT-side matching — tracked in `B-0006`.** Making the base/module split of
   `RBLtAP-2HnD&R11e-LTE7` queryable ("which devices ship, or *can* ship, an `R11e-LTE7`?") is the query→device
   SELECT side, and lands in `B-0006` alongside the alias table. Same place fixes the alias builder's
   shared-base / bogus-accessory collisions (it doesn't yet apply the matcher's guards).
5. **Modules & radio-band capture (the R11e tangent).** Treat `R11e-*` as **special accessories, not devices**
   (see resolved decisions): use the richer **www** data as their source, capture supported LTE/5G bands (and
   LoRa frequencies) into the `ros-www-assessment.json` spec JSON, and surface them on the base devices that
   expose a miniPCIe slot (known from matrix). Band data is only sometimes on the www page (some lives in
   per-model PDFs / regulatory filings), so expect per-modem exceptions — FCC-ID / filing data may be the
   richer RF source. Self-contained tangent; stays here rather than in B-0006/B-0007.
6. **Non-device `/hardware` audit follow-up.** `hardware-unmatched.tsv` surfaces the set; a light
   classification (accessory vs series vs missing-device) could be added if the raw list proves noisy.
   Surfacing an accessory's `/hardware` page on a search hit (even when it has no matrix row) is acceptable.
7. **✅ `SXTsq 5 ax` www slug resolved** — `mikrotik.com/product/sxtsq_5ax` + `/hardware/sxtsq-5axd`
   (maintainer-confirmed 2026-07-11); now a `curated-alias`.

## Resolved decisions (2026-07-11 maintainer)

- **Taxonomy: mirror MikroTik's own schemes — do NOT invent a custom module/kit map.** MikroTik overloads
  "series"/"kit" (LTE/5G/LoRa *and* non-radio); rosetta follows their naming rather than imposing its own.
- **`R11e-*` (and the miniPCIe module family) are special accessories, not first-class devices.** They can
  live in a dedicated `modules` table (covering whatever follows the `&` in a device's code) or fold into a
  generic `accessories` table for the non-device `/hardware` pages where www is the richer source. The link
  to base devices is the miniPCIe slot (from matrix) for "can ship" and the `&` compound for "does ship".
- **Band/frequency data is worth capturing but not uniformly reliable on www** — some is PDF/regulatory-only,
  so it needs an exceptions path (and possibly FCC-ID/filing sourcing). Not blocking; the modem tangent is
  lower priority than getting the core device plumbing broadly wired.
