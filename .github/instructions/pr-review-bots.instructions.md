---
description: "How Copilot and CodeRabbit reviews manifest on a rosetta PR, why each looks different from a `gh` point of view, and what 'wrapping a PR' actually requires."
applyTo: "src/**, bin/**, scripts/**, .github/**, *.md, tasks/**, briefings/**"
---
# PR review bots (Copilot + CodeRabbit)

When a rosetta PR is marked **Ready for Review** (not while it is a draft), **two**
bots review it: `copilot-pull-request-reviewer` and `coderabbitai`. They surface
their findings through *different* GitHub mechanisms, so an agent that checks only
one signal will mis-read the state of the PR.

- **CodeRabbit is a status check, not a findings gate.** Its check turns **green when
  its review run finishes** — green means "CodeRabbit is done looking," **not** "your
  findings are addressed." Do not read a green CodeRabbit check as permission to merge.
  It re-reviews on demand via an `@coderabbitai review` PR comment.
- **Copilot is a requested reviewer.** Its review lands as state **`COMMENTED`**, never
  `CHANGES_REQUESTED`. So `gh pr view N --json reviewDecision` will **not** show it as
  blocking or pending the way a human "changes requested" review would — the findings
  are real but invisible to a decision-status check.
- **Bot reviews don't move `reviewDecision`, but unresolved threads DO block the merge.**
  `main` is branch-protected: **required status checks** (`test`, both CodeQL `Analyze`)
  plus **required conversation resolution**, with `enforce_admins: false` (an admin can
  still override the button, or merge via `gh`). Because both bots submit `COMMENTED`
  (never `CHANGES_REQUESTED`), `gh pr view N --json reviewDecision` stays clean — the
  block surfaces as `mergeStateStatus: BLOCKED`, driven by the **unresolved review
  threads**, not by a review decision. So `reviewDecision` is *not* the signal to watch;
  an open bot thread is. Resolving every thread (below) is what clears the gate.

## Wrapping a PR

Findings live in **inline review comments**, which `gh pr view` does not show. Read
them explicitly, then close the loop:

```sh
# All inline review comments (Copilot + CodeRabbit), path:line + body:
gh api repos/tikoci/rosetta/pulls/N/comments --jq '.[] | "\(.user.login) \(.path):\(.line)\n\(.body)\n"'
```

For each finding: fix it, or dismiss it with a grounded reason. **Replying to a thread
does not resolve it** — resolving is a separate, explicit action. You own bot threads
(Copilot/CodeRabbit) once the finding is handled; do not resolve a *human* reviewer's
thread on their behalf. List and resolve still-open threads:

```sh
# Still-unresolved threads:
gh api graphql -f query='query{repository(owner:"tikoci",name:"rosetta"){pullRequest(number:N){reviewThreads(first:50){nodes{id isResolved path line}}}}}' \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[]|select(.isResolved==false)|"\(.id)\t\(.path):\(.line)"'
# Resolve one (repeat per id):
gh api graphql -f query='mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}' -f id=THREAD_ID
```
