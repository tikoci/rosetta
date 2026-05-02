---
id: T-0023-video-quality-signals
title: Video metadata quality signals
status: ready
priority: low
area: extraction
depends_on: []
conflicts_with: []
validation: []
acceptance:
  - "videos table stores transcript_source ('auto' | 'author' | 'none')"
  - "Existing upload_date and view_count exposed in routeros_search related.videos"
  - "Treat videos as locators, not authoritative sources — surface excerpts only when transcript_source supports it"
  - "Schema migration applied via SCHEMA_VERSION bump"
trigger: ""
created: 2026-05-02
---

# Body

Videos are useful as discovery anchors but auto-generated YouTube transcripts vary wildly in quality. Storing `transcript_source` lets the MCP layer surface authored transcripts confidently and demote auto-transcripts to "watch the video" hints.
