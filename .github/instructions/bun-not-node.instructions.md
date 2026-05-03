---
description: "Use Bun-native runtime and APIs. Do not paper over Bun requirements with Node-specific substitutes."
applyTo: "src/**, bin/**, scripts/**, package.json, tsconfig.json, bunfig.toml, .github/workflows/**"
---
# Bun, not Node

Rosetta is a Bun project.

- Use `bun:sqlite`, `Bun.serve`, and `bunx`.
- Do not swap in Node-oriented substitutes such as `better-sqlite3`, Express, or `npx`.
- Keep imports as ESM with `.ts` extensions in repo source.
- When documentation mentions local install or execution, prefer Bun-native commands.
