---
description: "republish_assets only reuploads GitHub Release assets and OCI tags. npm publication still requires a fresh package version."
applyTo: ".github/workflows/release.yml, MANUAL.md, README.md, CHANGELOG.md, package.json"
---
# `republish_assets` does not republish npm

The `republish_assets` workflow input is for GitHub Release assets and OCI tags only.

- npm versions are immutable.
- If a release needs a new npm package, bump `package.json` and publish a new version through the normal release flow.
- Keep docs explicit about this so operators do not expect npm to be overwritten.
