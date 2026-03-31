DB         := ros-help.db
HTML_DIR   := box/latest/ROS
VERSION    ?=
FORCE      ?=
IMAGE      ?= tikoci/rosetta
IMAGE_TAG  ?= latest
IMAGE_PLATFORMS ?= linux/amd64 linux/arm64
IMAGE_BUILD_DIR ?= .image-build
IMAGE_OUT_DIR ?= images
IMAGE_VERSION ?= $(if $(VERSION),$(VERSION),dev)

.PHONY: extract extract-full extract-html extract-properties extract-commands \
        extract-all-versions extract-devices extract-changelogs link assess search serve \
	typecheck lint test preflight build-release release \
	image-build image-build-platform image-push-registry image-publish \
        install setup clean

# ── Development ──

install:
	bun install

serve:
	bun run src/mcp.ts

search:
	bun run src/search.ts $(query)

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

extract: extract-html extract-properties extract-commands extract-devices extract-changelogs link

extract-full: extract-html extract-properties extract-all-versions extract-devices extract-changelogs link

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

extract-changelogs:
	bun run src/extract-changelogs.ts

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

# ── OCI image build/publish (crane, no Docker daemon) ──

image-build:
	@test -f $(DB) || (echo "✗ Database $(DB) not found. Build DB first (make extract)." && exit 1)
	@command -v crane >/dev/null 2>&1 || (echo "✗ crane is required (go install github.com/google/go-containerregistry/cmd/crane@latest)" && exit 1)
	@mkdir -p $(IMAGE_OUT_DIR)
	@for plat in $(IMAGE_PLATFORMS); do \
		echo "── Building OCI image for $$plat ──"; \
		$(MAKE) --no-print-directory image-build-platform IMAGE_PLATFORM=$$plat; \
	done
	@echo "✓ OCI image tars created in $(IMAGE_OUT_DIR)/"

image-build-platform:
	@test -n "$(IMAGE_PLATFORM)" || (echo "✗ IMAGE_PLATFORM is required (e.g. linux/amd64)" && exit 1)
	@case "$(IMAGE_PLATFORM)" in \
		linux/amd64) bun_target=bun-linux-x64; cfg_arch=amd64; ptag=linux-amd64 ;; \
		linux/arm64) bun_target=bun-linux-arm64; cfg_arch=arm64; ptag=linux-arm64 ;; \
		*) echo "✗ Unsupported IMAGE_PLATFORM: $(IMAGE_PLATFORM)"; echo "  Supported: linux/amd64 linux/arm64"; exit 1 ;; \
	 esac; \
	 work="$(IMAGE_BUILD_DIR)/$$ptag"; \
	 rootfs="$$work/rootfs"; \
	 image_dir="$$work/image"; \
	 rm -rf "$$work"; \
	 mkdir -p "$$rootfs" "$$image_dir" "$$rootfs/app" "$(IMAGE_OUT_DIR)"; \
	 crane export --platform "$(IMAGE_PLATFORM)" debian:bookworm-slim - | tar xf - -C "$$rootfs"; \
	 bun build --compile --minify --bytecode --target="$$bun_target" \
		--define VERSION="'\"$(IMAGE_VERSION)\"'" \
		--define REPO_URL="'\"tikoci/rosetta\"'" \
		--define IS_COMPILED='true' \
		src/mcp.ts --outfile "$$rootfs/app/rosetta"; \
	 install -m 0755 scripts/container-entrypoint.sh "$$rootfs/entrypoint.sh"; \
	 cp "$(DB)" "$$rootfs/app/ros-help.db"; \
	 (cd "$$rootfs" && tar cf - *) > "$$image_dir/layer.tar"; \
	 digest=$$( ( shasum -a 256 "$$image_dir/layer.tar" 2>/dev/null || sha256sum "$$image_dir/layer.tar" ) | cut -d' ' -f1 ); \
	 printf '{"architecture":"%s","os":"linux","config":{"WorkingDir":"/app","Cmd":["/entrypoint.sh"],"Env":["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]},"rootfs":{"type":"layers","diff_ids":["sha256:%s"]}}\n' "$$cfg_arch" "$$digest" > "$$image_dir/config.json"; \
	 printf '[{"Config":"config.json","RepoTags":["rosetta:local"],"Layers":["layer.tar"]}]\n' > "$$image_dir/manifest.json"; \
	 tar cf "$(IMAGE_OUT_DIR)/rosetta-$$ptag.tar" -C "$$image_dir" config.json manifest.json layer.tar; \
	 echo "✓ $(IMAGE_OUT_DIR)/rosetta-$$ptag.tar"

image-push-registry:
	@test -n "$(IMAGE)" || (echo "✗ IMAGE is required (e.g. ammo74/rosetta)" && exit 1)
	@test -n "$(IMAGE_TAG)" || (echo "✗ IMAGE_TAG is required (e.g. v0.2.0)" && exit 1)
	@command -v crane >/dev/null 2>&1 || (echo "✗ crane is required" && exit 1)
	@manifests=""; \
	 for plat in $(IMAGE_PLATFORMS); do \
		case "$$plat" in \
			linux/amd64) ptag=linux-amd64 ;; \
			linux/arm64) ptag=linux-arm64 ;; \
			*) echo "✗ Unsupported IMAGE_PLATFORM in IMAGE_PLATFORMS: $$plat"; exit 1 ;; \
		esac; \
		tar_file="$(IMAGE_OUT_DIR)/rosetta-$$ptag.tar"; \
		test -f "$$tar_file" || (echo "✗ Missing image tar: $$tar_file (run make image-build first)" && exit 1); \
		ref="$(IMAGE):$(IMAGE_TAG)-$$ptag"; \
		echo "Pushing $$tar_file -> $$ref"; \
		crane push "$$tar_file" "$$ref"; \
		manifests="$$manifests -m $$ref"; \
	 done; \
	 eval "crane index append -t \"$(IMAGE):$(IMAGE_TAG)\" $$manifests"; \
	 echo "✓ Published $(IMAGE):$(IMAGE_TAG)"

image-publish: image-build image-push-registry

setup:
	bun install
	bun run src/setup.ts

clean:
	rm -f $(DB) $(DB)-shm $(DB)-wal
	rm -rf dist/
