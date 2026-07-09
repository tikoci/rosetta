---
description: "republish_assets only reuploads GitHub Release assets and OCI tags. npm publication still requires a fresh package version."
applyTo: ".github/workflows/release.yml, MANUAL.md, README.md, CHANGELOG.md, package.json"
---
# `republish_assets` does not republish npm

The `republish_assets` workflow input is for GitHub Release assets and OCI tags only.

- npm versions are immutable.
- If a release needs a new npm package, bump `package.json` and publish a new version through the normal release flow.
- Keep docs explicit about this so operators do not expect npm to be overwritten.
- For a prerelease (`alpha`/`beta`/`rc`) version, `republish_assets: true` also does not move any floating tag: no `npm dist-tag add`, and no floating OCI tag (`:latest`, `:alpha`/`:beta`/`:rc`, `:next`) gets re-pushed — only the exact-version and `sha-*` image tags are re-uploaded. `inputs.version` must carry the exact already-published run-numbered version (e.g. `v0.11.0-alpha.42`); CI cannot recompute a past run's `$GITHUB_RUN_NUMBER`.
