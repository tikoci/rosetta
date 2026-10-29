---
id: B-0026-device-rf-documents-antenna-patterns
topic: Where antenna/RF data lives for MikroTik wireless gear, and how device_documents + pattern tables + a skill should carry it
status: open
related_tasks: ["#190", "#70", "B-0017", "B-0018", "B-0019"]
created: 2026-10-29
last_revisited: 2026-10-29
---

# Question

#190 records that rosetta answers nothing about Wi-Fi antenna questions
(beamwidth, patterns, polarization) and sketches three possible shapes:
store product-page PDF links, mine brochure spec tables, link-only for plots
with FCC filings as an open question. Before any of that becomes work: what
does upstream actually publish, in what shapes, for which devices — and where
would it fit in the ETL/DB and the MCP/CLI surface?

# What's grounding this

Two triage rounds on 2026-10-29, all live fetches (scratch in `/tmp`, nothing
committed):

- **Round 1 — product pages and brochures.** Fetched ~30 product pages from
  `mikrotik.com/product/<slug>` (slugs from `sitemap.xml`, 566 product URLs).
  Downloaded and inspected with `pdftotext -layout`, `pdfimages -list`, and
  `pdftoppm` renders: new brochures (`hAPax3_250351.pdf`, 5pp;
  `LHGXL5axandLHG5ax_251143.pdf`, 3pp), the old brochure cited in #190
  (`LHG_5_all_180105.pdf`, 3pp, all pages rendered and viewed), both
  `*-patterns_*.pdf` files found, one CST `.txt` pair, and one `.ant` file.
- **Round 2 — FCC/CE.** `pdftotext` of the hAP ax³ FCC grants
  (`GRANTDTS_221144.pdf`, `GRANT_NII_221131.pdf`) and DoC
  (`ID213.3_C53UiG5HPaxD2HPaxD_DOC_260544.pdf`). Exhibit census of two
  filings via fccid.io: `TV7C53-5AXD2AXD` (hAP ax³, has an Antenna Report)
  and `TV7LHG5HPACD2HPD` (LHG XL 52 ac, has none). Downloaded the 13-page
  Antenna Report via fccid.io's content-addressed mirror, rendered a pattern
  page, extracted its spec text.

# Findings, round 1: the plots are not in the brochures

This corrects #190's central premise. The old LHG brochure has **zero** polar
plots: p1 product photos, p2 spec table (beamwidth as *text*: 7°, 6.4°), p3
Tx/Rx tables plus a marketing distance chart. The new brochures don't even
carry beamwidth text — gain only (`Wireless antenna max gain 2.4 GHz
(3.3 dBi), 5 GHz (5.5 dBi)`).

Antenna data lives as **separate attachments on legacy product pages**, in
three shapes:

1. **Pattern PDFs** (`sxt-patterns_130542.pdf`, `omnitik-patterns_170115.pdf`).
   One A4 page: 2 gain-vs-frequency cartesian charts + 4 raster polar plots
   (H/V polarization × 0°/90° cuts). Traces are ~555px raster at 144dpi;
   only axis labels (`-10dBi`, `0dBi`) are text. Digitizing traces is an
   image-processing project, not ETL.
2. **CST farfield `.txt`** (`Gain_h_polar_171213.txt`, `Gain_v_polar_171213.txt`,
   `ANTENNA_HORIZONT-*.txt`, …). Tabular ASCII, 1° steps: Theta, Phi,
   directivity, Theta/Phi components, phase, axial ratio. Already
   machine-readable. ~55KB per cut.
3. **`.ant` files** (`antenna_pattern_*.ant`). 720 bare values = 360° azimuth
   + 360° elevation, dB relative to boresight (Radio Mobile convention;
   verified: discontinuity at index 360, wrap-around at 359→0). Already
   machine-readable. ~5.6KB each.

**Coverage is legacy-only and frozen.** About half the sampled n/ac-era PtP
pages carry antenna attachments (SXT, LHG n, DISC, OmniTik; no pattern from
Groove, DynaDish, wAP ac, LDF, SEXTANT). **10/10 current-era devices checked
with exact sitemap slugs have none** (`cap_ax`, `wap_ax`, `sxtsq_5ax`,
`lhg_5_ax`, `audience`, `netbox_5_ax`, `mantbox_ax_15s`, `hap_ax2`,
`hap_ax_lite`, `cap_xl_ac`, `hap_ac3`). MikroTik stopped publishing this
data — ingestion is a static backfill, not a growing feed.

