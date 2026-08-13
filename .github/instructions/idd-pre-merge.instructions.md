# IDD - Pre-Merge Conditions Phase (F1-F2)

This repository uses `reviewPolicy: no-advisory`. Never request or wait for
Copilot or another advisory reviewer in F1/F2. The merge gate still fails
closed on branch state, CI, required reviews configured outside IDD, review
freshness, unresolved conversations, and claim ownership.

Before every mutating action, apply the shared claim revalidation gate in
`idd-overview-core.instructions.md#claim-revalidation-gate`.

## F1 - Final branch-state check

Read the current PR state:

```sh
gh pr view {pr-number} --json mergeable,mergeStateStatus,headRefOid,baseRefName
git fetch --no-tags origin {base-branch}
```

Proceed only for a settled `MERGEABLE`/`CLEAN` state, or a behind,
conflict-free state when no up-to-date-head rule applies. A conflict,
unknown state, or an up-to-date-head violation routes back to the branch-sync
check in review triage. F1 is read-only.

## F2 - Pre-merge condition check

Verify every condition below against live GitHub state. If a condition is
unreadable or stale, stop and rebuild the E1 snapshot rather than guessing.

- **Claim:** the active issue claim still belongs to the current `{claim-id}`.
- **Review currency:** a trusted same-claim `review-watermark` covers the
  current PR HEAD, the latest activity timestamp, the item count, and the
  latest CI completion. Any newer review/comment or a changed HEAD routes to
  E1.
- **CI:** all required checks for the current HEAD pass. When no required
  checks are configured, at least one present run must exist and every
  present run must pass; no-run and failing-run states hold.
- **Required reviews:** all reviews required by branch protection or rulesets
  are present, including CODEOWNER approvals when configured.
- **Review state:** no human or required reviewer has an unaddressed
  `CHANGES_REQUESTED` state.
- **Threads:** no unresolved actionable review thread remains. An
  `awaiting-reviewer` thread may remain only when branch protection does not
  require conversation resolution; all other unresolved threads route to
  review triage.
- **Comments:** every non-agent regular comment has a later agent reply or
  is handled in review triage. Operational marker comments are excluded only
  when authored by a trusted marker actor and matching the marker grammar.

There is intentionally no advisory-wait, advisory-convergence, or
Copilot-specific gate in this profile. An external bot comment that contains
decision-relevant feedback is ordinary review activity and remains visible
to E1-E8; it does not create a separate wait window.

When a condition fails, update the PR digest with the evidence, blocker, and
next action before stopping. When every condition passes, carry the live
snapshot tuple (HEAD SHA, max activity timestamp, item count, latest CI
completion) unchanged to `idd-merge-handoff.instructions.md`.
