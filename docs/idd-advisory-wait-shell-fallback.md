---
type: reference
title: IDD Advisory-Wait Shell Fallback (Disabled)
description: Retained link target for the no-advisory profile.
tags: [advisory-wait, disabled]
---

# IDD - Advisory-Wait Shell Fallback (Disabled)

The `no-advisory` profile does not request or wait for an advisory reviewer,
so the AW1-AW5 shell fallback is intentionally unused in this repository.
Do not run the commands from an older profile against a cfp-radar PR.

Human and required-reviewer feedback remains in the review snapshot, and the
CI, branch-state, claim, freshness, and unresolved-conversation gates remain
active.
