---
id: B-0019-hardware-overlay-phase2-mcp-tui-surfacing
topic: Hardware overlay Phase 2 — surfacing hardware_catalog + device_aliases in MCP/TUI (design pre-plan for #39)
status: open
related_tasks:
  - "#39"
  - "#28"
  - "#27"
created: 2026-07-12
last_revisited: 2026-07-12
---

# Question

Phase 1 (#35/#36) plus the B-0017 cleanup (#48) landed `hardware_catalog` (255 rows),
`device_aliases` (752 rows), and the `device_overview` VIEW — but nothing reads them. How do
`routeros_device_lookup`, the classifier, `routeros_search`'s `related.devices`, and the browse TUI
consume them without adding tool #15, without breaking `V-tool-shapes`/`V-tool-budget`, and with TUI
parity?

This is the design deliverable #39 asks for. Each of #39's six questions gets a **proposed** answer
below (decided/deferred marked per question, pending maintainer review). Grounded in: `src/db.ts`
schema v8, `fixtures/hardware-catalog/catalog.json` (255 rows: 156 matrix-linked, 99 catalog-only, 37
series, 52 discontinued; aliases by source: matrix.csv 263, hardware-slug 205, hardware-link 152,
hardware-table 59, www-declared-code 57, www-compare-id 14, www-code 2), and the current code paths
(`searchDevices()` in `query.ts:1737`, `detectDevice()` in `classify.ts:194`, `routeros_device_lookup`
in `mcp.ts:1186`, `related.devices` in `query.ts:383`, TUI `device` command + `renderDeviceCard` in
`browse.ts`).

# Architectural spine (one decision that answers most questions)

**`devices` stays the primary lookup table; the catalog is consulted at two well-defined points in
`searchDevices()` — an alias stage before LIKE, and a catalog fallback after everything else.** All of
it lands in `query.ts` (per `query-core-not-adapter`), so MCP and TUI inherit identically and parity is
free at the logic level.

Proposed `searchDevices()` pipeline (stages 1, 2–4 unchanged):

```text
1.   exact match on devices.product_name/product_code        (unchanged — shapes stable)
1.5  NEW alias stage: normalize query (lowercase/trim/superscript, same normCode() rules as
     the alias builder) → device_aliases exact hit → device_overview row
       - row has device_id → return the matrix DeviceResult (mode: "alias"), enriched (below)
       - row is catalog-only → return a thin catalog result (mode: "alias")
2.   LIKE / 2b. slug-LIKE                                     (unchanged)
3.   FTS + filters / 4. filter-only                           (unchanged)
5.   NEW catalog fallback: nothing matched in devices → LIKE over hardware_catalog.name
     + device_aliases → thin catalog results (mode: "catalog"), labeled (Q4)
```

Alias lookup is exact-normalized only, **not fuzzy** (Q1): the table was built with the normalization
already applied, fuzzy matching is what stages 2–3 already do against `devices`, and a wrong
"confident" alias hit is worse than falling through. Collisions don't exist at read time — `alias` is
the PK; the 74 build-time collisions were resolved by source-priority ranking in the ETL.

**Enrichment on every matrix-linked result** (exact, alias, LIKE-single): a small `hardware` sub-object
joined from `device_overview`, not a flattening of `specs_json`:

```jsonc
"hardware": {
  "rosetta_device_id": "hap-ax3",          // the stable, agent-persistable key (B-0017 Q3)
  "category": "Indoor wireless",            // /hardware sidebar taxonomy, 12 values
  "discontinued": false,
  "product_page_url": "https://mikrotik.com/product/hap_ax3",  // = mikrotik.com/product/<sourceWwwCode>, 209/255 rows; richer than /hardware (feedback #1)
  "hardware_page_url": "https://manual.mikrotik.com/hardware/hap-ax3",  // from source_hardware_slug; often boilerplate
  "also_known_as": ["C53UiG+5HPaxD2HPaxD", "hap_ax3"],  // top aliases by source rank, cap ~4
  "non_default_ip": "192.168.188.1",        // ONLY when a genuine deviation (see prerequisites)
  "note": "Full specs: routeros_device_lookup rosetta_device_id=hap-ax3 (don't fetch the URLs)"  // steer to tool, not page (feedback #2)
}
```

URLs are provenance/human links only — the `note` steers agents to the device tool rather than
re-tokenizing a page (feedback #2). ~60–120 tokens per single-device response — fits comfortably inside the existing `"hAP ax3"` 6,000-token
budget (`mcp-contract.test.ts` Block B). Multi-result compact lists get only `category` +
`discontinued` per row.

# #39's questions, answered

**Q1 — alias-aware lookup: DECIDED (proposed).** Stage 1.5 above; exact-normalized only; collisions
moot (PK). Lookup by alias returns the canonical device with `also_known_as` + a `matched_alias` note
so agents see why `RB750Gr3` returned "hEX". Classifier: `classify.ts` stays pure (no DB import — its
own header rule); device *detection* stays regex, device *resolution* stays in `searchAll()`. Two cheap
additions: (a) extend `DEVICE_PATTERNS` with catalog-prominent families the regexes miss today
(Chateau, Audience, KNOT, Cube, Disc, OmniTik, PowerBox), (b) in `searchAll()`, when no device
classified and the input is short/token-shaped, one exact `device_aliases` probe of the normalized
whole input — a single indexed lookup, no fuzz.

**Q2 — what surfaces from `specs_json`: DECIDED (proposed).** For matrix-linked rows: nothing from
`specs_json` by default — matrix columns already carry specs; only the `hardware` block above
(category/discontinued/URL/AKA/IP factoid). For catalog-only rows (Q4) the thin shape promotes just the
near-universal core (`Product code`, `CPU`/`Architecture`/`Size of RAM` when present — 82% coverage per
B-0017's census) plus name/category/discontinued. Full `specs_json` passthrough is **deferred**: no
demonstrated consumer, and it's the main budget risk. FCC/IC IDs, `_www_tagline`, regulatory fields:
not surfaced (searchable later if a need shows up).

**Q3 — category / related devices: DECIDED (proposed).** Two pieces: (a) `RelatedDevice` in
`routeros_search`'s `related.devices` gains `category` + `discontinued` (two fields, no new sub-block —
response shape stays list-of-devices); (b) enumeration goes through a new **`category` filter arg on
`routeros_device_lookup`** (12 known values) rather than embedding "related devices in category" lists
in responses — Switches alone has 44 rows, inlining that fights `V-tool-budget`. Single-device
responses and `next_steps` hint the follow-up: `routeros_device_lookup category="Switches"`. An arg
addition is an overlay change, not tool #15 — but it is a schema-key change, so changelog +
`browse.ts` dot-command passthrough + contract snapshots move together (`tool-surface-change`,
`tui-mcp-parity`).

**Q4 — non-matrix entities: DECIDED (proposed) — surface, labeled.** Thin catalog rows carry an
explicit `kind` field so agents never treat an accessory as a router:
`kind: "accessory" | "series" | "discontinued" | "device"` — derived at read time (category ∈
{Accessories, Antennas, Interfaces} → accessory; `source_hardware_slug` ends `-series` and no
device_id → series; `discontinued=1` → discontinued). Thin shape:

```jsonc
{ "kind": "accessory", "rosetta_device_id": "gper", "name": "GPeR", "category": "Accessories",
  "discontinued": false, "product_code": "GPeR", "hardware_page_url": "…", "note": "Not in the
  product matrix — no RouterOS spec columns. Accessory/legacy entry from manual.mikrotik.com/hardware." }
```

**Q5 — page-content ingest: DEFERRED, fields only.** Confirmed lean from the issue. `/hardware` prose
stays out of the `pages` FTS corpus in Phase 2; the one factoid worth carrying is `_non_default_ips`
(already in `specs_json`, needs filtering — prerequisites below). The "regulatory content opt-in"
constraint therefore has nothing to gate yet in Phase 2 — it binds the future ingest decision, which
should be its own scope discussion (ties to B-0012's `/hardware`-excluded-from-llms.txt finding).

**Q6 — `&`-compound / SELECT side: DEFERRED to B-0006**, per the issue's own lean. Nothing in the
stage-1.5/fallback design precludes it: "which devices ship an R11e-LTE7" is a later
aliases/modules-table query, not a shape change to this surface.

# TUI parity plan

All behavior lands in `searchDevices()`, so `device <query>` and `.routeros_device_lookup` inherit
resolution for free. Surface-level work in `browse.ts`:

- `renderDeviceCard`: category + discontinued badge, AKA line, `/hardware` manual URL, non-default-IP
  warning line; thin-row card variant for catalog-only results (shows `kind` prominently).
- Dot-command arg passthrough for the new `category` filter (keeps `browse-parity.test.ts` /
  `V-tui-mcp-parity` green).
- Stats screen (`renderStats`) + `routeros_stats`'s table-inventory description in `mcp.ts` gain
  `hardware_catalog` / `device_aliases` rows (db.ts `getStats()` already exports the counts).
- Optional TUI-richer extra (allowed by parity rules): `device categories` listing the 12 categories
  with counts — one query, no MCP counterpart needed.

# Contract / eval impact — and the B-0010 tie-in

- **`V-tool-registry`**: untouched — 14 tools, overlay only.
- **`V-tool-shapes`** (Block C): the `"hAP ax3"` snapshot changes (new `hardware` block,
  `related.devices` gains 2 keys) — one intentional snapshot update, called out in the PR.
- **`V-tool-budget`** (Block B): re-run; expected deltas are small (enrichment ~100 tokens). If the
  `"hAP ax3"` 6,000 budget trips, trim `also_known_as` cap before touching the budget line.
- **New anchor tests** (the real regression floor for this feature):
  - alias hits: `RB750Gr3` → hEX (matrix.csv source), `cap_ac` → cAP ac (hardware-link source),
    `C53UiG+5HPaxD2HPaxD` → hAP ax³ (declared code);
  - catalog fallback: `GPeR` → accessory-labeled thin row; a discontinued SKU → `kind: "discontinued"`;
  - pollution guard: `qm_x` (mounting bracket, dropped-www cross-sell alias) must NOT resolve to
    `sxtsq-5-ax` (the #48 cleanup);
  - `category` filter returns only that category; classifier probe resolves a non-regex name
    (e.g. "chateau lte12").
- **Golden retrieval eval** (`src/eval/retrieval.ts`, Phase 0): add 3–5 device-identity golden queries
  now, so whatever B-0010 phase gets picked up next inherits device coverage instead of grafting it on.
- **Sequencing vs B-0010 (eval phases 3+):** do Phase 2 surfacing **first**. Phase 3/4 (LLM judges)
  score page-retrieval relevance and are near-orthogonal to device lookup; **Phase 5 (differential
  testing across DB builds) is the one this work makes valuable** — a device-lookup differential run
  (golden device queries against previous-release DB vs HEAD) is exactly the harness that would catch
  alias-resolution drift when the catalog ETL re-runs against a changed mikrotik.com. If B-0010 starts
  before Phase 2 lands, its harness design should include the device query set from day one; either
  order works, but the device golden queries should exist before Phase 5 freezes its query corpus.
- Tool descriptions (`mcp-tool-descriptions`): `routeros_device_lookup`'s "144 products (March 2026)"
  is already stale (matrix is 156) — refresh counts and describe the two-layer behavior ("matrix
  devices return full specs; accessories/legacy/series entries return labeled thin results") and the
  alias behavior ("product codes, www slugs, and old names resolve to the canonical device").
  Description-only edits need no changelog, but the arg addition does.

# Prerequisites cleared before Phase 2

B-0017 carried two cleanup items that Phase 2 can now treat as done — **#48 merged 2026-07-12** (`main` @ 1c9ed20):

1. **`hardware-link` alias pollution** (B-0017 "lingering items"): before #48, 27 of 30 drop-ledger
   www-product codes still existed as `hardware-link` aliases pointing at the device whose page merely
   linked them (`qm_x` → sxtsq-5-ax, `mant_lte_5o` → hw-chateau-lte12, …). #48 filters those aliases at
   ETL time when the token names a drop-ledger www product, while keeping standalone series-page aliases
   exempt because they legitimately claim member/kit codes. Read-time source-ranking stays as a
   tie-breaker concept only — with a PK-unique table there is nothing to rank at read time, so fix the
   data, not the reader.
2. **`_non_default_ips` over-inclusion**: before #48, 63 rows carried it; only ~11 are genuine subnet
   deviations (`192.168.188.1` embedded-LTE cluster + intercell + woobm-usb). #48 filters at extract time
   per B-0017's classification, so same-subnet `.88.x` secondaries are not deviations and Phase 2 can trust
   the field; the `hardware.non_default_ip` output emits only when present post-filter.

Both are extractor changes with baseline moves (`catalog.json` diff is the review gate) that should land
before the surfacing work starts, so Phase 2 reads clean data instead of re-deriving these classifications.

# Proposed build-issue split (the 1–2 issues #39 must spawn)

**Issue A → spawned as [#49](https://github.com/tikoci/rosetta/issues/49) (`agent-ready`, 2026-07-12).** "Alias-aware device lookup + catalog enrichment (MCP + TUI)":
depends on the clean catalog from #48; `searchDevices()` stage 1.5 + stage 5 + `hardware` enrichment
block + thin-row `kind` labeling; classifier pattern additions + whole-input alias probe in `searchAll()`;
`related.devices` +category/+discontinued; TUI card/stats updates; contract snapshot + budget
re-baseline; anchor tests + device golden queries; tool-description refresh; changelog.
Acceptance: the anchor-test list above green; `V-tool-registry` diff empty; parity test green;
`"hAP ax3"` within budget.

**Issue B → spawned as [#50](https://github.com/tikoci/rosetta/issues/50) (2026-07-12, sequenced after A).** "`category` filter arg + category navigation" — smaller, separable (it's the only
schema-key change): `category` arg on `routeros_device_lookup` (validated against the 12 values, hint
on miss), dot-command passthrough, `device categories` TUI listing, `next_steps` hints from
single-device responses, changelog. Sequenced after A (A defines the thin-row shape that category
enumeration returns). Could fold into A if the maintainer prefers one PR — flagged as a scoping call.

Out of scope for both (already deferred above): `specs_json` passthrough, `/hardware` prose ingest,
`&`-compound SELECT side (B-0006), the 30 dropped www products as rows, Track B capability surfacing.

# Maintainer feedback (2026-07-12) — folded into the build issues

Reviewed on #39. The steering shifts the emphasis of Phase 2 **away from surfacing the `/hardware`
page and toward using the overlay to resolve the right device(s) from free-form input** — the alias/
fuzzy path is the priority, the page URL is a low-value byproduct. Concrete changes to the design above:

1. **Product-page URL beats the `/hardware` URL for humans.** `/hardware` pages are often boilerplate
   ("Accessing RouterOS", regulatory/safety) and thin; the mikrotik.com **product page** usually has
   more real detail. So the enrichment block surfaces `product_page_url` — reconstructed as
   `https://mikrotik.com/product/<sourceWwwCode>` (grounded: `assess-www.ts` fetches exactly that path,
   so any attached www code is a valid URL segment; 209/255 rows have one) — preferred over
   `hardware_page_url` (`manual.mikrotik.com/hardware/<sourceHardwareSlug>`, 242/255). Neither is the
   point, though — see #2. Where only one exists, surface that one; where neither, omit. **No ETL change
   needed** — both derive from columns already in `hardware_catalog`.
2. **Steer to the device tool, not to URL-fetching.** rosetta exists to spare agents from fetching and
   re-tokenizing pages. So URLs surface but are explicitly framed as *provenance/human links*, and the
   `note` + `next_steps` nudge the agent to call `routeros_device_lookup rosetta_device_id=…` for more
   specs rather than fetching either URL. The enrichment must carry enough (category, discontinued, AKA,
   the resolved id) that a follow-up tool call — not a page fetch — is the natural next step.
3. **Optional per-device detail level on `routeros_search`** (`device_detail: "brief" | "full"`, brief =
   today's enrichment). Motivation: let an agent get fuller device data inline and skip a second
   `routeros_device_lookup` round-trip. Kept **out of Issue A's core** to keep A shippable and budget-safe;
   recorded as a scoped follow-up (Issue A "possible extension" + BACKLOG) so it isn't lost.
4. **Doc → device cross-referencing** (routeros_get_page gains a "references devices" / "references
   pivots-like-switch-chips" block; main-doc prose becomes a *test corpus* for how well the alias/fuzzy
   path surfaces devices from free-form text, and a way to scope how often devices are mentioned in main
   docs). This is **research, not Phase 2** — routed to `briefings/B-0007-special-hardware-pages.md`
   (Track B, "free-form text → device" is already its remit) + a BACKLOG line. It also validates the
   priority in the opening paragraph: free-form resolution quality is the real deliverable.

# Resolved decisions (was: open for the maintainer)

1. **Enrichment block placement** → `hardware: {…}` sub-object on `DeviceResult` (matrix shape untouched,
   snapshots readable). Confirmed.
2. **Issue A+B split** → two issues, A first. Confirmed.
3. **`mode: "alias"` as a distinct search mode** → yes (free eval observability). Confirmed.
4. **Series-row exemption in the drop-ledger alias filter** → confirmed correct in merged #48: the
   `page.slug.endsWith("-series")` exemption fires only in the standalone-row loop (the matrix loop always
   passes `ownerIsSeries=false`), and invariant #8 re-derives it tightly as
   `rosettaDeviceId.startsWith("hw-") && sourceHardwareSlug endsWith "-series"`. So `ldf_5_ac`→ldf-5
   correctly filters while `hw-wap-60g-series` stays exempt.
