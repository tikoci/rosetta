# Codex instructions for rosetta

Codex reads this file as the repo-local entrypoint. Keep it short. The canonical
project orientation remains `CLAUDE.md`; durable rationale lives in `DESIGN.md`;
operator/reference material lives in `MANUAL.md`; narrow normative rules live in
`.github/instructions/*.instructions.md`.

## First reads

- Read `CLAUDE.md` before non-trivial work. It is the routing index for the repo.
- Read `DESIGN.md` when touching retrieval, MCP/TUI behavior, data sources,
  extraction, skills, command validation, or Docusaurus migration work.
- Read `.github/copilot-instructions.md` as the peer short routing note for
  Copilot, but do not duplicate its rules here.
- Manually read the matching `.github/instructions/*.instructions.md` files.
  Codex does not get Copilot's `applyTo` selection automatically.
- Active work is tracked in GitHub Issues (`agent-ready` / `umbrella` / `blocked`
  labels); PRs close issues via `Closes #N` — read
  `.github/instructions/issue-pr-linking.instructions.md`. `tasks/` is a frozen
  archive (see `tasks/README.md`); briefing rules are in `briefings/README.md`.
- Repo-local skills live in `.github/skills/*/SKILL.md` (symlinked into
  `.claude/skills/` for Claude Code); read the relevant file when a user asks
  for that workflow, such as picking the next issue, promoting an idea,
  re-extracting, verifying acceptance criteria, or gating a PR's review
  threads before claiming it's mergeable.

## Development defaults

- Rosetta is Bun + TypeScript. Prefer `bun`, `bun test`, and `make verify` where
  applicable; do not swap in Node/npm-oriented substitutes.
- MCP, query, classifier, TUI, and canonicalizer behavior should route through
  shared core code, usually `src/query.ts`, with `src/mcp.ts` and `src/browse.ts`
  kept as thin adapters.
- Rosetta is read-only documentation/schema context. It does not connect to or
  modify a user's router.
- Community RouterOS skills are supplemental, not official MikroTik docs; keep
  the attribution boundary visible when they surface.

## MCP and client config

- Dev MCP config for Claude-style clients is in `.mcp.json`.
- VS Code Copilot MCP config is in `.vscode/mcp.json`.
- Public client setup snippets live in `README.md` and `src/setup.ts`, including
  the Codex command `codex mcp add rosetta -- bunx @tikoci/rosetta`.
- If setup output changes, keep the runtime snippets, README, and MANUAL aligned.
