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

The repository's [Security tab](https://github.com/tikoci/rosetta/security) is the live source of current alerts and advisories. This section describes the *configured* posture.

- **CodeQL** — not enabled. Planned: enable [Default Setup](https://github.com/tikoci/rosetta/settings/security_analysis) for `javascript-typescript` + `actions`, matching `tikoci/lsp-routeros-ts`.
- **Code Quality (AI findings, preview)** — not enabled. Planned to follow CodeQL.
- **Dependency review** — not enabled.
- **Dependabot security updates** — not enabled.
- **Secret scanning** — not enabled.
- **Private vulnerability reporting** — not enabled.

This repo is being brought up to the tikoci public-repo baseline; until that lands, this section reflects current truth rather than aspiration.

## Supported versions

| Version | Supported |
| --- | --- |
| latest | ✅ |
| older | ❌ |
