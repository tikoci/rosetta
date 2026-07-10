# tasks/ — archived

**This directory is a grep-able archive, not the work queue.** Active work is tracked in
[GitHub Issues](https://github.com/tikoci/rosetta/issues) — see the migration record in
issue [#18](https://github.com/tikoci/rosetta/issues/18) and the workflow rules in
`.github/instructions/where-does-this-go.instructions.md` and
`.github/instructions/issue-pr-linking.instructions.md`.

Do **not** create new `T-*.md` files.

## How the issue queue works (short version)

- A new work item is an **issue**. It starts as discussion — scoping, acceptance criteria,
  which umbrella/theme it belongs to.
- The **`agent-ready` label** means the spec is settled and an agent can pick it up and open
  a PR now. Readiness is a promotion earned in discussion, not a default set at creation.
- **`umbrella`** marks a tracking issue for a theme; work happens in linked child issues.
  **`blocked`** marks issues waiting on a named event or another issue.
- A PR that implements an issue says `Closes #N` in its body. Partial landings spawn
  follow-up issues *before* merge (see `issue-pr-linking.instructions.md`).
- Acceptance criteria on issues still reference `V-*` rows — `VALIDATION.md` remains the
  authoritative invariant matrix.

## What's in this directory

- `tasks/done/T-*.md` — every closed task from the file-based queue era (2026-04 → 2026-07).
  Files closed during the migration carry a `> **Closed 2026-07-10** — …` note at the top of
  the body stating the disposition: done, superseded, won't-fix, migrated to an issue, or
  folded into a briefing/umbrella. The frontmatter (`status: done` etc.) is frozen historical
  metadata.
- `T-0037-npm-prerelease-dist-tag-channel.md` — the **one exception**: still `in-progress`
  in place, finishing under the old scheme (its release-channel validation was mid-flight
  when the migration happened). Its PR closes it the old way; the file then moves to `done/`.

Keep the archive: task files are cited by `CHANGELOG.md` entries, briefings, and commit
messages, and several (e.g. `T-0038`) remain the full spec for the issue that replaced them.
