# Copilot instructions for rosetta

GitHub Copilot reads this file plus matching `.github/instructions/*.instructions.md` files. Keep this file short; put actual rules in the narrow instruction files.

## Project snapshot

- Bun + TypeScript, with Bun-native runtime APIs (`bun:sqlite`, `Bun.serve`, `bunx`).
- One core data model, exposed as MCP + browse TUI + glossary/command-tree surfaces.
- `CLAUDE.md` is now only the orientation + routing index. Rationale lives in `DESIGN.md`; operator/reference material lives in `MANUAL.md`.

## Routing map

- `CLAUDE.md` — project orientation and "where does this go?" index.
- `DESIGN.md` — durable rationale, data-source provenance, architecture tradeoffs.
- `MANUAL.md` — install, release/re-extraction operations, CLI/HTTP reference, schema.
- `tasks/README.md` / `briefings/README.md` — directory-local workflow rules.
- `.github/instructions/*.instructions.md` — narrow normative rules selected by `applyTo`.

## Start with these broad rules

- `where-does-this-go.instructions.md`
- `changelog-discipline.instructions.md`
- `capture-undone-work.instructions.md`
- `ci-pickup-verification.instructions.md`
- `instruction-scopes.instructions.md`

## Surface-specific rules

- MCP/query/TUI/canonicalizer → `mcp-server.instructions.md`
- Extraction/data-shape work → `extraction.instructions.md`
- Database init/schema internals → `database.instructions.md`

Prefer pointers over repetition. If you are about to add a long rule here, it probably belongs in a new scoped instruction file instead.
