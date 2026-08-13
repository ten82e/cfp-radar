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

## Helper Runtime Profile

**Profile:** `instructions-only`

This repository does not vendor IDD helper scripts or add an IDD package to
`package.json`. Follow the Markdown and `gh`/`jq` fallbacks in the phase
instructions. Change the profile only when a helper package is deliberately
installed and verified.

## Freebuff 継続実行契約

Freebuff の Auto は、IDD の外側の作業を発明するための機能ではなく、
キューに入った IDD ターンを継続するためだけに使う。キューが空になった
ときの Discover は次の順序で行う。

1. `gh issue list --repo ten82e/cfp-radar --state open` で候補を取得する。
2. startable な Issue が無ければ「候補なし」で停止し、同じ調査を再実行しない。
3. Issue がある場合だけ `idd-discover` → `idd-claim` → 現在フェーズの指示へ進む。
4. `autonomous-research-loop` の再注入、Issue 外のビルド調査、Issue の自動作成は行わない。

`autonomous-research-loop` のスキル注入は無効のまま維持し、Auto のスコープは
Freebuff 側の設定を尊重する。open Issue が 0 件であることは正常な待機状態で
あり、キューを埋めるためのダミー作業を作らない。

## Verification evidence

- `.github/idd/config.json` selects `no-advisory` and
  `fully_autonomous_merge`.
- The local no-advisory patch removes E14/F2/F3 Copilot waits while retaining
  CI, claim, freshness, and unresolved-thread checks.
- The initial installation was imported directly to `main`; subsequent work
  follows Issue -> claim -> PR -> CI -> autonomous merge.
- `idd-onboard --verify` and `idd-doctor --json` passed with the
  `instructions-only` profile. The only warning was that branch-protection
  metadata for `ten82e/cfp-radar:main` was not readable.
- On 2026-08-13, Discover found 0 open Issues in `ten82e/cfp-radar`; the
  correct IDD/Freebuff state is therefore to stop at no-candidate Discover.
