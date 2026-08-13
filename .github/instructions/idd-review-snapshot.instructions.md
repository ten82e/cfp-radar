# IDD - Review Snapshot Phase (E1-E3)

The repository uses `reviewPolicy: no-advisory`. Build one complete review
snapshot for every current PR head; there is no advisory reviewer wait or
PATH B merge gate.

## E1 - Fetch review items

Fetch all review threads, review bodies, and regular PR comments for the
current HEAD. Exclude only trusted operational marker comments that match the
IDD marker grammar (`claimed-by`, `unclaimed-by`, `review-watermark`, status
digest, and similar). Keep untrusted marker-shaped comments in the activity
universe and report them as suspicious context.

Record the current HEAD SHA, highest activity timestamp, total item count,
and latest CI completion. Post a trusted same-claim `review-watermark` before
the pre-merge phases. If a previous watermark is missing, stale, or owned by
another claim, rebuild it rather than reusing it.

## E2 - Critique pass

Critique the complete snapshot against the issue acceptance criteria and the
repository rules. Treat human, CODEOWNER, required-reviewer, and any
decision-relevant automated comment as ordinary review feedback. Comments
that are clearly status/noise may be recorded as non-actionable, but must not
be hidden from the activity comparison.

## E3 - Empty list check

If the snapshot has no actionable items, continue to the branch-sync check
and then F1/F2. If actionable items exist, continue to
`idd-review-triage.instructions.md` E4.
