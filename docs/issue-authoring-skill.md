# Issue Authoring Policy

This repository uses GitHub Issues as the source of truth for planned and
in-progress work. Obsidian notes are historical reference material only; new
work, progress, blockers, acceptance evidence, and completion links belong in
Issues and pull requests.

## When to author

Author an Issue only when a concrete repository task has been identified and
it is not already represented by an open or recently closed Issue. Before
creating one, search the full Issue history and reuse or extend a suitable
open Issue. Do not create placeholder, motivational, or "keep researching"
Issues.

A candidate must name:

- the repository surface to change;
- the observable outcome;
- objective acceptance checks; and
- any true dependency or human-only prerequisite.

If any of these is unknown, record the candidate as `needs-decision` in the
current session and stop. Do not publish a vague Issue.

## Authoring hold and release

New or materially revised Issues are created with the `status:authoring`
label. The label keeps incomplete drafts out of IDD Discover. A draft is not
eligible for claim until the release checklist passes and the operator
explicitly releases it by removing the label. In the repository's autonomous
mode, the release is performed by the same loop after the checklist passes;
the authoring label remains the audit boundary until that automated check is
complete. If publishing the label fails, close the newly created Issue and
report the failure.

The release checklist is:

1. no duplicate or superseded Issue exists;
2. the body has Background, Proposed change, and Acceptance criteria;
3. all acceptance checks are locally or CI verifiable;
4. dependencies are expressed as `Blocked by #NNN` only when they are real;
5. exactly one suitability footer is present and its score is at least 3; and
6. all referenced files and commands exist or are explicitly part of the task.

## Canonical ready-issue shape

```markdown
## Background

## Proposed change

## Acceptance criteria

- [ ] ...

## Candidate files

- `path/to/file`

---

_Autopilot suitability: 4 / 5 -- higher is more autopilot-suitable; below the configured floor is human-oriented._

<!-- kamiyobi-autopilot-suitability: 4 -->
```

Use a roadmap Issue with `## Goal`, `## Tracks`, and `## Success criteria`
when work needs multiple independent Issues or multiple sessions. Link every
child from the roadmap. Use a single orphan Issue for one bounded task.

## Duplicate and creation guard

Before publishing, run:

```sh
gh issue list --repo ten82e/kamiyobi --state all --limit 100
```

Compare title, body, changed surface, and recent Issues. Prefer extending an
open Issue; create a new Issue only when no existing Issue can absorb the
work. In one authoring session, create at most one new Issue unless a
roadmap package is explicitly required by the task's decomposition.

## IDD handoff

Issue authoring ends at the authoring hold. After the release checklist passes,
the repository's autonomous loop removes `status:authoring` and immediately
hands the Issue to IDD. Freebuff may then Discover, Claim, Work, submit a PR,
wait for CI, and merge under the repository policy. It must never replace an
empty queue with an unrelated research loop. If the checklist fails, keep the
hold (or add `status:needs-decision`) and stop rather than claiming the Issue.
