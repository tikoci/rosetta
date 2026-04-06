# Security Policy

## Scope

This is a **read-only documentation tool**. At runtime, rosetta:

- Opens a local SQLite database (read-only for MCP queries)
- Accepts MCP tool calls from connected LLM clients
- Makes outbound HTTP requests only for `--setup` (downloading the DB from GitHub Releases) and `routeros_current_versions` (fetching version info from MikroTik's upgrade server)
- Binds to `localhost` by default when using `--http` transport

Build scripts (`scripts/`) and extractors (`src/extract-*.ts`) are developer tooling and are not distributed as part of the runtime package.

## Supported Versions

We support the latest published version. Older releases are not patched.

| Version | Supported |
|---------| --------- |
| latest  | ✓         |
| < latest| ✗         |

## Reporting a Vulnerability

Please **do not** file a public GitHub issue for security vulnerabilities.

Report security issues via [GitHub Security Advisories](https://github.com/tikoci/rosetta/security/advisories/new).
Include a description of the issue, reproduction steps, and potential impact.

We will acknowledge reports within 5 business days and aim to release a fix within 30 days for confirmed vulnerabilities.

## Security Considerations

**MCP tool use:** rosetta is invoked by LLM agents via MCP. All tool inputs are parameterized SQL queries — user-supplied strings are passed as bound parameters, never interpolated into SQL strings. There is no shell execution in the runtime MCP server.

**HTTP transport (`--http`):** Defaults to `localhost` binding. Exposing to a network interface (`--host 0.0.0.0`) is at the operator's discretion and should be paired with a reverse proxy or `--tls-cert`/`--tls-key`. Origin header validation is applied to prevent DNS rebinding attacks.

**Database download:** The `--setup` flow fetches `ros-help.db.gz` from GitHub Releases over HTTPS with `redirect: follow`. The URL is hardcoded to `https://github.com/tikoci/rosetta/releases/latest/download/ros-help.db.gz`. No user-supplied URL is used.
