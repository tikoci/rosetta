DB         := ros-help.db
HTML_DIR   := box/latest/ROS
VERSION    ?=
.PHONY: extract extract-full extract-legacy-confluence extract-html extract-properties extract-commands \
        extract-docusaurus extract-docusaurus-from-cache extract-docusaurus-check-counts \
        extract-schema extract-all-versions extract-devices extract-test-results extract-changelogs \
        extract-changelogs-extended \
        extract-videos extract-videos-from-cache save-videos-cache \
        extract-dude extract-dude-from-cache \
        extract-skills extract-skills-from-cache \
        link gc-versions assess assess-hardware search browse serve \
	typecheck lint test preflight verify \
        install setup clean eval eval-update eval-self eval-self-update

# ── Development ──

install:
	bun install

serve:
	bun run src/mcp.ts

search:
	bun run src/search.ts $(query)

browse:
	bun run src/mcp.ts browse $(query)

assess:
	bun run src/assess-html.ts

assess-hardware:
	bun run src/assess-hardware.ts

# ── Quality ──

typecheck:
	bun run typecheck

test:
	bun test

lint:
	bun run lint

preflight:
	@echo "── Preflight checks ──"
	@git diff --quiet --exit-code || (echo "✗ Working tree has uncommitted changes" && exit 1)
	@git diff --quiet --cached --exit-code || (echo "✗ Index has staged changes" && exit 1)
	@echo "✓ Clean working tree"
	@test -f $(DB) || (echo "✗ Database $(DB) not found" && exit 1)
	@sqlite3 $(DB) "SELECT COUNT(*) FROM pages" > /dev/null 2>&1 || (echo "✗ Database has no page data" && exit 1)
	@echo "✓ Database exists"
	@$(MAKE) --no-print-directory typecheck
	@echo "✓ Typecheck passed"
	@$(MAKE) --no-print-directory test
	@echo "✓ Tests passed"
	@$(MAKE) --no-print-directory lint
	@echo "✓ Lint passed"
	@echo "── Preflight OK ──"

verify:
	@echo "── Verify ──"
	@test -f $(DB) || (echo "✗ Database $(DB) not found — run 'make extract' first" && exit 1)
	@echo "✓ Database exists"
	@$(MAKE) --no-print-directory typecheck
	@echo "✓ Typecheck passed"
	@$(MAKE) --no-print-directory lint
	@echo "✓ Lint passed"
	@$(MAKE) --no-print-directory test
	@echo "✓ Tests passed"
	bun test src/mcp-contract.test.ts
	@echo "✓ MCP contract tests passed"
	bun run src/eval/retrieval.ts
	@echo "✓ Retrieval eval passed"
	@echo "── Verify OK ──"

# ── Extraction pipeline ──
#
# extract-docusaurus (Markdown, manual.mikrotik.com) is the current prose source —
# see DESIGN.md and briefings/B-0012-docusaurus-manual-migration.md. extract-html
# (Confluence HTML) is kept only for rebuilding historical pre-migration release
# DBs via `make extract-legacy-confluence`; it is not part of the default pipeline.

extract: extract-docusaurus extract-commands extract-devices extract-test-results extract-changelogs extract-dude-from-cache extract-skills link

extract-full: extract-docusaurus extract-all-versions extract-devices extract-test-results extract-changelogs extract-dude-from-cache extract-skills link

# Live fetch from manual.mikrotik.com's sitemap.xml, caching each page's raw
# Markdown to manual/pages/ (gitignored — not the full-corpus fixture set).
extract-docusaurus:
	bun run src/extract-docusaurus.ts

# Re-extract from a previously-populated manual/pages/ cache — no network dependency.
extract-docusaurus-from-cache:
	bun run src/extract-docusaurus.ts --from-cache

# Compare extracted page count against llms.txt (B-0012 H8, V-docusaurus-docs-count).
# Non-blocking by design — prints a MATCH/MISMATCH line, does not fail the build.
extract-docusaurus-check-counts:
	bun run src/extract-docusaurus.ts --from-cache --check-counts

# Historical-rebuild path only (March 2026 Confluence export) — not run by
# `extract`/`extract-full`. See DESIGN.md "Legacy Confluence HTML archive".
extract-legacy-confluence: extract-html extract-properties

extract-html:
	bun run src/extract-html.ts

extract-properties:
	bun run src/extract-properties.ts

extract-commands:
	bun run src/extract-commands.ts

# Import from deep-inspect files (multi-arch, completion data).
# Requires --x86= and/or --arm64= flags.
# Example: make extract-schema X86=path/to/deep-inspect.x86.json ARM64=path/to/deep-inspect.arm64.json
extract-schema:
	bun run src/extract-schema.ts $(if $(X86),--x86=$(X86)) $(if $(ARM64),--arm64=$(ARM64)) $(EXTRA_FLAGS)

extract-all-versions:
	bun run src/extract-all-versions.ts

extract-devices:
	bun run src/extract-devices.ts

extract-test-results:
	bun run src/extract-test-results.ts

extract-changelogs:
	bun run src/extract-changelogs.ts

# Extract changelogs for all available RouterOS v7 versions (7.1.1 back through current).
# Discovers patch versions automatically using --probe-patches.
extract-changelogs-extended:
	bun run src/extract-changelogs.ts --probe-patches

extract-videos:
	bun run src/extract-videos.ts

# Import cached transcripts (committed NDJSON in transcripts/) into DB — no yt-dlp needed.
# Use in CI: fast, reproducible, no network dependency on YouTube.
extract-videos-from-cache:
	bun run src/extract-videos.ts --from-cache

# Export current DB content to transcripts/YYYY-MM-DD/videos.ndjson.
# Run locally after extract-videos, then commit the transcripts/ directory.
save-videos-cache:
	bun run src/extract-videos.ts --save-cache

# Fetch The Dude wiki docs from Wayback Machine (one-time, caches to dude/pages/).
extract-dude:
	bun run src/extract-dude.ts

# Re-extract from cached HTML in dude/pages/ — no network dependency.
extract-dude-from-cache:
	bun run src/extract-dude.ts --from-cache --skip-images

# Fetch agent skill guides from tikoci/routeros-skills GitHub repo.
extract-skills:
	bun run src/extract-skills.ts

# Re-extract from cached skills/ directory — no network dependency for local/offline rebuilds.
extract-skills-from-cache:
	bun run src/extract-skills.ts --from-cache

link:
	bun run src/link-commands.ts

gc-versions:
	bun run src/gc-versions.ts $(EXTRA_FLAGS)

setup:
	bun install
	bun run src/setup.ts

clean:
	rm -f $(DB) $(DB)-shm $(DB)-wal
	rm -rf dist/

# ── MCP eval (see BACKLOG: "MCP Behavioral Testing") ──

# Phase 0: hand-curated golden-query retrieval eval
eval:
	bun run src/eval/retrieval.ts

eval-update:
	bun run src/eval/retrieval.ts --update-baseline

# Phase 1: self-supervised retrieval eval (auto-generated from DB)
eval-self:
	bun run src/eval/self-supervised.ts

eval-self-update:
	bun run src/eval/self-supervised.ts --update-baseline
