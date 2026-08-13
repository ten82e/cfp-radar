# IDD - PR Submit Phase (D)

This repository uses `reviewPolicy: no-advisory`. Submit a PR with project CI
and any human/CODEOWNER reviewers required by repository settings; never
request Copilot, add an advisory reviewer, or introduce an
`idd-advisory-convergence` check.

Before D1, D2, D3, and every GitHub write, apply the shared claim
revalidation gate in `idd-overview-core.instructions.md#claim-revalidation-gate`.

## D1 - Sync main

Fetch `origin/main`. Before the first publication, rebase onto `origin/main`
only when the branch is behind. After publication, use merge-based sync from
`main`; do not force-push unless repository policy explicitly permits it.

## D2 - Validate and push

Confirm the issue claim still belongs to this session. Run the configured
`pre-push-validate` command, then push normally. On failure, run the
configured fix/validate path, commit atomically, and retry.

## D3 - Create PR

Create the PR with a concise summary, evidence, acceptance criteria, and a
plain-text `Closes #<issue>` line for the claimed issue. Verify GitHub's
`closingIssuesReferences` exactly matches the deliberate issue set. Request
only human/CODEOWNER reviewers that repository policy requires.

## D4 - Wait for CI

Use `idd-ci.instructions.md`. On success, continue to
`idd-review-snapshot.instructions.md` E1. On failure, follow the CI rerun or
hold policy; never treat absent CI as green.
