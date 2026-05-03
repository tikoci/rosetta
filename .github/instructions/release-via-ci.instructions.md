---
description: "Published releases go through the GitHub Actions Release workflow. Do not document or rely on stale local release commands."
applyTo: ".github/workflows/release.yml, MANUAL.md, README.md, CHANGELOG.md, package.json, scripts/**, Dockerfile.release, server.json"
---
# Release via CI

The traceable release path is the GitHub Actions `Release` workflow (`workflow_dispatch`).

- Keep published-release docs aligned with the workflow, not with old local release commands.
- If release behavior changes, update the workflow docs in the same change.
- Local checks such as `make verify` exist for parity and debugging; they do not replace the release workflow as the publishing path.
