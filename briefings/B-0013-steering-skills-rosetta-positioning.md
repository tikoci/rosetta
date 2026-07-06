---
id: B-0013-steering-skills-rosetta-positioning
topic: Where rosetta sits vs prompt steering, skills, and centrs now that the vendor manual is machine-readable
status: open
related_tasks:
  - T-0032-one-shot-cli-query
created: 2026-07-06
last_revisited: 2026-07-06
---

# Question

MikroTik's new manual publishes `llms.txt`, `llms-full.txt`, and per-page `.md`
(see B-0012). A well-crafted prompt or a SKILL.md can steer any web-capable
agent straight at those endpoints with zero install, while installing an MCP
server is non-trivial for many users. Does that make prompt/skill steering a
*better* fill for the "help agents with RouterOS" void than the rosetta MCP —
and should that change what the Docusaurus migration and the B-0011 tool-surface
cleanup build?

## What's grounding this

- `~/GitHub/bench-routeros-tools` `REPORT.md` + `docs/REPORT_LIVE.md` (structural
  metrics and live pilots, incl. the `vendordoc-steer` condition — literally the
  forum-post steering workflow — added as a 4th live rung).
- Forum thread [#270916](https://forum.mikrotik.com/t/steering-ai-to-use-new-manual-mikrotik-com/270916)
  ("Steering AI to use new manual.mikrotik.com"): the recommendation drafts in
  `drafts/forum-post1-recommendations.md` / `drafts/forum-post3-why.md`, and the
  post-#20 research where three coding agents built standalone lunr search CLIs
  against the site (findings folded into B-0012).
- Live measurements 2026-07-06: `llms.txt` = 112 KB (~28K tokens);
  CLI Reference page `.md` ≈ 1.6 KB, JSX-wrapped, no enums/package/version.
- [tikoci/centrs#150](https://github.com/tikoci/centrs/issues/150) — the
  browserbase-pattern onboarding decision: a repo-local hosted `SKILL.md` +
  copy-prompt button, centrs as guinea pig for exactly the
  "skill-as-distribution" idea argued here.
- [tikoci/centrs#90](https://github.com/tikoci/centrs/issues/90) — centrs as
  canonicalizer/`explain` owner; defines the rosetta/centrs boundary this
  briefing leans on.
- DESIGN.md → "External benchmark feedback loop" and "Where rosetta ends".

## The cost inversion

The intuition "tool calls are expensive, so a skill/prompt could fill the void
more cheaply" has the costs backwards. From the bench data plus the 2026-07-06
measurements:

| Cost | Steering / skill | rosetta MCP |
|------|------------------|-------------|
| Always-on (per session) | ~0 (prompt) / 1.1K tokens (skill frontmatter) | ~6.3K tokens (14 tool schemas) |
| Per query | fetch `llms.txt` (~28K tokens) + page fetch(es), multiple turns | one call (89% hit@5, 100% path reconstruction) |
| Install | zero | MCP config per client — the real adoption blocker |

MCP's genuine costs are the always-on schema block (attackable via B-0011
consolidation) and install friction (a *distribution* problem). Steering's
genuine cost is per-query tokens/turns — plus everything it structurally cannot
do: no version awareness (manual is `"current"` only), no structured pivots
(device/chip/spec queries), Porter-stemmed search that mangles `RB4011iGS+RM`,
no offline//app story, no deterministic retrieval evals.

## What the live pilots already showed

- `vendordoc-steer` fetches reliably (cited a real page 32/33 Haiku reps) and
  has the best fabrication discipline of any condition — **and still missed
  every device-truth trap**. Reading the vendor manual ≠ knowing device truth.
- Skills frontmatter routed only 53% of tasks to the right guide; skills are
  deep reference once selected, weak as a router.
- Raw rosetta snippets beat skill-file framing in the Claude pilot.
- Nothing offline (rosetta included) closes *removed-capability* or
  *silent-default* traps — only the run tier does.

## Current lean: a ladder, not a contest

Steering, skills, rosetta, and centrs are rungs differentiated by what the user
has installed and how much truth they need — each rung should advertise the next:

| Rung | What | Wins on | Structurally can't do |
|------|------|---------|-----------------------|
| 0 | Prompt steering (forum #270916 recommendations) | zero install; any browsing chat | per-query cost, versions, structure |
| 1 | Skill (`routeros-*`) | cheap, file-copy distribution, deep reference | routing (53%), silent version drift |
| 2 | rosetta | one-call efficiency, versions, structure, offline//app | live currency; install friction |
| 3 | centrs | device truth — the only tier closing removed-capability/silent-default traps | needs credentials/trust |

Consequences:

1. **Skills as distribution for rosetta's engine, not a replacement.** A
   one-shot CLI query mode (`bunx @tikoci/rosetta search "…" --json`) lets a
   plain SKILL.md invoke rosetta via shell with zero MCP config: the skill
   solves install friction, rosetta keeps retrieval quality, and always-on cost
   drops from 6.3K of schemas to a few hundred tokens of skill frontmatter.
   → T-0032. This is the same pattern centrs#150 is piloting from the other
   direction (hosted SKILL.md that onboards the tool mid-task); if both work,
   the "trilogy" meta-skill idea in #150 is the convergence point.
2. **rosetta results must be good steering targets.** Carrying live
   `manual.mikrotik.com/….md` URLs on every result (B-0012 reframe) lets any
   client escalate rung 2 → rung 0 for verification/currency instead of
   treating them as rivals.
3. **B-0011 gets its success criterion: always-on token cost.** Consolidate
   toward what steering can't replicate (versioned, structured, pivot,
   one-call); the fold candidates already listed there are where schema tokens
   buy the least unique capability.
4. **The rosetta/centrs `explain` boundary follows the tier line.** rosetta owns
   static, docs/schema-grounded explanation (tier 1, never touches a router);
   centrs owns canonicalization + anything device-aware (centrs#90 makes centrs
   the canonicalizer/explain owner). centrs should consume rosetta (DB or
   library) rather than duplicate doc retrieval; rosetta should not grow
   validate/run.

## Open questions

- Does the one-shot CLI mode need result-shape parity with MCP tools
  (V-tui-mcp-parity-style), or is a leaner "skill-sized" output shape better for
  the rung-1 consumer? (Leaner may actually serve the token argument.)
- Should the rung-1 skill live in `routeros-skills` (public, shippable) or start
  repo-local like centrs#150 and promote later? centrs#150's outcome is the
  natural trigger.
- When per-version manuals or structured CLI Reference data ship upstream
  (B-0012 asks), which rung-2 differentiators erode, and on what timeline?
