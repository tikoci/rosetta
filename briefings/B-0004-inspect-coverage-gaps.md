---
id: B-0004-inspect-coverage-gaps
topic: inspect.json / deep-inspect coverage gaps for non-CHR packages
status: open
related_tasks: []
created: 2026-05-02
last_revisited: 2026-05-02
---

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
