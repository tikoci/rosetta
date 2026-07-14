---
id: B-0004-inspect-coverage-gaps
topic: inspect.json / deep-inspect coverage gaps for non-CHR packages
status: resolved
related_tasks: []
created: 2026-05-02
last_revisited: 2026-07-14
---

> **2026-07-14 — superseded.** The coverage-gap problem here (CHR-only `inspect.json` missing
> Wi-Fi/LoRa/ZeroTier and other non-CHR packages) is now owned by the CLI-Reference overlay track:
> `briefings/B-0016-cli-reference-overlay-design.md` plus issues
> [#25](https://github.com/tikoci/rosetta/issues/25), [#33](https://github.com/tikoci/rosetta/issues/33),
> and umbrella [#28](https://github.com/tikoci/rosetta/issues/28). That track already treats
> CLI-Reference as a version-less overlay keyed by command path — the same "fill in commands CHR can't
> report" goal this briefing reached for, with a real ETL design behind it. Watch #25/#33/#28 instead of
> this briefing.

# Question

How should rosetta surface and mitigate gaps in `inspect.json` / `deep-inspect.json` coverage for Wi-Fi, LoRa, ZeroTier, and other non-CHR packages?

# What's grounding this

- CHR (used to generate inspect.json) has no Wi-Fi hardware → wireless driver packages absent.
- Some packages (`zerotier`, others) also missing.
- HTML docs do cover these subsystems.
- Deep-inspect arm64 files include `wifi-qcom` paths that inspect.json lacks — partial coverage from arch dimension.

# Options / next experiments

- Add tool-description or response notes where package coverage is known incomplete (cheap; transparent).
- Target high-value linking for missing Wi-Fi/LoRa/scripting docs (link page → command path even when command tree is empty).
- Extract package lists from RouterOS package documentation (build a "what packages exist" denominator).
- Coordinate with restraml on real-device inspect coverage for ARM 32-bit, MIPSBE/MMIPS, and wireless-driver packages (slow, depends on hardware availability).

# Current lean

Start with the cheap two: response-level notes + opportunistic page linking. Real-device coverage is a restraml-side project.

# Open questions

- Is there a clean signal to detect "command path missing because package not in inspect.json" vs "command path doesn't exist"? If yes, the warning is high-value; if no, it's noisy.

## Decision (2026-07-14)

Superseded — see note at top. The CLI-Reference overlay track already covers the "version-less doc site
fills in commands CHR can't report" goal, including the versionless-provenance caveat.

A **separate** concern surfaced while reviewing this briefing: `routeros_command_tree` needs work of its
own, independent of coverage gaps. It requires an exact REST-like path (e.g. `/ip/address/add/address`
for the `address` arg under `/ip/address/add`) and doesn't accept natural forms like `ip address`; its
shape is also bound tightly to `inspect.json`'s parts, some of which (e.g. `page_title`/`page_url`/
`dir_role`/`data_type`/`_arch`/`completion` all `null` in a typical row) may not carry their weight. This
is real but not scoped — logged as a loose thought in `BACKLOG.md` Inbox rather than expanding this
(closed) briefing.