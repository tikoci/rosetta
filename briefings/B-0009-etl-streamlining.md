---
id: B-0009-etl-streamlining
topic: Future ETL pipeline streamlining
status: resolved
related_tasks: []
created: 2026-05-02
last_revisited: 2026-07-14
---

> **2026-07-14 — resolved as: mostly already done.** CI (`release.yml`) already runs the extraction
> pipeline consistently — `extract-videos-from-cache` and `extract-dude-from-cache` import from committed
> caches (NDJSON transcripts, cached Dude scrape) the same way every other extractor runs in CI. The
> "unified `pipeline.yaml` / convergent idempotency contract" direction this briefing proposed isn't the
> real remaining gap. See Decision below for what's actually left.

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

## Decision (2026-07-14)

Close as superseded — see note at top. `Makefile`/`release.yml` already separates "extract from
committed cache" (CI-safe, runs in `release.yml`) from "refresh the cache" (local-only, requires live
`yt-dlp` or a live Dude crawl). Dude staying local-only is fine — it's a frozen wiki archive, not a
moving target. The video-transcript cache refresh is the one piece worth re-examining: unclear whether
`yt-dlp` can run reliably inside GitHub Actions (rate limits, bot detection) to automate
`make save-videos-cache`. Logged in `BACKLOG.md` Inbox as a loose thought rather than a new briefing —
not grounded enough yet to be more than that. A genuinely separate, real streamlining problem this
briefing didn't originally name: separating the DB artifact from code more cleanly in CI — worth its own
briefing if it gains shape, not folded into this one.