**Discovery is easy.** The pages are the same server-rendered Livewire HTML
`src/extract-test-results.ts` already parses. Every attachment anchor carries
a `title="Open …"` label (`Antenna patterns`, `ANT-H`, `Horizontal Azimuth`,
`brochure`, `FCC Grant of Certification (5GHz)`, `Dimensions`, …) plus a
first-page `_thumb.webp` preview for PDFs. Slug discovery reuses the existing
sitemap + override machinery.

# Findings, round 2: FCC sometimes, CE never

| Source | RF content (verified) |
|---|---|
| FCC Grant PDF (product-page link) | Frequency range, conducted power, emission designator. No gain, no beamwidth. |
| EU DoC (product-page link) | Standards list only (`EN 300 328`, `EN 301 893`, …). Zero RF numbers. |
| EU test reports | Not public. Dead end — nothing behind the DoC to fetch. |
| FCC filing exhibits | **Hit-or-miss.** hAP ax³ has a 13pp Antenna Report (vendor datasheet: peak gain/band, efficiency, polarization, radiation type, pattern plots per plane/band with max/min/average tables as text). LHG XL 52 ac has no antenna exhibit at all. External-dipole devices get vendor sheets; integrated-antenna PtP gear usually doesn't. |

No source states **beamwidth as a number** except old brochure spec tables.
Everywhere else it is derivable (from `.ant`/`.txt`/CST data, or measured off
plots), never stated.

**Access notes.** `apps.fcc.gov` Akamai-blocks bot fetches (`Access Denied`
to curl). fccid.io mirrors every exhibit PDF content-addressed at
`/m/<sha256>.pdf` — that worked. It has light bot protection (a security
check tripped after several rapid requests), so an exhibit crawler needs
politeness delays and caching, not concurrency. The FCC ID is derivable from
the grant PDF content/filename on the product page (grantee code `TV7`).

# The critical-details matrix

For link-planning questions the details that matter, in rough priority
order, are gain → beamwidth/HPBW → polarization → front-to-back ratio →
frequency range. Availability:

| Detail | Matrix | Brochures | Product-page antenna files | FCC exhibits |
|---|---|---|---|---|
| Gain | ✅ (2.4/5 only) | ✅ text | ✅ (pattern peak) | ✅ (gain tables) |
| Beamwidth | ❌ | ⚠️ old brochures only | ✅ derivable (`.ant`/`.txt`) | ⚠️ derivable from plots |
| Polarization | ❌ | ⚠️ sometimes | ✅ implied by H/V cuts | ✅ stated |
| Front-to-back | ❌ | ❌ | ✅ derivable | ⚠️ derivable |
| Patterns | ❌ | ❌ (verified: none) | ✅ | ⚠️ raster, when present |

The awkward shape: beamwidth is *most* available where numeric pattern data
already exists (legacy gear) and *least* available for modern gear, where the
only sources are brochures (gain-only) and occasional FCC exhibits.

# Proposal: `device_documents` with RF metadata, not a bare link table

A bare (device, label, URL) table undersells the corpus: an FCC grant link
and a CST `.txt` are very different promises to an agent. Sketch:

- `device_documents(device_id, kind, label, url, source, rf_content, …)`:
  `kind` normalized (`brochure`, `quick_guide`, `doc`, `fcc_grant`,
  `fcc_exhibit`, `antenna_pattern_pdf`, `antenna_data`, `dimensions`,
  `block_diagram`, `user_manual`), `label` verbatim from `title="Open …"`,
  `source` distinguishing `product-page` from `fcc-filing` (second-order
  discovery), `rf_content` a small tag set — `none`, `gain-spec`,
  `beamwidth-spec`, `polar-plots`, `numeric-pattern`, `test-report`.
  "Has RF data" is then `rf_content != 'none'`, and the tag says what kind.
- `antenna_files(device_id, kind, cut, label, url)` for the three pattern
  shapes (`cst_txt`, `ant`, `pattern_pdf`), with cut metadata (H/V,
  azimuth/elevation, 0°/90°) parsed from the label/filename.
