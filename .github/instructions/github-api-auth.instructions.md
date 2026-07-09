---
description: "GitHub API calls in this repo must be authenticated. Unauthenticated calls hit the 60 req/hr (or lower, unauthenticated raw.githubusercontent.com) limit fast and are the recurring cause of release/extraction failures."
applyTo: "src/github.ts, src/extract-skills.ts, src/restraml.ts, src/extract-*.ts, .github/workflows/release.yml"
---
# GitHub API calls must be authenticated

Any code that talks to `api.github.com` (or fetches repo file contents) must go through `fetchGitHub()` + `githubApiHeaders()` in `src/github.ts`, not a bare `fetch()`.

- Never call `raw.githubusercontent.com` — it's unauthenticated and rate-limited separately from the API. Use the Contents API (`/repos/{owner}/{repo}/contents/{path}?ref={sha}`) with `Accept: application/vnd.github.v3.raw` instead.
- CI steps that run extraction scripts hitting GitHub must set `GITHUB_TOKEN: ${{ github.token }}` in their `env:` block (see `release.yml`).
- Locally, `githubApiHeaders()` falls back to `GH_TOKEN` if `GITHUB_TOKEN` isn't set. Run local extraction with `GH_TOKEN=$(gh auth token) bun run src/extract-skills.ts` to avoid tripping the unauthenticated 60 req/hr limit.
- This isn't hypothetical: the unauthenticated limit was hit in production once the corpus (RouterOS versions + skill files) grew past ~50 GitHub API calls per release run. See PR #16.
