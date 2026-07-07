---
id: T-0034-rosetta-id-scheme-spike
title: Spike — validate rosetta-id slug scheme end-to-end against a real /docs sample
status: done
priority: high
area: extraction
depends_on: []
conflicts_with: []
validation: []
acceptance:
  - "Slug-derivation function (URL path -> rosetta_id) implemented in real code (not a one-off scratch script) and run against the full current sitemap.xml (~1,322 URLs across /docs, /hardware, /changelog, /blog) with collisions checked and reported — B-0012 already found zero collisions via a scratch probe on 2026-07-07; this task re-derives that fact from committed code so it stops depending on a throwaway script"
  - "Slug-derivation function parses-and-discards an optional leading /docs/next/ or /docs/<semver>/ version-prefix segment rather than assuming it can never appear (see B-0012 H7 'Hypothetical versioning corner') — no real version logic needed, just don't let it break the parse if MikroTik adds versioning later"
  - "A small prototype extractor (behind a flag, or a clearly-labeled experimental entrypoint — not wired into the default extract pipeline) fetches and parses ~15-20 representative /docs pages spanning: a short simple page, a property-heavy page (dhcp.md-style), a page hitting the malformed-emphasis pattern from B-0012 H4 (e.g. check-gateway on dhcp.md), a page with nested admonitions, and one very long page"
  - "Prototype stores rosetta_id in a new TEXT UNIQUE column on a scratch/parallel table (not a migration of the real pages/commands/schema_nodes tables) — validates the Option-2 shape from B-0012's H7 section: existing INTEGER PRIMARY KEYs and FKs stay untouched"
  - "Relative Markdown links inside property descriptions (../user-guides/...md, ./dhcp.md#anchor — see H4) are resolved against the prototype's rosetta_id scheme at least once, end to end, so the mechanics are proven, not just argued"
  - "Decision recorded back in B-0012's H7 section: either confirms Option 2 as the path forward for the real extractor, or surfaces a concrete reason to reconsider — H7 does not stay open a second time after this task closes"
  - "No changes to the production schema (pages, commands, schema_nodes, properties) — this is a spike; the real migration is T-0035 and beyond"
trigger: ""
created: 2026-07-07
---

# Body

This is the first of two staged tasks following the 2026-07-07 T-0033 homework pass (see
`briefings/B-0012-docusaurus-manual-migration.md`, "Next steps" section). The goal is narrow:
stop treating the rosetta-id scheme (H7) as an abstract choice and prove the mechanics with a
small amount of real, throwaway-tolerant code before either committing to it in the real
extractor (T-0035) or reopening the decision.

Context already established in B-0012 — read H4, H7, and H8 before starting:

- `pages.id` is `INTEGER PRIMARY KEY` today (Confluence IDs); every FK pointing at it
  (`properties.page_id`, `commands.page_id`, `schema_nodes.page_id`, `pages.parent_id`) is
  `INTEGER`. Changing `pages.id` itself to a TEXT slug (H7 "Option 1") ripples through all of
  those. Adding a separate `rosetta_id TEXT UNIQUE` column (H7 "Option 2") does not — that's why
  this spike builds against Option 2's shape specifically: it's reversible (Option 1 can still
  happen later if this spike or T-0035 finds a reason to prefer it) without having disrupted
  anything if we decide against it.
