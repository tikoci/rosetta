# syntax=docker/dockerfile:1
# Multi-stage: Bun cross-compiles on the build host (always amd64 in CI),
# runtime image is debian:bookworm-slim for the target platform.
#
# Bun supports cross-compilation via --target flag, so no QEMU needed.
# The DB is injected at release time (COPY ros-help.db /app/) — not baked
# into the base image to keep it cacheable and allow DB updates without rebuild.

FROM --platform=$BUILDPLATFORM oven/bun:1 AS builder
WORKDIR /build
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY src/ ./src/
ARG TARGETARCH
ARG VERSION=dev
ARG REPO_URL=tikoci/rosetta
RUN mkdir -p /out
RUN case "$TARGETARCH" in \
      amd64) bun_target=bun-linux-x64 ;; \
      arm64) bun_target=bun-linux-arm64 ;; \
      *) echo "Unsupported TARGETARCH: $TARGETARCH" && exit 1 ;; \
    esac && \
    bun build --compile --minify --bytecode --target="$bun_target" \
      --define VERSION="'\"${VERSION}\"'" \
      --define REPO_URL="'\"${REPO_URL}\"'" \
      --define IS_COMPILED='true' \
      src/mcp.ts --outfile /out/rosetta

FROM debian:bookworm-slim
WORKDIR /app
COPY --from=builder /out/rosetta /app/rosetta
COPY scripts/container-entrypoint.sh /entrypoint.sh
RUN chmod +x /app/rosetta /entrypoint.sh

# DB injected at release build time:
# COPY ros-help.db /app/ros-help.db

EXPOSE 8080
ENTRYPOINT ["/entrypoint.sh"]
