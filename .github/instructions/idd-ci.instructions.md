# IDD - CI Polling (Shared Helper)

This repository uses `reviewPolicy: no-advisory`. CI polling covers the
project's configured checks only; IDD must not add, request, or wait for an
advisory-review or `idd-advisory-convergence` check.

Callers define their own success route. Resolve timeouts and rerun policy
from `.github/idd/config.json` when present, otherwise use the distributed
defaults in `docs/policy-constants.md`.

## Required-check discovery

Use the profile-selected CI state helper when available. If it is missing,
fails, emits invalid JSON, or disagrees with live GitHub state, stop and use a
direct `gh pr checks`/Actions fetch rather than guessing.

- All required checks for the current HEAD must be generated and passing.
- If no required checks are configured, at least one present check run must
  exist and every present run must pass. No runs or any failing run holds.
- Pending or missing checks remain pending until the configured generation or
  running timeout. A timed-out infrastructure run follows the configured
  rerun policy once; a persistent failure is a hold.
- Code-caused failures return to the caller's fix/validate path. Do not
  bypass a failing check with an admin merge.

## Polling

Record the current HEAD before the first poll. On every poll, re-fetch HEAD;
if it changed, stop and return to the caller's fresh snapshot phase. Prefer a
synchronous `gh pr checks {pr-number} --watch --required` or the configured
state helper; background waits are allowed only when completion is guaranteed
to return to the same session.

After CI settles, return to the caller's documented phase. E15 and D4 always
return to E1 before merge so late review activity is not skipped.