- The user declined to lock H7 in the abstract on 2026-07-07 ("not ready to decide... leave both
  options recorded") — this task exists to make the decision concrete instead of re-asking the
  same abstract question.
- A same-day scratch probe already found **zero slug collisions** across the full live sitemap
  (1,322 URLs, case-insensitive, trailing-slash-normalized, no unexpected characters, max length
  97) — this task's first acceptance bullet re-derives that fact in committed code so the finding
  survives past the scratch directory, and so it's re-checked against sitemap drift over time,
  not treated as a one-time fact.
- H4 found the main property-parsing risk is malformed Markdown emphasis (`**check-gateway**
  *(none \| arp \| bfd \| ping***;** Default: **none)**` on `dhcp.md`) — worth hitting in the
  prototype's sample set so this spike also partially retires that residual H4 unknown, not just
  H7.

Out of scope: CLI Reference, `/hardware`, and any MCP/TUI surface changes. This is `/docs` prose
only, and only enough of it to prove the identity mechanics — not a production extractor. Keep
the prototype small; if it grows into "most of the real extractor," that's a signal to fold it
into T-0035 rather than gold-plating the spike.

**Broadened context (2026-07-07, folded in before starting code):** B-0012's H7 section now also
carries a full ID/URL audit across the whole MCP surface (`commands`/`schema_nodes` use `path` as
their natural key, `videos` uses `video_id`, `devices` uses `product_url`, `dude_pages` already
uses `slug` as its exposed identifier), the Confluence numeric-ID/redirect precedent, and
speculative research on how Docusaurus versioning would reshape URLs if MikroTik ever adds it.
Read H7 in full before writing the slug-derivation function — it's what motivates the
version-prefix-tolerant parsing acceptance bullet above, and it's why Option 2 (separate
`rosetta_id` column) is now the stronger lean: it already matches how `videos`/`dude_pages` work,
not just a schema-ripple-avoidance argument. This task does not need to design a cross-entity
remapping scheme — just don't paint the `/docs` slug scheme into a corner that would make one
harder later.

## 2026-07-07 progress — all six acceptance bullets done, task closed

Bullets 1–2: `src/spike-docusaurus-rosetta-id.ts` (+ `.test.ts`) implements `deriveRosettaId()`
and `checkCollisions()`. Collision check re-run from committed code against both the earlier
scratch-probe sitemap and a fresh live fetch of `manual.mikrotik.com/sitemap.xml` — both agree:
1,322 URLs, 1,322 unique rosetta-ids, 0 collisions, max length 97, no unexpected characters, no
drift since the morning probe.

Bullets 3–5: `src/spike-docusaurus-docs-prototype.ts` fetches and parses 20 real `/docs` pages
(the required ~15-20, spanning short/simple, property-heavy, the known malformed-emphasis case,
admonition-heavy, and a general category spread) into a throwaway scratch SQLite DB (`spike_pages`
with `rosetta_id TEXT UNIQUE`, plus `spike_properties`/`spike_admonitions`/`spike_links`) — the
production schema was never touched. Results: 20/20 pages fetched, 317 properties parsed (9
correctly flagged malformed-emphasis, confirming H4's dhcp.md finding generalizes rather than
being a one-off), 58 admonitions parsed (all single-level `:::type`/`:::` — no nested `::::`
example turned up in this sample; noted, not chased further), 56 relative Markdown links resolved
end-to-end with 0 malformed results.

**A real bug the prototype caught (exactly what "prove, don't argue" is for):** the first version
of `deriveRosettaId()` didn't strip a `.md`/`.mdx` suffix, so a page's own id
(`docs/network-management/dhcp`, from its canonical URL) and a link resolving to that same page's
Markdown-source sibling (`./dhcp.md#dhcp-server` → `docs/network-management/dhcp.md`) minted two
different rosetta-ids for one logical page. Fixed in `deriveRosettaId()` (strip trailing
`.md`/`.mdx` before returning), verified by re-running both the collision check (still 0/1,322)
and the prototype (dhcp's self-referencing links now resolve to exactly `dhcp`'s own id). Left
unfixed, T-0035's real extractor would have silently fragmented every internal-link join.

Bullet 6 — **H7 decision, recorded:** **Option 2 confirmed** (separate `rosetta_id TEXT UNIQUE`
column, existing integer PKs/FKs untouched). No reason to reconsider surfaced; the prototype
exercised the real risk areas (malformed markup, relative-link resolution, version-prefix
tolerance) without needing Option 1's FK migration. See B-0012 H7 for the corresponding update.
`T-0035` is unblocked.

Status: `done`.
