---
id: T-0038-docusaurus-retrieval-ranking-regressions
title: Fix two real retrieval-ranking regressions surfaced by the Docusaurus corpus swap
status: blocked
priority: high
area: mcp
depends_on: []
conflicts_with: []
validation:
  - V-retrieval-floor
acceptance:
  - "nl-firewall-filter golden query ('block traffic from a specific IP address') surfaces a real firewall filter/NAT/address-list page in the top-5 `routeros_search` results, not incidental short unrelated pages (today: NVMe over TCP, LoRa General Properties, Scripting, CRS3xx manual, Layer2 misconfiguration outrank the actual Filter page, which lands at rank 6 of 10)"
  - "nl-bgp golden query ('establish a BGP peer with my upstream') surfaces a real BGP page (docs/user-guides/routing-and-networking-protocols/unicast/bgp or a sibling) in the top-5 — today the AND-query candidate pool is only 2 pages (VRF, DHCP), neither of which is BGP-related"
  - "Root cause is diagnosed precisely before picking a fix — candidates identified so far (see body): BM25 document-length bias favoring very short pages, and/or the AND-then-OR-fallback-only-on-zero-hits strategy in searchPages() never triggering OR when AND already returns a small nonzero (but wrong) candidate set. Pick the smallest correct fix, not a blanket rewrite of ranking."
  - "Any change lands in src/query.ts (shared retrieval core per query-core-not-adapter.instructions.md) so both the MCP tool and the TUI benefit, not an MCP-only patch"
  - "fixtures/eval/queries.json's nl-firewall-filter/nl-bgp expected_rosetta_ids reviewed once the fix lands — they were set to the real current-corpus pages during this task's discovery (not the old Confluence ids), so they may already be correctly scoped; confirm rather than assume"
  - "fixtures/eval/baseline.json regenerated (--update-baseline) once these two queries pass, so recall@5/recall@3/MRR climb back toward 100% and the regression-tolerance gate in release.yml reflects the improved reality"
  - "No regression introduced to the other 19 already-passing golden queries in the same fixture"
trigger: "Review pass by the user or another agent confirming priority and root-cause diagnosis — see 'Status note' below."
created: 2026-07-09
---

# Body

## Status note (PR #17, 2026-07-08)

Flagged during PR #17 review: `status: ready` read as "fully resolved, pick this up now,"
which overstated things. The root-cause diagnosis below was reached by a single coding
agent during triage, not yet reviewed by the user or another agent, and its priority
hasn't been weighed against the broader CI/QA testing-regime review `B-0014` is tracking.
Downgraded to `status: blocked` pending that review pass — not because the diagnosis is
believed wrong, just not yet confirmed as truly next-up. No change to the acceptance
criteria or repro below; re-promote to `ready` once reviewed.

