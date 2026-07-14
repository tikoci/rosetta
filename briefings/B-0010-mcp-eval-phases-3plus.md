---
id: B-0010-mcp-eval-phases-3plus
topic: MCP behavioral testing phases 3+ — judges, differential testing, mutation
status: open
related_tasks: []
created: 2026-05-02
last_revisited: 2026-07-14
---

# Status of phases 0–2 (already shipped)

- **Phase 0** — hand-curated golden retrieval eval (`src/eval/retrieval.ts`).
- **Phase 1** — auto-generated self-supervised eval (`src/eval/self-supervised.ts`).
- **Phase 2** — frozen 14-tool registry + workflow-arrow + token-budget + shape-snapshot contract (`src/mcp-contract.test.ts`).

# Open phases

- **Phase 3 — Local-LLM judge.** Ollama-based relevance check on retrieval results. Opt-in only; never CI-default. Useful for catching "right page, wrong section" cases that recall@k misses. Cost: zero (local). Risk: noisy small models, judge bias.

- **Phase 4 — Cheap remote judge.** Claude Haiku or similar, batched, cached, manual trigger. Stronger signal than Phase 3, but real cost. Need cost guardrails (token caps, sample-only mode, weekly cadence).

- **Phase 5 — Differential testing across DB builds.** Run golden queries against previous-release DB and HEAD; report top-3 result diffs per query. Catches "we improved retrieval but regressed exact-match cases" silently.

# Other research directions

- Mutation testing on query variants (synonyms, typos, partial paths) to measure robustness.
- Opt-in TUI/usage logs as a future eval corpus source. Privacy-respecting (`ROSETTA_LOG_USAGE=1`, local-only file).

# Why not now

Phases 0–2 cover the regression floor. Phases 3–5 each need either: a new dependency (Ollama), a cost commitment (remote judge), or a long-term diff infrastructure. Pick one when retrieval bugs slip past the existing eval.

# Trigger

A real retrieval regression that the existing eval failed to catch. Use that incident to choose which phase fits the gap.

## Related tracks (2026-07-14)

Multiple eval-improvement efforts are live in parallel now — worth reading together rather than
duplicating:

- `briefings/B-0020-0.11-retrieval-quality-audit.md` — near-term, already-shipped work: golden-set
  expansion (24→35 queries), self-supervised baseline regeneration against the Docusaurus corpus, and a
  "Bug Ledger" of real ETL/MCP defects the audit surfaced (routed to issues #58–#60). That's Phase 0/1
  work in this briefing's terms, not Phase 3+.
- `~/GitHub/bench-routeros-tools` — external benchmark of RouterOS agent-support strategies (MCPs,
  skills, retrieval); grounds rosetta's value proposition from outside its own eval harness. See
  `DESIGN.md` → "External benchmark feedback loop."

Neither replaces this briefing's Phase 3–5 scope (local/remote LLM judges, differential testing across DB
builds, mutation testing) — they're the floor those phases build on top of. Revisit this briefing's
"Trigger" once B-0020-style audits or the external benchmark surface a regression the existing eval
missed.