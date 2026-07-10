---
id: B-0015-explain-static-live-trilogy
topic: Unified "explain" across the tikoci trilogy — rosetta's static analysis data vs centrs/lsp live introspection
status: open
related_tasks:
  - T-0019-completion-data-promotion
  - T-0032-one-shot-cli-query
created: 2026-07-10
last_revisited: 2026-07-10
---

# Body

Absorbs two former tasks closed in the tasks→issues migration
([#18](https://github.com/tikoci/rosetta/issues/18)): `T-0019` (promote
`schema_nodes._attrs.completion` to structured columns) and the meta-theme half of `T-0032`
(one-shot CLI query mode). Both were "right direction, not ready" — each added a useful piece
without answering *who owns what* in the bigger picture.

## Question

An agent working on a RouterOS script/CLI/API/REST question today has to stitch together
tool calls across three projects to get a combined static + live answer. What is the unified
scheme, and which project owns which piece?

## What's grounding this

- **rosetta owns static.** The DB already holds the command tree, paths, args, per-version
  presence, and `_attrs.completion` enums (`{ [value]: { style, preference, desc? } }`) from
  restraml's `deep-inspect.json`. `routeros_explain_command` is the tier-1 read-only bridge
  (`tasks/done/T-0002`).
- **centrs and lsp-routeros-ts own live.** Both get runtime truth from a real router —
  `/console/inspect request=…` and `/parse`. centrs is the tier-3 runner of the
  `explain → validate → run` split (see centrs `docs/MATRIX.md`); lsp-routeros-ts uses
  `/console/inspect` for editor-time results.
- **Static and live genuinely disagree**, so the split matters: bench-routeros-tools surfaced
  that `/console/inspect` accepts forms the runtime rejects (e.g. bare-flag `blackhole=yes`),
  and `DESIGN.md` → "External benchmark feedback loop" records the implications. A future
  `routeros_validate_command` must carry explicit static-vs-runtime provenance
  (`BACKLOG.md` Inbox has the fixture note).
- **Distribution is part of the same question.** `B-0013` frames skills-vs-MCP as a
  distribution tradeoff; `T-0032`'s one-shot CLI (`bunx @tikoci/rosetta search "…" --json`)
  was the bridge so a plain SKILL.md can drive rosetta with zero MCP config. centrs#150
  pilots the hosted-SKILL.md onboarding pattern — it is the designated guinea-pig
  (browserbase.com scheme as the straw man).

## Options considered (early, not settled)

1. **Federated tools, shared contract** — each project keeps its own surface, but
   explain/validate results share a response shape with a `provenance: static|live` field,
   and a skill teaches agents the stitching. Cheapest; stitching stays visible.
2. **rosetta as the front door** — rosetta's explain/validate tools gain an optional live
   backend (delegating to centrs when configured). Single surface for agents; couples
   rosetta to a router connection it deliberately doesn't have today (rosetta is read-only
   documentation/schema context by design).
3. **centrs as the front door** — centrs already validates-before-running and could consume
   rosetta's DB/CLI for the static half. Fits the tier model; makes rosetta a data
   dependency rather than an agent surface for this use case.

## Current lean

Wait for evidence: let centrs#150's onboarding pilot land and let bench-routeros-tools'
matrix work produce comparative data before choosing. Option 1's shared
`provenance` field looks like a no-regrets first step whichever way the front door goes.
Meanwhile, piecemeal static-side improvements (like T-0019's column promotion) should only
happen when something concrete consumes them.

## Open questions

- Who owns `routeros_validate_command` — rosetta (static-only, honest provenance caveat) or
  centrs (live) or both with the shared contract?
- Does the one-shot CLI (`T-0032`) resurface as a rosetta issue on its own merits
  (skill-driven retrieval), independent of the explain question? Watch centrs#150.
- Is `_attrs.completion` promotion (T-0019) actually needed by any consumer yet, or was it
  speculative? Revisit when a validate/explain consumer names the query it can't run today.
- Cross-references: umbrella [#27](https://github.com/tikoci/rosetta/issues/27) (MCP/TUI
  surface alignment) owns the *surface* half; this briefing owns the *ownership/architecture*
  half. Don't let the two drift apart.
