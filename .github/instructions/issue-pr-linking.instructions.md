---
description: "Every PR that implements an issue must auto-close it via 'Closes #N'; partial landings spawn follow-up issues before merge."
applyTo: "src/**, bin/**, scripts/**, .github/**, *.md, tasks/**, briefings/**"
---
# Issue ↔ PR linking

Work is tracked in GitHub Issues; PRs are how issues close. Two rules, both mandatory:

1. **Link to close.** A PR that implements an issue states `Closes #N` (or `Fixes #N`) in the
   PR **body** — not only in a comment or commit message — so the merge closes the issue
   automatically. One `Closes #N` line per issue the PR fully resolves. If a PR merely
   relates to an issue without finishing it, say `Part of #N` instead, which does *not*
   auto-close.

2. **Partial landings spawn follow-ups before merge.** If the PR delivers only part of the
   issue, do **not** leave the issue half-open-half-done. Before merging: open a follow-up
   issue for each undone remainder (carrying over the relevant acceptance bullets and `V-*`
   validation rows), reference the follow-ups from the PR body, and then it is fine to
   `Closes #N` the original. An issue should always be either fully delivered or explicitly
   split — never silently narrowed by what the PR happened to include.

Umbrella issues (`umbrella` label) are never closed by a PR directly — they close manually
when their child checklist is done. Check off the child in the umbrella body when the child
closes.
