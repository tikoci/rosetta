---
id: B-0027-db-size-command-version-retention
topic: ros-help.db is 390 MB, 76% of it command_versions snapshots — prune to last-patch-per-minor and align retention with MikroTik channels
status: open
related_tasks: ["#91", "#237"]
created: 2026-10-29
last_revisited: 2026-10-29
---

# Question

The shipped `ros-help.db` is 390 MB. Where do the bytes go, how
redundant is the per-version command history, and what retention policy
gets the size down without losing `command_diff` / `command_versions`
as a capability? A parallel thread: should deep-inspect extraction
keep covering back to 7.20.8, or move to a channel-anchored window
(previous long-term → current)?

# What's grounding this

- `dbstat` census of the working-tree `ros-help.db` (built 2026-10-21,
  `release_tag v0.12.0-next.123`) on 2026-10-29, plus per-version
  `EXCEPT` diffs over `command_versions` (scratch SQL in shell history,
  nothing committed).
- Live channel check 2026-10-29: stable 7.25, long-term 7.23.8,
  testing 7.25, development 7.26beta4. The DB snapshot predates
  7.25 stable (latest stable in DB: 7.24.5; latest dev: 7.26beta3).
- Code: `src/extract-all-versions.ts` (per-version deep-inspect probe,
  no hardcoded floor), `src/extract-schema.ts` (`--accumulate` only
  touches presence + `command_versions`), `src/gc-versions.ts`
  (prunes presence only, leaves `command_versions` untouched),
  `src/query.ts` diff/version-check/browse consumers, and the
  `command_versions_expected` release gate.
- `DESIGN.md` "Coverage gap": CHR lacks Wi-Fi hardware, so
  `wifi-qcom`, `zerotier`, and arch-specific extras never appear in
  inspect output; manual-only overlay entries exist precisely because
  CHR `/console/inspect` cannot self-report hardware-gated menus.

# Findings: where the bytes go

| Area | MB | Share |
|---|---|---|
| command_versions + idx | 288 | 76% |
| schema_nodes + idx | 28 | 7% |
| Docs core | 16 | 4% |
| cliref_* | 14 | 4% |
| Videos + transcripts | 12 | 3% |
| commands + idx | 9 | 2% |
| FTS + rest | 9 | 2% |

`command_versions` is 2.45M rows across 64 versions. Each version is a
full snapshot of ~29k–44.7k complete path strings (avg 34 chars),
stored ~3 times: table 117 MB + text-PK autoindex 131 MB + version
index 40 MB.

# Findings: the snapshots are mostly redundant

- 25 of the consecutive same-minor pairs are byte-identical snapshots
  (e.g. 7.15 → 7.15.3, 7.23.2 → 7.23.8, 7.9 → 7.9.2).
- Most other patch diffs are under 70 paths out of ~40k. The only
  large patch jumps are +~1.2k at 7.20.8, 7.21.4, and 7.22.1 — all
  deep-inspect-era boundaries, i.e. arm64-union coverage appearing
  (#91), not real command additions.
- Deep-era (≥7.20.8) and legacy versions split the rows evenly:
  32 versions / 1.33M rows vs 32 versions / 1.12M rows.

# Findings: the deep-inspect floor is policy, not a constant

There is no `7.20.8` minimum in code. `extract-all-versions.ts`
HEAD-probes each restraml version for
`deep-inspect.{x86,arm64}.json` and falls back to legacy
`inspect.json`. 7.20.8 is simply the oldest version restraml has
deep-inspect files for.

Bumping that floor saves ~zero shipped MB, and the data shows why:
`schema_nodes` is rebuilt from the primary version only, and
`schema_node_presence` in the shipped DB holds just 2 versions
(7.24.5 + 7.26beta3 — post-GC channel heads). Every older
deep-inspect extraction is already discarded except its
`command_versions` snapshot (~4 MB), which legacy inspect.json
provides equally well. A floor bump pays off in extraction
time/network and restraml storage, not in shipped DB size.

# Options and what they do to the numbers

All MB figures assume linear scaling at ~117 bytes/row all-in.

- **P0 — do nothing.** DB stays 390 MB and grows ~4–5 MB per
  extracted version.
- **P1 — last patch per minor.** Keep 16 stable lasts (7.9.2 …
  7.24.5) + last prerelease per minor (7.22rc4, 7.25rc2, 7.26beta3):
  64 → 19 versions, 699k rows (28.5%).
  `command_versions` 288 → ~82 MB; DB 390 → ~184 MB.
- **P1 + floor at 7.19.** 9 versions, 368k rows (15%).
  `command_versions` → ~43 MB; DB → ~145 MB.
- **P2 — normalize, don't prune.** Integer `(command_id,
  version_id)` keys kill the 131 MB text-PK duplication: ~3x shrink
  of the table with zero data loss. Orthogonal to P1; composes with it.
- **P3 — deep-inspect window = prev-LT → current.** Extraction-side
  only (see above). Note the direction is undetermined until
  long-term history is checked: if previous-LT is older than 7.20.8,
  this *lowers* the floor.
- **P4 — channel-aligned end state (sketch).** Channel heads (stable,
  long-term, testing, development) at full fidelity + last-patch-per-minor
  snapshots below the window + P2 normalization. Unpriced; P1+P2
  compose to roughly DB ~120 MB.

Caveats that attach to any pruning option:

- `command_version_check` first-seen attribution collapses: a command
  added in 7.15 would report 7.15.3. Diff output is unaffected for
  dropped-identical snapshots.
- The `command_versions_expected` release gate (currently 64) and
  `gc-versions.ts`'s leave-`command_versions`-alone stance are both
  policy encoded as code; either must move with the decision.
- Old-release exactness is already lossy at the source (CHR-blind
  attributes, x86-only legacy snapshots, arch-blind union per #91),
  and its value decays as old releases accumulate unpatched
  vulnerabilities — precision about 7.10.3-vs-7.10.4 answers a
  question nobody should act on.

# Current lean

(Operator's, 2026-10-29 — recorded, not yet decided.)

Keep `command_diff` / `command_versions` as a capability, but retain
only the last patch per minor for old versions — the 7.10.3-vs-7.10.4
distinction is not worth 4 MB each. Move deep-inspect coverage to a
previous-long-term → current-long-term window, and over time align
retention with MikroTik's channel scheme while leaning less on
`/console/inspect` data whose CHR-blind gaps make historical
exactness partly illusory. Think more before cutting an issue.

# Open questions

- ~~What is the actual long-term lineage (which version preceded
  7.23.8)?~~ Answered 2026-10-29: operator calls 7.21.5 the previous
  long-term (most recent patch on the previous minor before current
  long-term 7.23.8, per the www changelog channel badges). No
  deep-inspect prune follows from this — merged deep-inspect already
  makes newer versions relatively bigger, so there is little room to
  save there. The lineage question exposed the real gap: neither
  rosetta nor restraml tracks channel membership at all (stored
  `channel` is filename-derived; 0 `long-term` rows) — filed as #237.
- Prerelease snapshots: last-beta/rc per minor, or only live channel
  heads (testing/development)? P1 keeps 7.22rc4/7.25rc2/7.26beta3;
  heads-only would drop the first two.
- DB snapshot (2026-10-21) predates 7.25 stable — re-ground the
  version list at extraction time, not from this briefing's census.
- Sequencing: prune first (cheap, lossy at the attribution margin)
  or normalize first (P2, lossless, more code)? They compose, but the
  order determines what the next release ships.