Discovered while diagnosing the `release.yml` "MCP retrieval eval (Phase 0)" CI failure on run
[28990846508](https://github.com/tikoci/rosetta/actions/runs/28990846508/job/86030039482), which
was the first *real*, non-latent build failure caused by the Docusaurus migration (`T-0035`/
`T-0036`) — everything before it was either a deliberately staged rollout or an unrelated coverage-
threshold bug (see `T-0037`'s 2026-07-09 progress note). That CI failure's own root cause — the
golden-query fixture pinning stale Confluence-era numeric page ids, which `extract-docusaurus.ts`
intentionally no longer preserves (`pages.id` is a fresh rowid every run; stable identity is
`pages.rosetta_id`) — is fixed by the PR this task file ships alongside. This task is the second,
narrower thing that same investigation turned up: **two of the twelve `nl-question` golden queries
are not just mis-pinned, they are genuinely finding the wrong page** even once matched against the
correct current-corpus identity.

## Repro

Build a live Docusaurus-sourced DB the same way `release.yml` does (network fetch, no shortcuts):

```sh
DB_PATH=/tmp/ros-help-docusaurus-test.db bun run src/extract-docusaurus.ts --check-counts --strict
DB_PATH=/tmp/ros-help-docusaurus-test.db bun run src/extract-commands.ts
# devices/changelogs/dude/link-commands not required to reproduce these two specific queries,
# but extract-commands.ts is, since command-tree presence isn't the issue here — just ranking.
```

Then, from a one-off script importing `searchAll` from `src/query.ts` with that `DB_PATH`:

- `searchAll("block traffic from a specific IP address", 10)` returns (in order): NVMe over TCP
  (`docs/storage/nvme-over-tcp`), LoRa General Properties, Scripting, CRS3xx/CSS3xx Series Manual,
  Layer2 misconfiguration, **then** Filter (`docs/firewall-and-quality-of-service/firewall/filter`)
  at rank 6, Packet Flow in RouterOS, HotSpot, Services, WebFig. `fallback_mode` is `null` (the
  AND query itself returned all 10 — this is a ranking-order problem, not a candidate-pool
  problem).
- `searchAll("establish a BGP peer with my upstream", 10)` returns only **2** total candidates:
  VRF (`docs/user-guides/routing-and-networking-protocols/vrf`) and DHCP
  (`docs/network-management/dhcp`). `fallback_mode` is `null` here too — the AND query
  (`"establish" AND "bgp" AND "peer" AND "upstream"`, none of the four being a `COMPOUND_TERMS`
  pair or a stop word) found a small nonzero set, so `searchPages()`'s "OR only if AND returns
  zero" fallback (`src/query.ts`, `searchPages()`) never fires — meaning the actual BGP pages
  (`docs/user-guides/routing-and-networking-protocols/unicast/bgp` and its `understanding-bgp`/
  `peering-sessions`/`faq`/`nexthop-selection` siblings) never even enter the candidate pool,
  presumably because their prose doesn't literally contain all four query words (e.g. maybe
  "neighbor" instead of "peer", no literal "establish" or "upstream").

## Two candidate root causes (not yet confirmed which, or whether both apply)

1. **BM25 document-length bias.** Docusaurus pages vary far more in length/density than the old
   Confluence corpus (a short property-table-only page vs. a long prose guide). BM25's length
   normalization can let a very short page's incidental single-term match outscore a longer,
   genuinely relevant page whose per-term frequency is diluted by its own larger size. The
   firewall-filter case fits this shape: the correct page exists in the candidate set (rank 6),
   it's just outranked, not absent.
2. **AND-then-OR-fallback-only-on-zero-hits is too strict.** `searchPages()` only falls back from
   AND to OR when AND returns *exactly* zero results. If AND finds a small nonzero set of
   unrelated pages (incidental literal-word matches), the real answer never gets a chance even
   though an OR query might have ranked it highly. The BGP case fits this shape: the candidate
   pool itself is wrong (2 pages, neither BGP), not just misranked.

Whoever picks this up should confirm which mechanism (or both) is actually responsible — e.g. by
checking `bm25()` weights per column, or by manually running the OR-mode query for "establish bgp
peer upstream" against the live DB and seeing whether it would have surfaced a real BGP page — before
choosing a fix. A plausible, bounded first fix for (2): fall back to OR whenever AND returns fewer
than some small threshold (not just zero), re-ranking/merging rather than fully replacing the AND
results. For (1): confirm whether `runFtsQuery()` already applies per-column bm25 weights (see
`src/query.ts` around the FTS query execution) and consider whether page length should factor into
a manual re-rank rather than raw BM25.

## Why this is split from the CI-fix PR

The CI-fix PR only needed to correct *stale identity* in the golden set (a fixture bug — the
search was already finding the right page for 10 of 12 queries once matched correctly). Fixing
these two is a behavior change to `src/query.ts`, the shared retrieval core behind both the MCP
`routeros_search` tool and the TUI's `s` command (`query-core-not-adapter.instructions.md`) — wider
blast radius, needs its own focused review, and shouldn't block unblocking `T-0037`'s release
dispatch. Per the user's explicit instruction during triage: don't skip or water down the failing
test to reach green — the CI-fix PR intentionally leaves these two queries' `expected_rosetta_ids`
pointed at the *correct* modern pages (not loosened to accept the wrong ones), so they keep failing
loudly and visibly in every `MCP retrieval eval (Phase 0)` run's per-query "issues" list until this
task lands, even though the aggregate thresholds still clear (~90% recall@5, comfortably above the
85% gate) with only these two known misses.

## Related

- `briefings/B-0012-docusaurus-manual-migration.md` — the migration whose corpus-shape change
  surfaced this.
- `briefings/B-0014-ci-testing-qa-cleanup.md` — the CI-testing-gap review that this whole
  investigation traces back to.
- `tasks/T-0037-npm-prerelease-dist-tag-channel.md` — the task whose live dispatch actually hit
  this failure in CI.
