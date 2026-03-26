DB         := ros-help.db
HTML_DIR   := box/documents-export-2026-3-25/ROS
RESTRAML   := $(HOME)/restraml/docs

.PHONY: extract extract-html extract-properties extract-commands extract-all-versions link assess search serve lint test clean install

install:
	bun install

extract: extract-html extract-properties extract-commands link

extract-full: extract-html extract-properties extract-all-versions link

extract-html:
	bun run src/extract-html.ts

extract-properties:
	bun run src/extract-properties.ts

extract-commands:
	bun run src/extract-commands.ts

extract-all-versions:
	bun run src/extract-all-versions.ts $(RESTRAML)

link:
	bun run src/link-commands.ts

assess:
	bun run src/assess-html.ts

search:
	bun run src/search.ts $(query)

serve:
	bun run src/mcp.ts

lint:
	bunx @biomejs/biome check src/

test:
	bun test

clean:
	rm -f $(DB) $(DB)-shm $(DB)-wal
