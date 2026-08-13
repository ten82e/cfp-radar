---
type: policy
title: cfp-radar IDD Policy
description: Repository-local decisions for the IDD installation.
tags: [idd, policy, cfp-radar]
---

# cfp-radar IDD Policy

- **Merge policy:** `fully_autonomous_merge`.
- **Review policy:** `no-advisory`.
- **Thread policy:** `fast-agent-resolve`, subject to branch-protection
  conversation rules.
- **Validation:** `npm ci`, then `npm run typecheck`, `npm run check`, and
  `npm test` before a PR can merge.
- **Branch protection evidence:** the installation check found no required
  status checks or required reviews configured on `main`. If protection is
  added later, IDD must honor it; this policy does not bypass it.
- **Scope:** IDD may operate only on this repository. Existing upstream
  no-contact rules in `AGENTS.md` remain in force.

The no-advisory profile deliberately removes Copilot request/wait/recovery
steps. Human or required-reviewer feedback that appears on a PR remains in
the review snapshot and can block the normal IDD gates.

## Verification evidence

- `.github/idd/config.json` selects `no-advisory` and
  `fully_autonomous_merge`.
- The local no-advisory patch removes E14/F2/F3 Copilot waits while retaining
  CI, claim, freshness, and unresolved-thread checks.
- The initial installation was imported directly to `main`; subsequent work
  follows Issue -> claim -> PR -> CI -> autonomous merge.
