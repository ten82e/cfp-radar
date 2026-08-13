# IDD - Merge Execution Phase (F3-F5)

Read this file only after `idd-merge-handoff.instructions.md` routes the
current claim to the autonomous merge path. This repository uses
`fully_autonomous_merge` with `no-advisory`.

Before every mutating action, apply the shared claim revalidation gate in
`idd-overview-core.instructions.md#claim-revalidation-gate`.

## F3 - Merge

1. Confirm the active claim still belongs to the current `{claim-id}` and
   confirm `mergePolicy` is `fully_autonomous_merge`. Any missing, released,
   or competing claim stops the merge.
2. Re-fetch the full E1 activity universe and compare it with the carried F2
   snapshot. A changed HEAD, newer review/comment, changed item count, or
   newer CI completion routes back to E1. Keep the same trusted marker and
   claim checks used by F2.
3. Re-check branch state, required reviews, human `CHANGES_REQUESTED`,
   unresolved actionable threads, unreplied comments, and passing CI. The
   no-advisory profile has no Copilot/advisory state recheck.
4. Revalidate the claim immediately before the merge and bind the merge to
   the freshly fetched HEAD SHA:

   ```sh
   PR_HEAD_SHA_F3=$(gh pr view {pr-number} --json headRefOid --jq '.headRefOid')
   gh pr merge {pr-number} --merge --match-head-commit "$PR_HEAD_SHA_F3"
   ```

   Use the documented merge helper when available only as a read-only,
   fail-closed evidence collector; the written F1/F2 gates remain canonical.
   Never merge on a stale or unbound SHA, and never use squash/rebase here.

5. After a successful merge, update the digest with the merge commit and
   matched HEAD SHA, then continue to cleanup.

If GitHub rejects the merge, record the exact error and stop unless the
repository's documented solo-CODEOWNER admin fallback is fully satisfied.
Never use an admin bypass to skip CI, freshness, claim, review, or thread
gates.

## F4 - Cleanup

Run the imported post-merge cleanup workflow or its documented equivalent
only after F3 succeeds. Remove obsolete claim/digest markers according to
the cleanup rules, preserving the audit trail. There are no advisory-wait or
advisory-reroll markers to clean in this profile.

## F5 - Loop

After cleanup, return to `idd-discover.instructions.md` for the next eligible
roadmap issue. Do not start work without a fresh claim, and keep all actions
inside this repository.
