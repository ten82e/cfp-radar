# IDD - Advisory Review Wait (Disabled)

This repository selects the `no-advisory` review policy in
`.github/idd/config.json`. IDD must not request, poll for, recover, or hold
on behalf of a Copilot or other advisory reviewer.

The file remains as an explicit no-op because the shared IDD documents link
to this phase. Human and required-reviewer feedback is still collected by
`idd-review-snapshot.instructions.md` and handled by the normal triage
rules. Merge readiness is gated by CI, branch state, required reviews that
are configured outside IDD, unresolved conversations, claim ownership, and
fresh review-watermark evidence.

If this repository later selects `copilot-advisory` or `external-bot`, restore
the corresponding upstream protocol from the imported IDD release and
update the review-policy record before enabling any wait behavior.
