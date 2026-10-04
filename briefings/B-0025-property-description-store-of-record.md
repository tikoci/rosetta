---
id: B-0025-property-description-store-of-record
topic: Which store answers "what does argument X at menu Y mean" now that MikroTik is moving property tables into the CLI Reference
status: open
related_tasks: ["#169", "#170", "#58", "#61", "#100", "#25", "B-0001", "B-0011", "B-0013", "B-0015", "B-0016", "B-0024"]
created: 2026-10-04
last_revisited: 2026-10-04
---

# Question

Rosetta was designed around one premise: the only source of **descriptions** of RouterOS
properties is the manual's prose. inspect and the CLI-Reference overlay supply structure, and the
prose supplies meaning. Rosetta surfaces prose about RouterOS to agents and other tikoci tools.
Enforcing the schema belongs elsewhere: `centrs` validates commands, and `lsp-routeros-ts` checks
scripts.

In the 0.11.3 corpus that premise broke. MikroTik moved the property tables for DNS, DHCP, NAT,
users, the scheduler, NTP, `/system/note` and more into `/docs/cli-reference/`. There each field
carries its own description. #170 handled it as a **fallback**: manual first, overlay only when the
manual has nothing better than `low`. Testing on next.114 showed that ordering is not the end
state. So:

1. Which store should answer first, per (menu, field)?
2. What does a blank overlay description mean to an agent?
3. Which backlog decisions rested on the old premise?

# What's grounding this

- **Corpus:** the CI release artifact `v0.11.3-next.114` (schema 11, `source_commit` `6928b29`).
  Regenerate with `DB_PATH=<release db> bun run src/eval/property-sources.ts`.
- **Earlier corpora:** the v0.11.2 DB (prose `properties` 3,411 rows on 100 pages) and next.113
  (2,799 rows on 73 pages). Over the same move, CLI-Reference fields with a non-empty description
  went from 3,188 to 4,217.
