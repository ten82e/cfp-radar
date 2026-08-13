# IDD - Review Fix Phase (E9-E15)

Read this file after review triage identifies accepted human or required-
reviewer feedback. The repository uses `reviewPolicy: no-advisory`, so this
phase never requests or waits for Copilot or another advisory reviewer.

Apply the shared claim revalidation gate before every GitHub side effect:
`idd-overview-core.instructions.md#claim-revalidation-gate`.

## E9 - Fix accepted issues

Fix every accepted PATH A item, including the whole class of a systemic
finding. Run the configured `fix-validate` command and commit each logical
change atomically. Keep claims and issue scope bound to the current issue.

## E10 - Validate fixes

Run a critique pass after the fixes. If it finds another actionable issue,
fix it, validate again, and keep the work in the same bounded round. If the
same finding makes no meaningful progress for the configured guardrail,
post a hold with the evidence and stop for a maintainer decision.

## E11 - Resolve conflicts with main

Fetch `main` and merge it into the feature branch when the branch is
conflicted or stale. Resolve conflicts, run validation, and keep the merge
commit in the PR history. Do not rebase or force-push unless repository
policy explicitly requires it.

## E12 - Lint, test, push

Run the configured `post-fix-validate` command, re-check the active claim,
then push the feature branch. On failure, fix and validate before pushing.

## E13 - Reply to feedback

For each accepted human or required-reviewer item, reply with the commit SHA
and a short explanation. Resolve a review thread only after the reply is
successfully posted, subject to the configured thread-resolution policy.
Regular comments receive a reply but are not resolved. Update the status
digest with the current HEAD and claim evidence.

## E14 - No advisory review

This step is intentionally a no-op. Do not add reviewers, post
`advisory-wait` markers, poll Copilot state, run advisory recovery, or wait
for an advisory bot. Human/required-reviewer `CHANGES_REQUESTED` states are
still handled through E4-E13 and remain merge blockers when applicable.

## E15 - Wait for CI

Use `idd-ci.instructions.md` for CI polling and timing. After any CI outcome,
return to the review snapshot phase before proceeding to merge. On a
code-caused failure, fix and validate before returning to E11. On an
infrastructure failure, follow the configured rerun policy and hold rather
than bypassing a persistent failure.
