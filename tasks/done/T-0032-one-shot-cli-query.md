---
id: T-0032-one-shot-cli-query
title: One-shot CLI query mode so a SKILL.md can drive rosetta without MCP config
status: done
priority: medium
area: install
depends_on: []
conflicts_with:
  - T-0026-tui-flag-passthrough
validation:
  - V-cli-flag-uniformity
  - V-tui-mcp-parity
acceptance:
  - "`bunx @tikoci/rosetta search \"<query>\" --json` runs one query, prints results, and exits 0 (no TUI, no MCP handshake)"
  - "Output routes through the same query core as the MCP tool (query-core-not-adapter); --json emits a machine-parseable shape, default emits compact human text"
  - "At least search and explain are reachable one-shot; flag names match the MCP/TUI equivalents"
  - "Works against the auto-fetched DB like other entrypoints (respects ROSETTA_OFFLINE per T-0018 when it lands)"
  - "MANUAL.md documents the mode with a skill/agent-invocation example"
trigger: ""
created: 2026-07-06
---

# Body

> **Closed 2026-07-10** — rolled into `briefings/B-0015-explain-static-live-trilogy.md` and umbrella [#27](https://github.com/tikoci/rosetta/issues/27) as part of the tasks→issues migration ([#18](https://github.com/tikoci/rosetta/issues/18)). centrs is the guinea-pig for the hosted-SKILL.md onboarding pattern (centrs#150); resurface as an issue when that lands.

B-0013 argues skills/prompt steering vs the rosetta MCP is a distribution
question, not an either/or: MCP's adoption blocker is per-client config, while
steering's cost is per-query tokens and lost structure. A one-shot CLI mode is
the bridge — a plain SKILL.md (or any agent with shell access) can call
`bunx @tikoci/rosetta search "wifi datapath" --json` with zero MCP setup,
keeping rosetta's retrieval quality at a few hundred tokens of always-on skill
frontmatter instead of ~6.3K of tool schemas.

Sketch: the TUI already parses commands and renders results; this is "run one
TUI command non-interactively and exit," plus a `--json` emitter over the query
core's structured results. Keep flag names aligned with MCP params and TUI
flags (T-0026) so the three surfaces stay learnable as one.

Open question from B-0013: whether `--json` should be full MCP result-shape
parity or a leaner skill-sized shape — decide during implementation, but the
shape must still come from the query core, not a parallel formatter.

Related: centrs#150 pilots the hosted-SKILL.md onboarding pattern this feeds;
the rung-1 skill itself is a `routeros-skills` (or repo-local) follow-up, not
part of this task.