- `antenna_pattern_points(file_id, cut, theta_deg, gain_db, …)` for the two
  numeric shapes. Full-fidelity rows, not blobs — same rationale as
  `device_test_results`: SQL-native comparison ("which CPE has the wider
  5GHz azimuth pattern?").
- **Derived scalars on the device row or a side table**: `beamwidth_h_deg`,
  `beamwidth_v_deg` (-3dB, computed from numeric patterns where available,
  else brochure text with provenance), `gain_peak_dbi`,
  `polarization`, `f_b_ratio_db`. Computed at extraction, provenance-stamped;
  brochure-text values lose to computed ones on conflict.
- **Pattern PDFs**: split, don't digitize. Each 1-page PDF is already 4
  separate raster objects (`pdfimages`); store plot index + caption
  (H/V × 0°/90°) as the addressable unit, link-only. Trace digitization is
  an explicitly out-of-scope research spike unless proven cheap.
- Refresh: antenna rows are frozen (legacy corpus), but `device_documents`
  generally should re-crawl on the device-map refresh — CDN filenames carry
  revision date stamps (`_250351`), so new revisions surface as new URLs.

Each extraction phase needs its own `V-*` rows in `VALIDATION.md` per the
usual convention (counts, idempotency, label↔URL pairing); no IDs minted
here.

# Surfacing: where this fits in the MCP/CLI/TUI interface

Constraints, in order: (1) the tool-surface consolidation lean (B-0011,
B-0025 — no new single-purpose tool without a fight); (2) TUI/MCP parity;
(3) the agent-first CLI registry (#221) inherits whatever the MCP does, so
deciding the MCP shape decides the CLI shape.

- **Fold documents + derived scalars into `routeros_device_lookup`
  (recommended).** Attach `documents[]` (label, kind, URL, `rf_content` tags)
  to exact/small result sets — the same auto-attach precedent as test
  results. Add a `has_rf_data` filter alongside the existing
  `has_wireless`/`has_lte`/`has_poe` booleans. Derived scalars
  (`beamwidth_h/v`, `gain_peak`, `polarization`) ride on the device row with
  provenance, so "what's the beamwidth of an LHG XL 5 ac?" answers in one
  call with no new tool.
- **Pattern points as an MCP resource + TUI view (recommended).**
  `rosetta://datasets/antenna-patterns.csv` (or per-device slices) for
  bulk/reporting use, mirroring the existing test-results and catalog CSV
  resources. The TUI device view gains a documents/patterns section per the
  parity rule. No new tool; the resource is deliberate-attach, matching the
  tools-vs-resources split in DESIGN.md.
- **A dedicated `routeros_antenna_patterns` tool (considered, not
  recommended).** Narrow audience (only legacy devices have data), and it
  spends the tool-surface budget the consolidation track is trying to save.
  Revisit only if device_lookup attachment proves insufficient for
  pattern-comparison questions.
- **`routeros_search` related-block entry (considered, not recommended).**
  Antenna questions arrive as device questions ("beamwidth of X", "pattern
  of Y vs Z"); `device_lookup` is the entry point, and a search-side hook
  adds classifier surface for little gain.
- **Interpretation belongs in a skill, not rosetta.** A `routeros-skills`
  RF/link-planning skill (what H/V × azimuth/elevation cuts mean, deriving
  HPBW and F/B from pattern rows, EIRP/link-budget basics, which attachment
  types to trust for what) keeps vendor data and guide advice on opposite
  sides of the existing attribution boundary. Rosetta ships the rows; the
  skill teaches the reading.

# Phasing

1. **Phase 0 — `device_documents`.** Extend the product-page extractor to
   capture all `title="Open …"` anchors. Benefits every device, RF or not.
2. **Phase 1 — antenna census.** Classify antenna-titled links by
   extension/shape into `antenna_files`. Full inventory: which devices have
   what. (Mostly a filter over Phase 0's crawl.)
3. **Phase 2a — numeric ingestion.** Parse `.txt` + `.ant` into
   `antenna_pattern_points`; compute derived scalars.
4. **Phase 2b — pattern-PDF split.** Per-plot addressability (plot index +
   caption), link-only.
5. **Phase 3 (optional) — brochure spec-table mining + FCC exhibits.**
   Beamwidth/gain text for legacy brochures; FCC exhibit crawl for the
   modern-gear gap. The exhibit leg needs a coverage census first (what
   fraction of `TV7` filings carry an Antenna Report?) before it earns ETL.

# Open questions

- Does beamwidth-as-derived-scalar satisfy the agent use case, or is there a
  question class that needs raw pattern rows at query time (i.e., does the
  no-new-tool lean survive contact with real questions)?
- FCC exhibit coverage census: what fraction of `TV7` filings have an
  Antenna Report, and is it worth a polite crawler?
- Pattern-PDF digitization spike: is red-trace extraction off a known grid
  actually cheap, or does it stay link-only forever?
- Skill ownership: new `routeros-skills` RF skill, or a section in an
  existing wireless skill?
- Does the legacy-only/frozen finding change #190's "future, not urgent"
  priority — i.e., is a static backfill worth scheduling precisely because
  it will never grow?
