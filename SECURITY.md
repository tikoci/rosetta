# Security Policy

## Reporting a Vulnerability

Report privately via [GitHub Security Advisories](https://github.com/tikoci/rosetta/security/advisories/new). Do **not** open a public issue for an undisclosed vulnerability.

Please include a description of the issue, reproduction steps, and potential impact. Initial response within a few business days; we aim to release a fix within 30 days for confirmed vulnerabilities.

## Scope

rosetta is a **read-only documentation tool** — RouterOS docs as a SQLite FTS5 RAG, exposed via MCP. At runtime it:

- Opens a local SQLite database (read-only for MCP queries).
- Accepts MCP tool calls from connected LLM clients. All tool inputs to SQL go through bound parameters, never string interpolation. There is no shell execution in the runtime MCP server.
- Makes outbound HTTP requests only for `--setup` (downloading the DB from `https://github.com/tikoci/rosetta/releases/latest/download/ros-help.db.gz` over HTTPS, hardcoded URL) and `routeros_current_versions` (fetching version info from MikroTik's upgrade server).
- Binds to `localhost` by default when using `--http` transport. Network exposure (`--host 0.0.0.0`) logs a warning and should be paired with a reverse proxy or `--tls-cert`/`--tls-key`. Origin header validation is applied to mitigate DNS rebinding.
- Build scripts under `scripts/` and extractors under `src/extract-*.ts` are developer tooling, not distributed as part of the runtime package.

## Code scanning

The repository's [Security tab](https://github.com/tikoci/rosetta/security) is the live source of current alerts and advisories. This section describes *what* checks run and *why*, so the doc stays meaningful even when the badge is at 0.

- **CodeQL** — repo-managed workflow at [`.github/workflows/codeql.yml`](.github/workflows/codeql.yml) with config [`.github/codeql/codeql-config.yml`](.github/codeql/codeql-config.yml). Query suite: `security-and-quality` (security-extended + code-quality). Languages: `javascript-typescript`, `actions`. Schedule: push to `main`, pull requests to `main`, weekly cron. The repo-managed shape is used (rather than Default Setup like `tikoci/lsp-routeros-ts`) because rosetta carries large vendored/generated directories — `box/` (MikroTik HTML export), `dude/` (Wayback wiki cache), `transcripts/`, `matrix/`, `skills/`, `fixtures/` — that are listed in `paths-ignore` so scans stay focused on shipped/runtime TypeScript, extractors, the bin shim, release scripts, and workflow YAML. Test/eval harnesses are excluded because they are not shipped and produce noisy temp-file/file-race findings.
- **Code Quality (AI findings, preview)** — enabled. AI findings are noisy and self-contradicting; we accept the noise because the second-opinion catches real issues that the static suite misses. Steady-state goal is 0 open findings. False positives are dismissed via the GitHub UI with a written justification — that text is the audit-log contract. CI carries a forward-compatible probe step ("AI findings probe" in [`.github/workflows/test.yml`](.github/workflows/test.yml)) that polls candidate REST endpoints and prints a notice today; once GitHub ships a stable API the same step starts surfacing counts as warnings without ever blocking a PR. Note: AI findings are not currently readable via `gh` or the public web UI without authentication — they live behind the repo's `…/security/quality/ai-findings` view.
- **Dependency review** — [`.github/workflows/dependency-review.yml`](.github/workflows/dependency-review.yml), `fail-on-severity: high` on pull requests.
- **Dependabot version updates** — [`.github/dependabot.yml`](.github/dependabot.yml) for `github-actions` and `bun` ecosystems, weekly. Dependabot security updates are also enabled at the repo level.
- **Secret scanning** — enabled, with push protection.
- **Private vulnerability reporting** — enabled.

The `src/extract-*.ts` modules (HTML/JSON parsers fed by Confluence exports, MikroTik download server pages, and Wayback Machine snapshots) are dev-time ETL — they download and parse external content but do not run in the distributed MCP server. Both ETL and runtime code are scanned the same way; the distinction matters only when judging whether a finding affects shipped artifacts.

## Supported versions

| Version | Supported |
| --- | --- |
| latest | ✅ |
| older | ❌ |