- **Agent-facing results:** two independent 30-command / 70-argument sets were run through
  `routeros_explain_command`. One is rosetta's own, now MCP contract Block D. The other belongs to a
  private consumer repo that runs rosetta as an MCP server.

  | | unknown-arg (rosetta set) | unknown-arg (consumer set) |
  |---|---:|---:|
  | 0.11.2 | — | 7 |
  | next.113 | 54 | 49 |
  | next.114 (#170) | 1 | 1 |

## 1. The overlay proves existence; it often has no description

| field_kind | fields | described |
|---|---:|---:|
| Argument (settable) | 6,300 | 2,919 (46.3%) |
| Read-only Argument | 4,533 | 1,298 (28.6%) |

Coverage is very uneven by menu. Among settable fields: `/ipv6` 94%, `/ip` 76%, `/disk` 75%,
`/system` 57%, `/tool` 56%, `/routing` 54%, `/interface` **36%**, `/iot` 10%, `/caps-man` **0%**.
MikroTik's migration is clearly in progress. The menus it has finished are the ones whose manual
tables disappeared.

## 2. Who answers today (after #170)

There are 5,519 settable (menu, field) pairs with an exact overlay row (Directory and Settings
Directory entries). The top `lookupProperty` row for each:

| top row | overlay row described | overlay row blank |
|---|---:|---:|
| cli-reference / high | 2,401 | **1,288** |
| manual / high | 69 | 942 |
| manual / medium | **101** | 718 |

Two problems are inside this table.

- **Wrong-menu manual answers beat an exact overlay row.** These come from the 101 + 718
  `manual / medium` rows. Examples: `/ip/firewall/filter chain` → "Bridge firewall chain"
  (Bridging and Switching), with the action list missing `reject` and `fasttrack-connection`.
  `/ip/firewall/mangle` → the same bridge rows, `/file type` → Certificates. Not every medium row is
  wrong. A 25-row random sample of the 819 had about 2 clearly wrong-menu answers, and most were the
  right page, for example the Wi-Fi page for `/interface/wifi/*`. On the 30-command sets this class
  is 2/70 (rosetta set) and 6/70 (consumer set). Block D cannot see it, because a wrong-menu
  answer is not `unknown-arg`.
- **Blank overlay answers are counted as "documented."** There are 1,288 of them. Examples are
  `/ip/address address`, `/ip/route gateway`, `dst-address` and `distance`, which are 4/70 on
  rosetta's set. The manual never had a table for these either. The overlay row is still the
  better answer: it gives the exact menu, the settable kind and the type
  (`composite { address: ipAddr , netmask: … }`). But `explain_command` reports the argument as
  annotated, with an empty description, and Block D counts it as clean.

## 3. Dotted Wi-Fi names (#61 BL-3)

inspect names nested attributes `channel.band`. The overlay models them as a sub-entry:
`interface/wifi/channel` → `band`. Mapping `<menu>/<prefix>` → `<suffix>` resolves 112 of the
539 dotted settable inspect args. But `interface/wifi/channel band` and `width` have **blank**
descriptions, so on today's corpus the mapping buys existence, not meaning.
`configuration.manager` is not in the overlay at all.

# Options considered

| | Rule | Answers changed (of 5,519) | Effect |
|---|---|---:|---|
| **A** | Status quo (#170): manual first, overlay when manual ≤ `low` | 0 | Firewall filter/mangle stay wrong; blank overlay counted as documented |
| **B** | A *described* exact overlay row beats a manual row below `high` | 101 | Fixes the firewall class. Never trades a description for a blank. A few right-page manual answers (Apps) swap for the equivalent overlay text |
| **C** | Any exact overlay row beats a manual row below `high` (consumer's suggestion) | 819 | Fixes the firewall class but replaces 718 manual descriptions, mostly Wi-Fi, with **blanks** |
| **D** | Compose one answer per (menu, field): existence, kind and type from the overlay. Description from the overlay when present, otherwise the best manual row, with that row's own source and tier stated | all 5,519 | Most faithful to the layering in `DESIGN.md` (overlay = element layer, prose = human layer). Bigger shape change, and it reopens B-0011's question of what `lookup_property` is for |

Orthogonal to A–D is how to treat a blank overlay match in `explain_command`. It could count as
documented (today), or get its own signal: "exists at this menu, no description". That is #61's
"known, undocumented" idea. Either way, a second release-check number belongs beside Block D's
`unknown-arg` count. That number would cover blank-description matches and/or manual-below-`high`
answers where a described exact overlay row exists.

# What this changes in the backlog

- **#58** (command→page→property links broken on core menus). Its headline examples dissolve under
  B, C or D without fixing `commands.page_id`. `/ip/firewall/filter action` is answered by the exact
  overlay row. What is left is the `manual / high` and `manual / medium` population on menus the
  overlay describes poorly (`/interface`, `/caps-man`).
- **#61** (prose ↔ schema alignment). The "known, undocumented" outcome now has a concrete
  population: the 1,288 blank overlay matches. The dotted-name half is partly a mapping rule
  (112/539), but it yields blanks today.
- **#100** (27 property-headed tables the parser skips). Its value shrinks if those tables follow
  the same migration. It is worth re-measuring which of the 27 still exist before doing parser work.
- **B-0001 / B-0011** (retire `routeros_lookup_property`). Retirement was conditional on fixing the
  command↔prose join (B-0024). For the menus the overlay covers, the overlay *is* the join: it has an
  exact path. So the precondition may no longer be the gate.
- **B-0024** (the command↔prose join). Its premise, that no structure store carries descriptions, is
  now partly false. Step 6's "what is the missing row" question has a new answer for the migrated menus.
- **#25** (quasi-provenance for overlay rows). It is labelled `blocked`, but overlay rows are already
  user-visible as `source: "cli-reference"` with no version note.
- **B-0013 / B-0015 and the centrs boundary.** Option D returns overlay types and enum lists
  (`raw_type`) as part of a documentation answer. That is documentation of a type, not enforcement.
  Validation stays with `centrs`, and the BACKLOG trigger still holds: no rosetta-local alias scheme
  for overlay paths before centrs settles canonicalization.

# Decisions (maintainer, 2026-10-04)

1. **Ship option B in the next `-next`.** A described exact overlay row outranks a manual row below
   `high`. A blank overlay row never displaces a manual description.
2. **A blank overlay match gets its own signal.** `explain_command` keeps the annotation (exact
   menu, type) and adds a `no-description` warning. This is #61's "known, undocumented", made
   concrete. It was first named `undocumented-arg`, then renamed because "undocumented" reads as
   "unsupported". The warning states that the argument is listed (it exists) and only MikroTik's
   description is missing. `unknown-arg` says "not found" so the two can't be confused.
3. **The release check tracks three numbers, and two more gate.** MCP contract Block D gates
   `unknown-arg` (≤7), `no-description` (≤6), and manual-below-`high` answers beside an exact
   overlay row (≤1) on the fixed 30-command set. QA also runs this census each release
   (report-only), so the described-% trend per top-level menu is on record in every release's step
   summary.
4. **Overlay types and enum lists are surfaced as documentation.** Describing a type is rosetta's
   job. Validating a command against it stays `centrs`'.

Measured after B on next.114 (`source_commit` `6928b29` corpus, B applied locally):

| top row | overlay row described | overlay row blank |
|---|---:|---:|
| cli-reference / high | 2,502 | 1,288 |
| manual / high | 69 | 942 |
| manual / medium | **0** | 718 |

On rosetta's fixed set: `unknown-arg` 1, `no-description` 4, manual-below-`high` 0 (2 before B).
The golden anchor `prop-firewall-filter-action` (#58's pinned failure) flips green without
loosening: its top row is the exact `/ip/firewall/filter` definition at `high`.

# Still open (backlog review)

- **B as the end state, or D as the direction.** D matches the layering in `DESIGN.md` and the
  "rosetta surfaces prose" role, and it would decide B-0011 rather than defer it.
- **The 69 + 942 `manual / high` rows** beside an exact overlay row. Under B these keep the manual
  answer. That is right while `high` means "the section names this menu", but 69 of them have a
  described overlay alternative that nobody has compared.
- **Dotted names.** Map `<menu>/<prefix>` → `<suffix>` for the 112 of 539 dotted args the overlay
  can host, or wait until those overlay rows are described?
- **#58, #61 and #100 dispositions** in light of the table above.
