---
id: B-0009-etl-streamlining
topic: Future ETL pipeline streamlining
status: open
related_tasks: []
created: 2026-05-02
last_revisited: 2026-05-02
---

# Question

How should the extraction pipeline be unified to reduce divergence between local and CI flows, and what should `rosetta --check` look like as a health command?

# What's grounding this

- Current Makefile orchestrates extractors; release.yml duplicates the order with extra steps.
- Idempotency semantics differ across extractors (some drop+recreate, some upsert).
- Cached sources (transcripts, dude pages, skills) follow different patterns.
- Existing `routeros_stats` returns counts but isn't a full health check.

# Possible direction

- Single declarative pipeline definition (`pipeline.yaml`?) consumed by both Makefile and release.yml.
- Convergent idempotency contract: every extractor either drops+recreates its tables or upserts with a documented key.
- `rosetta --check` runs the same minimum-content validation that release.yml does, plus FK integrity, plus sanity counts vs db_meta expected ranges.

# Why not now

This is a refactor that pays off over many extraction cycles. Worth doing only when we add the next major data source (forum archive? package lists?) — that's the moment a unified pipeline saves real work instead of being pure cleanup.
