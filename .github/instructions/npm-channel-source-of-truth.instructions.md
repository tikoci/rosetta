---
description: "package.json's committed version is the sole signal for npm/OCI release channel (latest vs. alpha/beta/rc). Do not add a CI-side flag or input that duplicates it."
applyTo: ".github/workflows/release.yml, package.json, MANUAL.md, README.md"
---
# npm channel source of truth

`release.yml`'s "Determine npm release channel" step derives `latest` vs. `prerelease` (and the stage: `alpha`/`beta`/`rc`) entirely by parsing `package.json`'s committed `version` field.

- Do not add a `workflow_dispatch` input, environment variable, or other CI-side flag that also selects or overrides the channel — that would let the two signals disagree.
- A bare `MAJOR.MINOR.PATCH` version means `latest`. A `MAJOR.MINOR.PATCH-<stage>` or `-<stage>.N` version means prerelease, with `<stage>` validated against the `alpha`/`beta`/`rc` allowlist. Anything else fails the workflow loudly — never treat an unrecognized shape as `latest` by default.
- If a channel-adjacent input is genuinely needed later (e.g. limiting which registries get the floating tag), keep `package.json`'s version as the single source of truth for the channel decision itself, and layer the new input on top rather than replacing it.
