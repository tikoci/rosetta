---
id: B-0002-standalone-binaries-positioning
topic: How aggressively should we de-emphasize standalone compiled binaries?
status: open
related_tasks: []
created: 2026-05-02
last_revisited: 2026-05-02
---

# Question

Should README/MANUAL further de-emphasize the compiled binaries to reduce Gatekeeper/SmartScreen support burden?

# What's grounding this

- Compiled binaries are useful inside OCI images and as a no-runtime fallback.
- `bunx @tikoci/rosetta` is the primary local install path (no Gatekeeper/SmartScreen issues).
- Code signing is non-trivial; users hit OS warnings on first launch.

# Options

1. **Hide binaries from README** — keep them in MANUAL.md and Releases page only. Reduces casual download → friction loop.
2. **Strong "use bunx" recommendation up top** — keep binaries visible but lead with bunx in every install path.
3. **Keep current balance** — binaries stay first-class.

# Current lean

Option 2 — bunx-first, binaries below. Don't hide them; people legitimately want them for air-gapped or no-Bun environments.

# Open questions

- Are there real users running rosetta from a binary today? Telemetry-free project, so this is judgment.
- Would documenting a "right-click → Open" flow for first launch close most of the gap without removing binaries?
