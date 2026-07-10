---
id: B-0007-special-hardware-pages
topic: Extracting device-specific tables from special hardware pages
status: open
related_tasks: []
created: 2026-05-02
last_revisited: 2026-05-02
---

> **2026-07-10:** superseded in scope by `briefings/B-0017-hardware-overlay-device-resolution.md`
> (issue [#34](https://github.com/tikoci/rosetta/issues/34)), which asks whether
> `manual.mikrotik.com/hardware`'s per-device pages supersede these Confluence-era pages or are a
> genuinely separate concern (open question there, not yet resolved). This briefing stays `open`
> as historical record until B-0017's research pass concludes.

# Question

Several hardware-specific HTML pages (Switch Chip Features, Marvell Prestera, Bridging and Switching, Peripherals) contain device-specific tables that aren't surfaced in `properties` or `devices`. Worth extracting?

# What's grounding this

- The pages exist in the Confluence export.
- Tables are device-keyed (rows per chip / port profile), unlike `confluenceTable` "Property | Description" pairs.
- `extract-properties.ts` is property-shaped only.

# Trigger to act

Watch for user-visible misses: agents asking "what switch chip is in CCR-X?" returning nothing useful from existing tools. If those misses become a pattern, it's worth a dedicated extractor.

# Open questions

- Would a generic "page tables" extractor (one row per `<table>` in pages, structured) cover this and other future cases more cheaply than per-page extractors?
