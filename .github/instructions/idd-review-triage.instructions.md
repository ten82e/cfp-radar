# IDD - Review Triage Phase (E4-E8)

This repository uses `reviewPolicy: no-advisory`. There is no advisory-only
PATH B workflow and no automatic reviewer request/wait. Keep all human and
required-reviewer feedback in scope; treat a decision-relevant automated
comment as ordinary actionable feedback.

## E4 - Classify and score

Classify each E1 item as actionable feedback, a duplicate, or non-actionable
status/noise. For actionable feedback, record severity and relevance. High
and Medium findings require a verified fix or an explicit maintainer
decision; ambiguous items default to actionable.

## E5 - Accept or reject

Verify each claim against the current code and issue before accepting or
rejecting it. Accepted items become the E9 work list. Record a concise reason
for every rejection and keep the source URL/ID in the digest.

## E6 - Reply and resolve

Reply to accepted or rejected human/required-reviewer feedback with the
decision and evidence. Resolve a review thread only after the reply succeeds
and only when the configured thread-resolution policy permits it. Regular
comments receive replies but are not resolved. A reviewer who reopens or
adds new information makes the item active again.

## E7 - Verify dispositions

Confirm every actionable item has a recorded decision, every accepted item
has a concrete fix direction, and every rejected item has a reason. Keep
unresolved reviewer threads and unreplied comments visible for F2; do not
declare convergence merely because an automated comment was ignored.

## E8 - Branch-sync and route

After accepted items are fixed, check whether `main` advanced or conflicts
exist. Merge `origin/main` into the feature branch when required, validate,
and re-run E1. If no accepted items and no sync is required, post/refresh the
trusted review-watermark and route to F1/F2.

Before every GitHub write, revalidate the active claim. On a hold, update the
digest with the blocker, evidence, and next action.
