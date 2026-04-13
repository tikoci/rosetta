DB         := ros-help.db
HTML_DIR   := box/latest/ROS
VERSION    ?=
FORCE      ?=

.PHONY: extract extract-full extract-html extract-properties extract-commands \
        extract-all-versions extract-devices extract-test-results extract-changelogs \
        extract-videos extract-videos-from-cache save-videos-cache \
        extract-dude extract-dude-from-cache \
        link assess search browse serve \
	typecheck lint test preflight build-release release bump-version \
        install setup clean

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

# ── Extraction pipeline ──

extract: extract-html extract-properties extract-commands extract-devices extract-test-results extract-changelogs link

extract-full: extract-html extract-properties extract-all-versions extract-devices extract-test-results extract-changelogs link

extract-html:
	bun run src/extract-html.ts

extract-properties:
	bun run src/extract-properties.ts

extract-commands:
	bun run src/extract-commands.ts

extract-all-versions:
	bun run src/extract-all-versions.ts

extract-devices:
	bun run src/extract-devices.ts

extract-test-results:
	bun run src/extract-test-results.ts

extract-changelogs:
	bun run src/extract-changelogs.ts

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

link:
	bun run src/link-commands.ts

# ── Release ──
#
# make build-release VERSION=v0.1.0          Build artifacts only (no git, no upload)
# make release VERSION=v0.1.0               Preflight → build → tag → push → create release
# make release VERSION=v0.1.0 FORCE=1       Preflight → build → force-move tag → push → update release

build-release:
	@test -n "$(VERSION)" || (echo "✗ VERSION is required: make build-release VERSION=v0.1.0" && exit 1)
	bun run scripts/build-release.ts $(VERSION)

release: preflight build-release
	@test -n "$(VERSION)" || (echo "✗ VERSION is required: make release VERSION=v0.1.0" && exit 1)
ifdef FORCE
	@echo "── Updating existing release $(VERSION) ──"
	git tag -f $(VERSION)
	git push origin $(VERSION) --force
	gh release upload $(VERSION) dist/*.zip dist/ros-help.db.gz --clobber
	@echo "✓ Release $(VERSION) updated"
else
	@echo "── Creating release $(VERSION) ──"
	@git tag $(VERSION) 2>/dev/null || (echo "✗ Tag $(VERSION) already exists. Use FORCE=1 to update." && exit 1)
	git push origin $(VERSION)
	gh release create $(VERSION) dist/*.zip dist/ros-help.db.gz --title "$(VERSION)" --generate-notes
	@echo "✓ Release $(VERSION) created"
endif
	@$(MAKE) --no-print-directory bump-version

# Bump patch version in package.json and commit.
# Called automatically after `make release`; can also run standalone.
bump-version:
	@CURRENT=$$(node -p "require('./package.json').version"); \
	IFS='.' read -r MAJOR MINOR PATCH <<< "$$CURRENT"; \
	NEXT="$$MAJOR.$$MINOR.$$((PATCH + 1))"; \
	node -e "const fs=require('fs'); const p=JSON.parse(fs.readFileSync('package.json','utf8')); p.version='$$NEXT'; fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"; \
	echo "✓ Bumped version: $$CURRENT → $$NEXT"; \
	git add package.json; \
	git commit -m "chore: bump version to $$NEXT for next release"; \
	git push origin main; \
	echo "✓ Version bump committed and pushed"

setup:
	bun install
	bun run src/setup.ts

clean:
	rm -f $(DB) $(DB)-shm $(DB)-wal
	rm -rf dist/
